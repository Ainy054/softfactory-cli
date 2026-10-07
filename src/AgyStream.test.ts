import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseAgyEvent, AgyStreamRelay } from './AgyStream.js';

// Antigravity CLI emits one JSON object per line on stdout when run with
// `--output-format stream-json`. These tests pin the contract for
// src/AgyStream.ts: `parseAgyEvent(line)` turns a single raw line into a typed
// event, and `AgyStreamRelay` turns a stream of those lines into short,
// human-readable progress lines. The relay is fed one line at a time through
// `push(line)` and reports through the callback passed to its constructor.

const CONVERSATION_ID = '6aaf1111-2222-3333-4444-555566667777';

// The exact sample lines observed from a real Antigravity run.
const INIT_LINE = JSON.stringify({
  event: 'init',
  conversation_id: CONVERSATION_ID,
  init: { model: 'Gemini 3.7 Flash (High)', cwd: '/x', tools: ['ask_permission', 'read_file'] },
});

const STEP_USER_LINE = JSON.stringify({
  event: 'step_update',
  step_update: { conversation_id: CONVERSATION_ID, step_index: 0, state: 'DONE', step_type: 'user_input' },
});

const STEP_ACTIVE_LINE = JSON.stringify({
  event: 'step_update',
  step_update: { conversation_id: CONVERSATION_ID, step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'pong' },
});

const STEP_DONE_LINE = JSON.stringify({
  event: 'step_update',
  step_update: {
    conversation_id: CONVERSATION_ID,
    step_index: 1,
    state: 'DONE',
    step_type: 'agent_response',
    text_delta: '\n',
    duration_seconds: 2.97,
    usage: { input_tokens: 11878, output_tokens: 26, thinking_tokens: 25, cache_read_tokens: 0, total_tokens: 11904 },
  },
});

const RESULT_LINE = JSON.stringify({
  event: 'result',
  result: {
    conversation_id: CONVERSATION_ID,
    status: 'SUCCESS',
    response: 'pong\n',
    duration_seconds: 3.01,
    num_turns: 1,
    usage: { input_tokens: 11878, output_tokens: 26, thinking_tokens: 25, cache_read_tokens: 0, total_tokens: 11904 },
  },
});

const USAGE = { inputTokens: 11878, outputTokens: 26, thinkingTokens: 25, cacheReadTokens: 0, totalTokens: 11904 };

function collectingRelay(): { lines: string[]; relay: AgyStreamRelay } {
  const lines: string[] = [];
  const relay = new AgyStreamRelay(line => lines.push(line));
  return { lines, relay };
}

function agentResponseStep(stepIndex: number, state: string, textDelta?: string): string {
  return JSON.stringify({
    event: 'step_update',
    step_update: {
      conversation_id: CONVERSATION_ID,
      step_index: stepIndex,
      state,
      step_type: 'agent_response',
      ...(textDelta === undefined ? {} : { text_delta: textDelta }),
    },
  });
}

describe('parseAgyEvent', () => {
  it('parses the init line into a typed init event', () => {
    assert.deepEqual(parseAgyEvent(INIT_LINE), {
      kind: 'init',
      conversationId: CONVERSATION_ID,
      model: 'Gemini 3.7 Flash (High)',
      cwd: '/x',
      tools: ['ask_permission', 'read_file'],
    });
  });

  it('parses a step_update line into a typed step event', () => {
    assert.deepEqual(parseAgyEvent(STEP_USER_LINE), {
      kind: 'step',
      conversationId: CONVERSATION_ID,
      stepIndex: 0,
      state: 'DONE',
      stepType: 'user_input',
    });
  });

  it('keeps the text_delta of an active agent_response step', () => {
    assert.deepEqual(parseAgyEvent(STEP_ACTIVE_LINE), {
      kind: 'step',
      conversationId: CONVERSATION_ID,
      stepIndex: 1,
      state: 'ACTIVE',
      stepType: 'agent_response',
      textDelta: 'pong',
    });
  });

  it('keeps duration and usage on the done agent_response step', () => {
    assert.deepEqual(parseAgyEvent(STEP_DONE_LINE), {
      kind: 'step',
      conversationId: CONVERSATION_ID,
      stepIndex: 1,
      state: 'DONE',
      stepType: 'agent_response',
      textDelta: '\n',
      durationSeconds: 2.97,
      usage: USAGE,
    });
  });

  it('parses the result line with response text, status, turns and usage', () => {
    assert.deepEqual(parseAgyEvent(RESULT_LINE), {
      kind: 'result',
      conversationId: CONVERSATION_ID,
      status: 'SUCCESS',
      response: 'pong\n',
      durationSeconds: 3.01,
      numTurns: 1,
      usage: USAGE,
    });
  });

  it('treats an unknown step_type generically', () => {
    const toolLine = JSON.stringify({
      event: 'step_update',
      step_update: { conversation_id: CONVERSATION_ID, step_index: 2, state: 'ACTIVE', step_type: 'tool_call' },
    });
    assert.deepEqual(parseAgyEvent(toolLine), {
      kind: 'step',
      conversationId: CONVERSATION_ID,
      stepIndex: 2,
      state: 'ACTIVE',
      stepType: 'tool_call',
    });
  });

  it('passes a non-JSON line through unchanged', () => {
    const line = 'plain text from an older Antigravity build';
    assert.deepEqual(parseAgyEvent(line), { kind: 'text', text: line });
  });

  it('treats a malformed JSON line as text instead of throwing', () => {
    const malformed = '{"event":"init","conversation_id":';
    let event: ReturnType<typeof parseAgyEvent> | undefined;
    assert.doesNotThrow(() => { event = parseAgyEvent(malformed); });
    assert.deepEqual(event, { kind: 'text', text: malformed });
  });
});

