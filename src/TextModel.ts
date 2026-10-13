import { requestJson, HttpStatusError } from './HttpRetry.js';
import { execa } from 'execa';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkerEnvironmentError, argvText } from './IWorker.js';

export interface CompletionOptions {
  timeoutMs?: number;
  /** Ask the backend for a JSON object where it supports that natively. */
  json?: boolean;
  temperature?: number;
}

/**
 * One prompt in, one text out, for exactly one configured backend. The
 * inspector and the planners are built on this so that "which model reviewed
 * this diff" is always the answer the user configured, never a fallback.
 */
export interface ITextModel {
  readonly provider: string;
  readonly model: string;
  /** Tokens the backend can hold when it has a hard window (local models). */
  readonly contextWindow?: number;
  isAvailable(): Promise<boolean>;
  complete(prompt: string, options?: CompletionOptions): Promise<string>;
}

export const TEXT_MODEL_PROVIDERS = ['local', 'agy', 'openai', 'openai-api', 'anthropic', 'deepseek', 'qwen', 'openai-compat', 'claude-code', 'gemini-cli', 'muse'] as const;
export type TextModelProvider = typeof TEXT_MODEL_PROVIDERS[number];

/**
 * Whether a model listing covers a model id. Listings are advisory: DeepSeek
 * lists "deepseek-flash" and serves "deepseek-v4-flash", so a version segment
 * is ignored when matching, and an empty listing never blocks a run.
 */
export function modelListed(model: string, listed: string[]): boolean {
  if (!model || listed.length === 0) return true;
  const canon = (id: string) => id.toLowerCase().replace(/-v\d+(?:\.\d+)*(?=-|$)/g, '').replace(/:latest$/, '');
  return listed.includes(model) || listed.some(id => canon(id) === canon(model));
}

/** OpenAI-compatible endpoints configured by name: Qwen on DashScope, or anything behind SOFTFACTORY_COMPAT_BASE_URL. */
export interface CompatEndpoint { provider: TextModelProvider; label: string; baseUrl: string; apiKeyEnv: string; contextWindow: number; timeoutEnv: string }

