import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Test the response parsing logic used by GeminiClient with structured outputs.
// With responseMimeType: 'application/json', Gemini returns pure JSON — no regex needed.

function parseBlueprint(jsonText: string): any {
  return JSON.parse(jsonText);
}

function parseVerdict(jsonText: string): { verdict: 'PASS' | 'FAIL'; feedback: string } {
  const parsed = JSON.parse(jsonText);
  return {
    verdict: (parsed.verdict?.toUpperCase() === 'PASS' ? 'PASS' : 'FAIL') as 'PASS' | 'FAIL',
    feedback: parsed.feedback || 'No feedback provided.',
  };
}

describe('Blueprint JSON parsing (structured output)', () => {
  it('should parse a valid blueprint', () => {
    const text = '{"feature": "Auth", "tasks": []}';
    const result = parseBlueprint(text);
    assert.equal(result.feature, 'Auth');
    assert.deepEqual(result.tasks, []);
  });

  it('should parse blueprint with tasks', () => {
    const text = JSON.stringify({
      feature: 'API',
      tasks: [{ id: 'T001', title: 'Setup', description: 'Init', agent_role: 'coder', phase: 1 }],
    });
    const result = parseBlueprint(text);
    assert.equal(result.feature, 'API');
    assert.equal(result.tasks.length, 1);
    assert.equal(result.tasks[0].id, 'T001');
  });

  it('should throw on invalid JSON', () => {
    assert.throws(() => {
      parseBlueprint('not json');
    });
  });

  it('should handle empty tasks array', () => {
    const result = parseBlueprint('{"feature": "Empty", "tasks": []}');
    assert.equal(result.tasks.length, 0);
  });
});

describe('Verdict parsing (structured output)', () => {
  it('should parse PASS verdict', () => {
    const result = parseVerdict('{"verdict": "PASS", "feedback": "Code looks good."}');
    assert.equal(result.verdict, 'PASS');
    assert.equal(result.feedback, 'Code looks good.');
  });

  it('should parse FAIL verdict', () => {
    const result = parseVerdict('{"verdict": "FAIL", "feedback": "Missing error handling."}');
    assert.equal(result.verdict, 'FAIL');
    assert.equal(result.feedback, 'Missing error handling.');
  });

  it('should normalize case to uppercase', () => {
    const result = parseVerdict('{"verdict": "pass", "feedback": "All good"}');
    assert.equal(result.verdict, 'PASS');
  });

  it('should default to FAIL for unknown verdict', () => {
    const result = parseVerdict('{"verdict": "maybe", "feedback": "Uncertain"}');
    assert.equal(result.verdict, 'FAIL');
  });

  it('should provide default feedback when missing', () => {
    const result = parseVerdict('{"verdict": "PASS"}');
    assert.equal(result.feedback, 'No feedback provided.');
  });

  it('should handle multiline feedback', () => {
    const result = parseVerdict('{"verdict": "FAIL", "feedback": "Issue 1: no tests.\\nIssue 2: no docs."}');
    assert.equal(result.verdict, 'FAIL');
    assert.ok(result.feedback.includes('Issue 1'));
    assert.ok(result.feedback.includes('Issue 2'));
  });
});
