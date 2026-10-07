export interface AgyUsage {
  inputTokens: number;
  outputTokens: number;
  thinkingTokens?: number;
  cacheReadTokens?: number;
  totalTokens?: number;
}

export interface AgyInitEvent {
  kind: 'init';
  conversationId?: string;
  model?: string;
  cwd?: string;
  tools?: string[];
}

export interface AgyStepEvent {
  kind: 'step';
  conversationId?: string;
  stepIndex: number;
  state: string;
  stepType: string;
  textDelta?: string;
  durationSeconds?: number;
  usage?: AgyUsage;
}

export interface AgyResultEvent {
  kind: 'result';
  conversationId?: string;
  status: string;
  response: string;
  durationSeconds?: number;
  numTurns?: number;
  usage?: AgyUsage;
}

export interface AgyTextEvent {
  kind: 'text';
  text: string;
}

export type AgyEvent = AgyInitEvent | AgyStepEvent | AgyResultEvent | AgyTextEvent;

function mapUsage(raw: any): AgyUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const usage: AgyUsage = {
    inputTokens: raw.input_tokens ?? 0,
    outputTokens: raw.output_tokens ?? 0,
  };
  if (raw.thinking_tokens !== undefined) usage.thinkingTokens = raw.thinking_tokens;
  if (raw.cache_read_tokens !== undefined) usage.cacheReadTokens = raw.cache_read_tokens;
  if (raw.total_tokens !== undefined) usage.totalTokens = raw.total_tokens;
  return usage;
}

export function parseAgyEvent(line: string): AgyEvent {
  try {
    const parsed = JSON.parse(line);
    if (!parsed || typeof parsed !== 'object') {
      return { kind: 'text', text: line };
    }

    if (parsed.event === 'init') {
      const res: AgyInitEvent = {
        kind: 'init',
        conversationId: parsed.conversation_id,
      };
      if (parsed.init?.model !== undefined) res.model = parsed.init.model;
      if (parsed.init?.cwd !== undefined) res.cwd = parsed.init.cwd;
      if (parsed.init?.tools !== undefined) res.tools = parsed.init.tools;
      return res;
    }

    if (parsed.event === 'step_update' && parsed.step_update) {
      const su = parsed.step_update;
      const res: AgyStepEvent = {
        kind: 'step',
        conversationId: su.conversation_id,
        stepIndex: su.step_index,
        state: su.state,
        stepType: su.step_type,
      };
      if (su.text_delta !== undefined) res.textDelta = su.text_delta;
      if (su.duration_seconds !== undefined) res.durationSeconds = su.duration_seconds;
      const usage = mapUsage(su.usage);
      if (usage) res.usage = usage;
      return res;
    }

    if (parsed.event === 'result' && parsed.result) {
      const r = parsed.result;
      const res: AgyResultEvent = {
        kind: 'result',
        conversationId: r.conversation_id,
        status: r.status,
        response: r.response,
      };
      if (r.duration_seconds !== undefined) res.durationSeconds = r.duration_seconds;
      if (r.num_turns !== undefined) res.numTurns = r.num_turns;
      const usage = mapUsage(r.usage);
      if (usage) res.usage = usage;
      return res;
    }

    return { kind: 'text', text: line };
  } catch {
    return { kind: 'text', text: line };
  }
}

export class AgyStreamRelay {
  private emit: (line: string) => void;
  private onUsage?: (usage: { inputTokens: number; outputTokens: number }) => void;
  private usageReported = false;
  private pendingTextByStep: Map<number, string> = new Map();

  constructor(
    emit: (line: string) => void,
    onUsage?: (usage: { inputTokens: number; outputTokens: number }) => void
  ) {
    this.emit = emit;
    this.onUsage = onUsage;
  }

  push(line: string): void {
    const event = parseAgyEvent(line);
    if (event.kind === 'text') {
      this.emit(event.text);
      return;
    }

    if (event.kind === 'step') {
      if (event.stepType === 'agent_response') {
        const current = this.pendingTextByStep.get(event.stepIndex) ?? '';
        const updated = current + (event.textDelta ?? '');
        if (event.state === 'DONE') {
          this.pendingTextByStep.delete(event.stepIndex);
          this.emit(updated);
        } else {
          this.pendingTextByStep.set(event.stepIndex, updated);
        }
      } else {
        this.emit(`[agy] ${event.stepType} ${event.state}`);
      }
      return;
    }

    if (event.kind === 'result') {
      if (!this.usageReported && event.usage && this.onUsage) {
        this.usageReported = true;
        this.onUsage({
          inputTokens: event.usage.inputTokens,
          outputTokens: event.usage.outputTokens,
        });
      }
      const turns = event.numTurns ?? 0;
      const inTokens = event.usage?.inputTokens ?? 0;
      const outTokens = event.usage?.outputTokens ?? 0;
      this.emit(`[agy] result ${event.status} (${turns} turns, ${inTokens} in / ${outTokens} out)`);
      return;
    }
  }
}