describe('AgyStreamRelay', () => {
  it('relays a non-JSON line unchanged so nothing is lost', () => {
    const { lines, relay } = collectingRelay();
    relay.push('legacy plain-text output');
    assert.deepEqual(lines, ['legacy plain-text output']);
  });

  it('relays a malformed JSON line unchanged', () => {
    const { lines, relay } = collectingRelay();
    relay.push('{"event":"step_update"');
    assert.deepEqual(lines, ['{"event":"step_update"']);
  });

  it('accumulates agent_response text per step_index and emits once on DONE', () => {
    const { lines, relay } = collectingRelay();
    relay.push(agentResponseStep(1, 'ACTIVE', 'po'));
    relay.push(agentResponseStep(1, 'ACTIVE', 'ng'));
    // Never one line per text_delta: nothing is emitted while the step is active.
    assert.deepEqual(lines, []);
    relay.push(agentResponseStep(1, 'DONE', '\n'));
    assert.equal(lines.length, 1);
    assert.ok(lines[0].includes('pong'), `expected accumulated text in ${JSON.stringify(lines[0])}`);
  });

  it('keeps the accumulated text of distinct step_index values separate', () => {
    const { lines, relay } = collectingRelay();
    relay.push(agentResponseStep(1, 'ACTIVE', 'a'));
    relay.push(agentResponseStep(2, 'ACTIVE', 'x'));
    relay.push(agentResponseStep(1, 'DONE', 'b'));
    relay.push(agentResponseStep(2, 'DONE', 'y'));
    assert.equal(lines.length, 2);
    assert.ok(lines[0].includes('ab'), `expected step 1 text in ${JSON.stringify(lines[0])}`);
    assert.ok(lines[1].includes('xy'), `expected step 2 text in ${JSON.stringify(lines[1])}`);
  });

  it('relays any other step_type as "[agy] <step_type> <state>"', () => {
    const { lines, relay } = collectingRelay();
    relay.push(JSON.stringify({
      event: 'step_update',
      step_update: { conversation_id: CONVERSATION_ID, step_index: 0, state: 'DONE', step_type: 'user_input' },
    }));
    relay.push(JSON.stringify({
      event: 'step_update',
      step_update: { conversation_id: CONVERSATION_ID, step_index: 3, state: 'ACTIVE', step_type: 'tool_call' },
    }));
    assert.deepEqual(lines, ['[agy] user_input DONE', '[agy] tool_call ACTIVE']);
  });

  it('relays the final result once with status, turns and token usage', () => {
    const { lines, relay } = collectingRelay();
    relay.push(RESULT_LINE);
    assert.deepEqual(lines, ['[agy] result SUCCESS (1 turns, 11878 in / 26 out)']);
  });

  it('relays a non-SUCCESS result with its status and does not throw', () => {
    const { lines, relay } = collectingRelay();
    const failed = JSON.stringify({
      event: 'result',
      result: {
        conversation_id: CONVERSATION_ID,
        status: 'FAILURE',
        response: '',
        duration_seconds: 1.2,
        num_turns: 2,
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    });
    assert.doesNotThrow(() => relay.push(failed));
    assert.deepEqual(lines, ['[agy] result FAILURE (2 turns, 10 in / 5 out)']);
  });

  it('relays a full realistic run: the finished step text once and the result line', () => {
    const { lines, relay } = collectingRelay();
    for (const line of [INIT_LINE, STEP_USER_LINE, STEP_ACTIVE_LINE, STEP_DONE_LINE, RESULT_LINE]) {
      relay.push(line);
    }
    assert.ok(lines.includes('[agy] user_input DONE'), `missing user_input line in ${JSON.stringify(lines)}`);
    // The agent_response text is emitted exactly once, at DONE, not per delta.
    const textLines = lines.filter(l => l.includes('pong'));
    assert.equal(textLines.length, 1, `expected one agent_response line, got ${JSON.stringify(lines)}`);
    assert.ok(lines.includes('[agy] result SUCCESS (1 turns, 11878 in / 26 out)'), `missing result line in ${JSON.stringify(lines)}`);
  });

  it('invokes onUsage once when the result carries token usage', () => {
    const usages: Array<{ inputTokens: number; outputTokens: number }> = [];
    const relay = new AgyStreamRelay(() => {}, (u) => usages.push(u));
    // Step events with usage do not trigger onUsage
    relay.push(STEP_DONE_LINE);
    assert.equal(usages.length, 0);

    // Result event with usage triggers onUsage once
    relay.push(RESULT_LINE);
    assert.deepEqual(usages, [{ inputTokens: 11878, outputTokens: 26 }]);

    // Further result events do not trigger onUsage again
    relay.push(RESULT_LINE);
    assert.equal(usages.length, 1);
  });

  it('does not invoke onUsage when result has no token usage', () => {
    const usages: Array<{ inputTokens: number; outputTokens: number }> = [];
    const relay = new AgyStreamRelay(() => {}, (u) => usages.push(u));
    const noUsageResult = JSON.stringify({
      event: 'result',
      result: {
        conversation_id: CONVERSATION_ID,
        status: 'SUCCESS',
        response: 'done',
      },
    });
    relay.push(noUsageResult);
    assert.equal(usages.length, 0);
  });
});