export function compatEndpoint(provider: 'qwen' | 'openai-compat', env: NodeJS.ProcessEnv = process.env): CompatEndpoint {
  if (provider === 'qwen') {
    return {
      provider, label: 'Qwen', apiKeyEnv: 'DASHSCOPE_API_KEY', contextWindow: 128000, timeoutEnv: 'SOFTFACTORY_QWEN_TIMEOUT_MS',
      baseUrl: (env.DASHSCOPE_BASE_URL || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1').replace(/\/+$/, ''),
    };
  }
  return {
    provider, label: env.SOFTFACTORY_COMPAT_LABEL || 'Compat', apiKeyEnv: 'SOFTFACTORY_COMPAT_API_KEY', contextWindow: Number(env.SOFTFACTORY_COMPAT_CONTEXT) || 128000, timeoutEnv: 'SOFTFACTORY_COMPAT_TIMEOUT_MS',
    baseUrl: (env.SOFTFACTORY_COMPAT_BASE_URL || '').replace(/\/+$/, ''),
  };
}

/**
 * Size a local window against the host, not the model's name. A 14B at 8192
 * is ~10 GB resident: on a 16 GB machine that swaps and a single turn stops
 * completing at all. Keep that guard, scoped to machines that need it.
 */
export function safeLocalContextWindow(modelName: string): number {
  const configured = Number(process.env.SOFTFACTORY_LOCAL_NUM_CTX);
  if (Number.isFinite(configured) && configured >= 2048) return Math.floor(configured);
  const totalGb = os.totalmem() / 1024 ** 3;
  const isLargeModel = /(?:1[0-9]|[2-9][0-9])b\b/i.test(modelName);
  if (isLargeModel && totalGb < 32) return 4096;
  return 8192;
}

/** A model API call that survives a dropped connection; failures that remain are environment faults. */
async function modelRequest(fetchImpl: typeof fetch, url: string, init: RequestInit, timeoutMs: number, label: string): Promise<any> {
  try {
    return await requestJson(fetchImpl, url, init, { label, timeoutMs });
  } catch (error: any) {
    if (error instanceof HttpStatusError) throw new WorkerEnvironmentError(`${label} request failed: ${error.status} ${error.body.slice(0, 300)}`);
    throw new WorkerEnvironmentError(`${url} is not reachable: ${error?.message || 'fetch failed'}`);
  }
}

async function fetchWithTimeout(fetchImpl: typeof fetch, url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (error: any) {
    throw new WorkerEnvironmentError(`${url} is not reachable: ${error?.message || 'fetch failed'}`);
  } finally {
    clearTimeout(timer);
  }
}

export class OllamaTextModel implements ITextModel {
  readonly provider = 'local';
  readonly contextWindow: number;
  constructor(readonly model: string, private readonly host = 'http://127.0.0.1:11434', private readonly fetchImpl: typeof fetch = fetch) {
    this.contextWindow = safeLocalContextWindow(model);
  }

  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetchWithTimeout(this.fetchImpl, `${this.host}/api/tags`, {}, 5000);
      if (!response.ok) return false;
      const data = await response.json() as any;
      const installed: string[] = (data.models || []).map((entry: any) => entry.name).filter(Boolean);
      return installed.includes(this.model) || installed.includes(`${this.model}:latest`);
    } catch {
      return false;
    }
  }

  async complete(prompt: string, options: CompletionOptions = {}): Promise<string> {
    const response = await fetchWithTimeout(this.fetchImpl, `${this.host}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        prompt,
        stream: false,
        ...(options.json ? { format: 'json' } : {}),
        options: { temperature: options.temperature ?? 0.1, num_ctx: this.contextWindow },
      }),
    }, options.timeoutMs ?? 8 * 60_000);
    if (!response.ok) throw new WorkerEnvironmentError(`Ollama error for ${this.model}: ${response.status} ${response.statusText}`);
    const data = await response.json() as { response?: string };
    if (!data.response) throw new Error(`Ollama model ${this.model} returned an empty response.`);
    return data.response;
  }
}

/**
 * Antigravity's defaults: Gemini for every role. agy retired Gemini 3.1 Pro and
 * 3.7 Flash in October 2026, and its Claude models draw on a small separate
 * quota (a planning run exhausted it), so Gemini 3.8 Flash is both the worker
 * and the frontier model until agy offers a stronger Gemini.
 */
export const AGY_WORKER_MODEL = 'Gemini 3.8 Flash (High)';
export const AGY_FRONTIER_MODEL = 'Gemini 3.8 Flash (High)';

/**
 * agy's own words when it fails. Its stderr says what went wrong ("invalid
 * model selection ... Available models: ..."); execa's message starts with the
 * whole command line, so the reason was cut off behind the prompt.
 */
export function agyFailure(error: any): string {
  const said = String(error?.stderr || '').split('\n').map(line => line.trim()).filter(Boolean).join('; ');
  if (said) return said.slice(0, 600);
  return String(error?.shortMessage || error?.message || 'unknown error').replace(/\s--print\s[\s\S]*$/, ' --print <prompt>').slice(0, 300);
}

/**
 * The configured models agy does not offer, checked once against `agy models`
 * before a run starts. Null when every model is known, or when the list cannot
 * be read (an older agy without the subcommand never blocks a run).
 */
export async function agyModelProblem(models: string[], run: (args: string[]) => Promise<{ exitCode?: number; stdout: string }> = args => execa('agy', args, { timeout: 30_000, reject: false })): Promise<string | null> {
  const wanted = [...new Set(models.filter(Boolean))];
  if (!wanted.length) return null;
  const listed = await run(['models']).catch(() => undefined);
  if (!listed || listed.exitCode !== 0) return null;
  const known: Array<{ id: string; name: string }> = [];
  for (const line of listed.stdout.split('\n')) {
    const [id, name] = line.split('\t').map(part => part?.trim());
    if (id && name) known.push({ id, name });
  }
  if (!known.length) return null;
  const missing = wanted.filter(model => !known.some(k => k.name === model || k.id === model));
  if (!missing.length) return null;
  return `Antigravity has no model ${missing.map(m => `"${m}"`).join(', ')}. Available: ${known.map(k => k.name).join(', ')}. Choose with --planner-model, --cloud-model or --frontier-model.`;
}

export class AgyTextModel implements ITextModel {
  readonly provider = 'agy';
  constructor(readonly model: string) {}

  async isAvailable(): Promise<boolean> {
    try { await execa('agy', ['--help'], { timeout: 3000 }); return true; } catch { return false; }
  }

  async complete(prompt: string, options: CompletionOptions = {}): Promise<string> {
    let output: string;
    try {
      const { stdout, stderr } = await execa('agy', ['--dangerously-skip-permissions', '--model', this.model, '--print', argvText(prompt)],
        { timeout: options.timeoutMs ?? 300000 });
      output = (stdout || stderr || '').trim();
    } catch (error: any) {
      throw new WorkerEnvironmentError(`Antigravity CLI failed for ${this.model}: ${agyFailure(error)}`);
    }
    if (/quota reached|Individual quota/i.test(output)) throw new WorkerEnvironmentError(`Antigravity quota reached for ${this.model}.`);
    if (!output) throw new Error(`Antigravity returned no output for ${this.model}.`);
    return output;
  }
}

export class CodexTextModel implements ITextModel {
  readonly provider = 'openai';
  constructor(readonly model: string, private readonly cwd: string = process.cwd()) {}

  async isAvailable(): Promise<boolean> {
    try { await execa('codex', ['--help'], { timeout: 3000 }); return true; } catch { return false; }
  }

  async complete(prompt: string, options: CompletionOptions = {}): Promise<string> {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'softfactory-codex-'));
    const outputPath = path.join(tempDir, 'last-message.txt');
    try {
      await execa('codex', [
        'exec', '--sandbox', 'read-only', '--ephemeral', '--output-last-message', outputPath,
        ...(this.model ? ['--model', this.model] : []), argvText(prompt),
      ], { cwd: this.cwd, stdin: 'ignore', timeout: options.timeoutMs ?? 300000, all: true });
      return (await fs.readFile(outputPath, 'utf8')).trim();
    } catch (error: any) {
      if (error?.code === 'ENOENT') throw new Error('Codex CLI wrote no final message.');
      throw new WorkerEnvironmentError(`Codex CLI failed: ${(error?.shortMessage || error?.message || 'unknown error').slice(0, 300)}`);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
}

/** One prompt through Claude Code's print mode, with no tools: the agent as a plain model. */
export class ClaudeCodeTextModel implements ITextModel {
  readonly provider = 'claude-code';
  constructor(readonly model: string, private readonly cwd: string = process.cwd()) {}

  async isAvailable(): Promise<boolean> {
    try { await execa('claude', ['--version'], { timeout: 10000 }); return true; } catch { return false; }
  }

  async complete(prompt: string, options: CompletionOptions = {}): Promise<string> {
    let data: any;
    try {
      const { stdout } = await execa('claude', ['-p', argvText(prompt), '--output-format', 'json', '--bare', '--no-session-persistence', '--max-turns', '1', '--restricted', '--permission-mode', 'dontAsk', ...(this.model ? ['--model', this.model] : [])],
        { cwd: this.cwd, stdin: 'ignore', timeout: options.timeoutMs ?? 300000 });
      data = JSON.parse(stdout.slice(stdout.indexOf('{')));
    } catch (error: any) {
      throw new WorkerEnvironmentError(`Claude Code failed for ${this.model || 'its default model'}: ${(error?.shortMessage || error?.message || 'unknown error').slice(0, 300)}`);
    }
    const text = String(data.result ?? '').trim();
    if (data.is_error) throw new WorkerEnvironmentError(`Claude Code could not answer: ${text.slice(0, 300)}`);
    if (!text) throw new Error('Claude Code returned no text.');
    return text;
  }
}

/** One prompt through the Gemini CLI in non-interactive mode. */
export class GeminiCliTextModel implements ITextModel {
  readonly provider = 'gemini-cli';
  constructor(readonly model: string, private readonly cwd: string = process.cwd()) {}

  async isAvailable(): Promise<boolean> {
    try { await execa('gemini', ['--version'], { timeout: 10000 }); return true; } catch { return false; }
  }

  async complete(prompt: string, options: CompletionOptions = {}): Promise<string> {
    let data: any;
    try {
      const { stdout } = await execa('gemini', ['-p', argvText(prompt), '--output-format', 'json', '--approval-mode', 'default', ...(this.model ? ['-m', this.model] : [])],
        { cwd: this.cwd, stdin: 'ignore', timeout: options.timeoutMs ?? 300000 });
      data = JSON.parse(stdout.slice(stdout.indexOf('{')));
    } catch (error: any) {
      throw new WorkerEnvironmentError(`Gemini CLI failed for ${this.model || 'its default model'}: ${(error?.shortMessage || error?.message || 'unknown error').slice(0, 300)}`);
    }
    if (data.error) throw new WorkerEnvironmentError(`Gemini CLI could not answer: ${String(data.error.message || data.error).slice(0, 300)}`);
    const text = String(data.response ?? '').trim();
    if (!text) throw new Error('Gemini CLI returned no text.');
    return text;
  }
}

/** One prompt through Muse's headless mode with every tool off; the final text is the answer. */
export class MuseTextModel implements ITextModel {
  readonly provider = 'muse';
  constructor(readonly model: string, private readonly cwd: string = process.cwd()) {}

  async isAvailable(): Promise<boolean> {
    try { await execa('muse', ['--version'], { timeout: 10000 }); return true; } catch { return false; }
  }

  async complete(prompt: string, options: CompletionOptions = {}): Promise<string> {
    let stdout: string;
    try {
      ({ stdout } = await execa('muse', ['exec', '--json', '--no-session-log', '--disable-web-tools', '--disable-shell', '--disable-write', '--approval-mode', 'never', '--max-model-steps', '1', ...(this.model ? ['--model', this.model] : []), argvText(prompt)],
        { cwd: this.cwd, stdin: 'ignore', timeout: options.timeoutMs ?? 300000 }));
    } catch (error: any) {
      throw new WorkerEnvironmentError(`Muse failed for ${this.model || 'its default model'}: ${(error?.shortMessage || error?.message || 'unknown error').slice(0, 300)}`);
    }
    let text = '';
    let terminal = '';
    for (const line of stdout.split('\n')) {
      if (!line.trim().startsWith('{')) continue;
      try {
        const event = JSON.parse(line);
        if (typeof event.payload_type === 'string' && event.payload_type.startsWith('run.terminal.')) {
          terminal = event.payload?.terminal || event.payload_type.slice('run.terminal.'.length);
          text = String(event.payload?.text ?? event.payload?.reason ?? '').trim();
        }
      } catch { /* not an event line */ }
    }
    if (terminal && terminal !== 'completed') throw new WorkerEnvironmentError(`Muse run ${terminal}: ${text.slice(0, 300)}`);
    if (!text) throw new Error('Muse returned no text.');
    return text;
  }
}

export class OpenAiTextModel implements ITextModel {
  readonly provider = 'openai-api';
  constructor(readonly model: string, private readonly fetchImpl: typeof fetch = fetch) {}

  async isAvailable(): Promise<boolean> { return Boolean(process.env.OPENAI_API_KEY); }

  async complete(prompt: string, options: CompletionOptions = {}): Promise<string> {
    const data: any = await modelRequest(this.fetchImpl, 'https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY || ''}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, input: prompt, store: false }),
    }, options.timeoutMs ?? 300000, 'OpenAI');
    const text = data.output_text || data.output?.flatMap((item: any) => item.content || []).map((part: any) => part.text || '').join('') || '';
    if (!text) throw new Error(`OpenAI model ${this.model} returned no text.`);
    return text;
  }
}

export class AnthropicTextModel implements ITextModel {
  readonly provider = 'anthropic';
  constructor(readonly model: string, private readonly fetchImpl: typeof fetch = fetch) {}

  async isAvailable(): Promise<boolean> { return Boolean(process.env.ANTHROPIC_API_KEY); }

  async complete(prompt: string, options: CompletionOptions = {}): Promise<string> {
    const data: any = await modelRequest(this.fetchImpl, 'https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY || '', 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.model, max_tokens: 8000, messages: [{ role: 'user', content: prompt }] }),
    }, options.timeoutMs ?? 300000, 'Anthropic');
    const text = (data.content || []).filter((part: any) => part.type === 'text').map((part: any) => part.text).join('');
    if (!text) throw new Error(`Anthropic model ${this.model} returned no text.`);
    return text;
  }
}

/** Any OpenAI chat-completions endpoint as a text model. */
export class OpenAiCompatibleTextModel implements ITextModel {
  readonly provider: TextModelProvider;
  constructor(readonly model: string, private readonly endpoint: CompatEndpoint, private readonly fetchImpl: typeof fetch = fetch) {
    this.provider = endpoint.provider;
  }

  private get apiKey(): string { return process.env[this.endpoint.apiKeyEnv] || ''; }

  async isAvailable(): Promise<boolean> {
    if (!this.apiKey || !this.endpoint.baseUrl) return false;
    try {
      const response = await fetchWithTimeout(this.fetchImpl, `${this.endpoint.baseUrl}/models`, { headers: { Authorization: `Bearer ${this.apiKey}` } }, 8000);
      if (response.status === 401 || response.status === 403) return false;
      if (!response.ok) return true;
      const data = await response.json() as any;
      return modelListed(this.model, (data.data || []).map((entry: any) => entry.id).filter(Boolean));
    } catch {
      return false;
    }
  }

  async complete(prompt: string, options: CompletionOptions = {}): Promise<string> {
    if (!this.endpoint.baseUrl) throw new WorkerEnvironmentError(`${this.endpoint.label}: no base URL configured (set SOFTFACTORY_COMPAT_BASE_URL).`);
    if (!this.apiKey) throw new WorkerEnvironmentError(`${this.endpoint.apiKeyEnv} is not set.`);
    const data: any = await modelRequest(this.fetchImpl, `${this.endpoint.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
      // No response_format: not every compatible endpoint accepts it, and the callers parse JSON out of text anyway.
      body: JSON.stringify({ model: this.model, messages: [{ role: 'user', content: prompt }], stream: false, temperature: options.temperature ?? 0.1 }),
    }, options.timeoutMs ?? 8 * 60_000, this.endpoint.label);
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error(`${this.endpoint.label} model ${this.model} returned an empty response.`);
    return content;
  }
}

