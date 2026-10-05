import { safeLocalContextWindow } from './TextModel.js';

/**
 * One tool-calling chat backend. The tool loop (ToolLoopWorker) is written
 * once against this interface; a transport only knows how to turn the loop's
 * canonical messages into its own wire format and back.
 */
export interface ToolCall {
  id: string;
  type: 'function';
  /** `arguments` is whatever the backend produced: an object, or a JSON string that may be malformed. */
  function: { name: string; arguments: unknown };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolDefinition {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  temperature: number;
  contextWindow: number;
  signal: AbortSignal;
}

export interface ChatReply {
  content: string;
  toolCalls: ToolCall[];
}

export interface Availability { reachable: boolean; modelPresent: boolean; installed: string[] }

export interface ChatTransport {
  /** Worker identity, surfaced in task state and the TUI. */
  readonly id: string;
  readonly name: string;
  /** Log-line prefix. */
  readonly label: string;
  /** How much tool output and file content one turn may carry. */
  readonly limits: { toolOutput: number; fileRead: number };
  contextWindow(model: string): number;
  timeoutMs(): number;
  checkAvailability(model?: string): Promise<Availability>;
  /** The message for a backend that cannot be reached at all (an environment fault). */
  unreachable(): string;
  /** The message for a reachable backend that does not have the model (a configuration fault). */
  missingModel(model: string, installed: string[]): string;
  chat(request: ChatRequest): Promise<ChatReply>;
}

export type ChatProvider = 'local' | 'deepseek' | 'openai-api' | 'anthropic';

const asObject = (args: unknown): Record<string, unknown> => {
  if (args && typeof args === 'object') return args as Record<string, unknown>;
  if (typeof args === 'string') { try { return JSON.parse(args); } catch { return {}; } }
  return {};
};
const asJsonString = (args: unknown): string => typeof args === 'string' ? args : JSON.stringify(args ?? {});

function workerTimeout(...envNames: string[]): number {
  for (const name of envNames) {
    const value = Number(process.env[name]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return 360000;
}

/** Ollama's native chat API. */
export class OllamaChatTransport implements ChatTransport {
  readonly id = 'local-agent';
  readonly name = 'Local Agent Worker (Ollama Tools)';
  readonly label = 'LocalAgent';
  readonly limits = { toolOutput: 6000, fileRead: 24000 };

  constructor(readonly host = 'http://127.0.0.1:11434', private readonly fetchImpl?: typeof fetch) {}

  private get fetch(): typeof fetch { return this.fetchImpl ?? globalThis.fetch; }

  contextWindow(model: string): number { return safeLocalContextWindow(model); }
  timeoutMs(): number { return workerTimeout('SOFTFACTORY_LOCAL_TIMEOUT_MS', 'SOFTFACTORY_WORKER_TIMEOUT_MS'); }

  /**
   * "Ollama is down" and "the model was never pulled" are different faults with
   * different fixes. Collapsing both into a false forces the caller to guess,
   * and the guess has historically been the wrong one.
   */
  async checkAvailability(model?: string): Promise<Availability> {
    try {
      const response = await this.fetch(`${this.host}/api/tags`, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) return { reachable: false, modelPresent: false, installed: [] };
      const data = await response.json() as any;
      const installed: string[] = (data.models || []).map((entry: any) => entry.name).filter(Boolean);
      return { reachable: true, modelPresent: !model || installed.includes(model) || installed.includes(`${model}:latest`), installed };
    } catch {
      return { reachable: false, modelPresent: false, installed: [] };
    }
  }

  unreachable(): string {
    return `Ollama is not reachable at ${this.host}. Start it (\`ollama serve\`, or launch the Ollama app) and resume. No task retry was consumed.`;
  }

  missingModel(model: string, installed: string[]): string {
    return `Ollama is running but the model "${model}" is not installed. Install it with: ollama pull ${model}. Installed models: ${installed.join(', ') || '(none)'}`;
  }

  async chat(request: ChatRequest): Promise<ChatReply> {
    const messages = request.messages.map(message => message.role === 'assistant'
      ? { role: 'assistant', content: message.content, ...(message.tool_calls?.length
          ? { tool_calls: message.tool_calls.map(call => ({ function: { name: call.function.name, arguments: asObject(call.function.arguments) } })) }
          : {}) }
      : { role: message.role, content: message.content });
    const response = await this.fetch(`${this.host}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: request.signal,
      body: JSON.stringify({ model: request.model, messages, tools: request.tools, stream: false, options: { temperature: request.temperature, num_ctx: request.contextWindow } }),
    });
    if (!response.ok) throw new Error(`Ollama API error: ${response.statusText}`);
    const data = await response.json() as any;
    const message = data.message || {};
    return {
      content: typeof message.content === 'string' ? message.content : '',
      toolCalls: (Array.isArray(message.tool_calls) ? message.tool_calls : []).map((call: any) => ({
        id: call.id || '', type: 'function' as const, function: { name: call.function?.name, arguments: call.function?.arguments ?? {} },
      })),
    };
  }
}

export interface OpenAiCompatibleConfig {
  id: string;
  name: string;
  label: string;
  chatUrl: string;
  modelsUrl: string;
  apiKeyEnv: string;
  contextWindow: number;
  timeoutEnv: string;
  /** Some model families reject a temperature parameter outright. */
  supportsTemperature?: (model: string) => boolean;
}

/** The OpenAI chat-completions protocol, used by DeepSeek and the OpenAI API itself. */
export class OpenAiCompatibleChatTransport implements ChatTransport {
  readonly id: string;
  readonly name: string;
  readonly label: string;
  readonly limits = { toolOutput: 8000, fileRead: 32000 };

  constructor(private readonly config: OpenAiCompatibleConfig, private readonly fetchImpl?: typeof fetch) {
    this.id = config.id;
    this.name = config.name;
    this.label = config.label;
  }

  private get fetch(): typeof fetch { return this.fetchImpl ?? globalThis.fetch; }
  private get apiKey(): string { return process.env[this.config.apiKeyEnv] || ''; }

  contextWindow(): number { return this.config.contextWindow; }
  timeoutMs(): number { return workerTimeout(this.config.timeoutEnv, 'SOFTFACTORY_WORKER_TIMEOUT_MS', 'SOFTFACTORY_LOCAL_TIMEOUT_MS'); }

  async checkAvailability(model?: string): Promise<Availability> {
    if (!this.apiKey) return { reachable: false, modelPresent: false, installed: [] };
    try {
      const response = await this.fetch(this.config.modelsUrl, { headers: { Authorization: `Bearer ${this.apiKey}` }, signal: AbortSignal.timeout(5000) });
      if (response.status === 401 || response.status === 403) return { reachable: false, modelPresent: false, installed: [] };
      if (!response.ok) return { reachable: true, modelPresent: false, installed: [] };
      const data = await response.json() as any;
      const installed: string[] = (data.data || []).map((entry: any) => entry.id).filter(Boolean);
      return { reachable: true, modelPresent: !model || installed.includes(model), installed };
    } catch {
      return { reachable: false, modelPresent: false, installed: [] };
    }
  }

  unreachable(): string {
    return `${this.label} API is not reachable, rejected the credentials, or ${this.config.apiKeyEnv} is not set.`;
  }

  missingModel(model: string, installed: string[]): string {
    return `${this.label} model "${model}" is not available for this API account. Available models: ${installed.join(', ') || '(none)'}`;
  }

  async chat(request: ChatRequest): Promise<ChatReply> {
    // An empty tool_calls array on a text-only turn is rejected by these
    // endpoints, and every tool message must answer a call by id.
    const messages = request.messages.map(message => {
      if (message.role === 'assistant') {
        return { role: 'assistant', content: message.content, ...(message.tool_calls?.length
          ? { tool_calls: message.tool_calls.map(call => ({ id: call.id, type: 'function', function: { name: call.function.name, arguments: asJsonString(call.function.arguments) } })) }
          : {}) };
      }
      if (message.role === 'tool') return { role: 'tool', tool_call_id: message.tool_call_id, content: message.content };
      return { role: message.role, content: message.content };
    });
    const temperature = (this.config.supportsTemperature ?? (() => true))(request.model) ? { temperature: request.temperature } : {};
    const response = await this.fetch(this.config.chatUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
      signal: request.signal,
      body: JSON.stringify({ model: request.model, messages, tools: request.tools, stream: false, ...temperature }),
    });
    if (!response.ok) throw new Error(`${this.label} API error: ${response.statusText} - ${await response.text()}`);
    const data = await response.json() as any;
    const message = data.choices?.[0]?.message || {};
    return {
      content: typeof message.content === 'string' ? message.content : '',
      toolCalls: (Array.isArray(message.tool_calls) ? message.tool_calls : []).map((call: any) => ({
        id: call.id || '', type: 'function' as const, function: { name: call.function?.name, arguments: call.function?.arguments ?? '{}' },
      })),
    };
  }
}

/** The Anthropic Messages API, with the loop's messages translated to content blocks. */
export class AnthropicChatTransport implements ChatTransport {
  readonly id = 'anthropic-cloud';
  readonly name = 'Anthropic Cloud Worker';
  readonly label = 'Anthropic';
  readonly limits = { toolOutput: 8000, fileRead: 32000 };
  private static readonly URL = 'https://api.anthropic.com/v1';

  constructor(private readonly fetchImpl?: typeof fetch) {}

  private get fetch(): typeof fetch { return this.fetchImpl ?? globalThis.fetch; }
  private get headers() {
    return { 'x-api-key': process.env.ANTHROPIC_API_KEY || '', 'anthropic-version': '2023-06-01', 'content-type': 'application/json' };
  }

  contextWindow(): number { return 200000; }
  timeoutMs(): number { return workerTimeout('SOFTFACTORY_ANTHROPIC_TIMEOUT_MS', 'SOFTFACTORY_WORKER_TIMEOUT_MS', 'SOFTFACTORY_LOCAL_TIMEOUT_MS'); }

  async checkAvailability(model?: string): Promise<Availability> {
    if (!process.env.ANTHROPIC_API_KEY) return { reachable: false, modelPresent: false, installed: [] };
    try {
      const response = await this.fetch(`${AnthropicChatTransport.URL}/models?limit=100`, { headers: this.headers, signal: AbortSignal.timeout(5000) });
      if (response.status === 401 || response.status === 403) return { reachable: false, modelPresent: false, installed: [] };
      // The listing is a convenience; a reachable API that will not list is still usable.
      if (!response.ok) return { reachable: true, modelPresent: true, installed: [] };
      const data = await response.json() as any;
      const installed: string[] = (data.data || []).map((entry: any) => entry.id).filter(Boolean);
      return { reachable: true, modelPresent: !model || installed.length === 0 || installed.includes(model), installed };
    } catch {
      return { reachable: false, modelPresent: false, installed: [] };
    }
  }

  unreachable(): string { return 'Anthropic API is not reachable, rejected the credentials, or ANTHROPIC_API_KEY is not set.'; }
  missingModel(model: string, installed: string[]): string {
    return `Anthropic model "${model}" is not available for this API account. Available models: ${installed.join(', ') || '(none)'}`;
  }

  /** System text goes in its own field; tool results are user-role blocks; same-role turns are merged. */
  static toAnthropic(messages: ChatMessage[]): { system: string; messages: Array<{ role: 'user' | 'assistant'; content: any[] }> } {
    const system: string[] = [];
    const out: Array<{ role: 'user' | 'assistant'; content: any[] }> = [];
    const push = (role: 'user' | 'assistant', blocks: any[]) => {
      const last = out[out.length - 1];
      if (last && last.role === role) last.content.push(...blocks);
      else out.push({ role, content: blocks });
    };
    for (const message of messages) {
      if (message.role === 'system') { system.push(message.content); continue; }
      if (message.role === 'user') { push('user', [{ type: 'text', text: message.content || '(continue)' }]); continue; }
      if (message.role === 'tool') { push('user', [{ type: 'tool_result', tool_use_id: message.tool_call_id, content: message.content || '(no output)' }]); continue; }
      const blocks: any[] = [];
      if (message.content) blocks.push({ type: 'text', text: message.content });
      for (const call of message.tool_calls || []) blocks.push({ type: 'tool_use', id: call.id, name: call.function.name, input: asObject(call.function.arguments) });
      if (blocks.length === 0) blocks.push({ type: 'text', text: '(no content)' });
      push('assistant', blocks);
    }
    return { system: system.join('\n\n'), messages: out };
  }

  async chat(request: ChatRequest): Promise<ChatReply> {
    const { system, messages } = AnthropicChatTransport.toAnthropic(request.messages);
    const tools = request.tools.map(tool => ({ name: tool.function.name, description: tool.function.description, input_schema: tool.function.parameters }));
    const response = await this.fetch(`${AnthropicChatTransport.URL}/messages`, {
      method: 'POST', headers: this.headers, signal: request.signal,
      body: JSON.stringify({ model: request.model, max_tokens: 16000, system, messages, tools, temperature: request.temperature }),
    });
    if (!response.ok) throw new Error(`Anthropic API error: ${response.statusText} - ${await response.text()}`);
    const data = await response.json() as any;
    const blocks: any[] = Array.isArray(data.content) ? data.content : [];
    return {
      content: blocks.filter(block => block.type === 'text').map(block => block.text).join(''),
      toolCalls: blocks.filter(block => block.type === 'tool_use').map(block => ({ id: block.id, type: 'function' as const, function: { name: block.name, arguments: block.input ?? {} } })),
    };
  }
}

export interface ChatTransportOptions { host?: string; fetchImpl?: typeof fetch }

/** The one place that maps a worker provider name to a chat transport. */
export function createChatTransport(provider: ChatProvider, options: ChatTransportOptions = {}): ChatTransport {
  switch (provider) {
    case 'local':
      return new OllamaChatTransport(options.host, options.fetchImpl);
    case 'deepseek':
      return new OpenAiCompatibleChatTransport({
        id: 'deepseek-cloud', name: 'DeepSeek Cloud Worker', label: 'DeepSeek',
        chatUrl: 'https://api.deepseek.com/v1/chat/completions', modelsUrl: 'https://api.deepseek.com/models',
        apiKeyEnv: 'DEEPSEEK_API_KEY', contextWindow: 64000, timeoutEnv: 'SOFTFACTORY_DEEPSEEK_TIMEOUT_MS',
      }, options.fetchImpl);
    case 'openai-api':
      return new OpenAiCompatibleChatTransport({
        id: 'openai-cloud', name: 'OpenAI Cloud Worker', label: 'OpenAI',
        chatUrl: 'https://api.openai.com/v1/chat/completions', modelsUrl: 'https://api.openai.com/v1/models',
        apiKeyEnv: 'OPENAI_API_KEY', contextWindow: 128000, timeoutEnv: 'SOFTFACTORY_OPENAI_TIMEOUT_MS',
        // Reasoning models reject any temperature but the default.
        supportsTemperature: model => !/^(o\d|gpt-5)/i.test(model),
      }, options.fetchImpl);
    case 'anthropic':
      return new AnthropicChatTransport(options.fetchImpl);
  }
}