export class DeepSeekTextModel implements ITextModel {
  readonly provider = 'deepseek';
  constructor(readonly model: string, private readonly fetchImpl: typeof fetch = fetch) {}

  async isAvailable(): Promise<boolean> {
    const apiKey = process.env.DEEPSEEK_API_KEY || '';
    if (!apiKey) return false;
    try {
      const response = await fetchWithTimeout(this.fetchImpl, 'https://api.deepseek.com/models', { headers: { Authorization: `Bearer ${apiKey}` } }, 5000);
      if (!response.ok) return false;
      const data = await response.json() as any;
      return modelListed(this.model, (data.data || []).map((entry: any) => entry.id).filter(Boolean));
    } catch {
      return false;
    }
  }

  async complete(prompt: string, options: CompletionOptions = {}): Promise<string> {
    if (!process.env.DEEPSEEK_API_KEY) throw new WorkerEnvironmentError('DEEPSEEK_API_KEY is not set.');
    const data: any = await modelRequest(this.fetchImpl, 'https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
        temperature: options.temperature ?? 0.1,
        ...(options.json ? { response_format: { type: 'json_object' } } : {}),
      }),
    }, options.timeoutMs ?? 8 * 60_000, 'DeepSeek');
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error(`DeepSeek model ${this.model} returned an empty response.`);
    if (data.choices?.[0]?.finish_reason === 'length') throw new Error(`DeepSeek model ${this.model} reply was cut off at the output limit (${content.length} characters).`);
    return content;
  }
}

export interface TextModelOptions {
  host?: string;
  cwd?: string;
  fetchImpl?: typeof fetch;
}

/** The one place that maps a provider name to a transport. */
export function createTextModel(provider: TextModelProvider, model: string, options: TextModelOptions = {}): ITextModel {
  switch (provider) {
    case 'local': return new OllamaTextModel(model, options.host, options.fetchImpl);
    case 'agy': return new AgyTextModel(model);
    case 'openai': return new CodexTextModel(model, options.cwd);
    case 'openai-api': return new OpenAiTextModel(model, options.fetchImpl);
    case 'anthropic': return new AnthropicTextModel(model, options.fetchImpl);
    case 'deepseek': return new DeepSeekTextModel(model, options.fetchImpl);
    case 'qwen':
    case 'openai-compat': return new OpenAiCompatibleTextModel(model, compatEndpoint(provider), options.fetchImpl);
    case 'claude-code': return new ClaudeCodeTextModel(model, options.cwd);
    case 'gemini-cli': return new GeminiCliTextModel(model, options.cwd);
    case 'muse': return new MuseTextModel(model, options.cwd);
  }
}
