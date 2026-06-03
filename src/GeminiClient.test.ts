import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Test the response parsing logic extracted from GeminiClient

function extractJson(text: string): any {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Failed to parse JSON from Gemini response');
  return JSON.parse(jsonMatch[0]);
}

function parseVerdict(text: string): { verdict: 'PASS' | 'FAIL'; feedback: string } {
  const verdictMatch = text.match(/VERDICT:\s*(PASS|FAIL)/i);
  const feedbackMatch = text.match(/FEEDBACK:\s*([\s\S]*)/i);
  return {
    verdict: (verdictMatch?.[1].toUpperCase() as 'PASS' | 'FAIL') || 'FAIL',
    feedback: feedbackMatch?.[1].trim() || 'No feedback provided.',
  };
}

describe('Blueprint JSON extraction', () => {
  it('should extract JSON from plain response', () => {
    const text = '{"feature": "Auth", "tasks": []}';
    const result = extractJson(text);
    assert.equal(result.feature, 'Auth');
  });

  it('should extract JSON from markdown code block', () => {
    const text = 'Here is the plan:\n```json\n{"feature": "Auth", "tasks": []}\n```';
    const result = extractJson(text);
    assert.equal(result.feature, 'Auth');
  });

  it('should extract JSON with surrounding text', () => {
    const text = 'Based on analysis, here is the blueprint:\n\n{"feature": "API", "tasks": [{"id": "T001"}]}\n\nLet me know if changes are needed.';
    const result = extractJson(text);
    assert.equal(result.feature, 'API');
    assert.equal(result.tasks.length, 1);
  });

  it('should throw on response with no JSON', () => {
    assert.throws(() => {
      extractJson('No JSON here, just text.');
    }, /Failed to parse JSON/);
  });

  it('should throw on invalid JSON', () => {
    assert.throws(() => {
      extractJson('{invalid json}');
    });
  });
});

describe('Verdict parsing', () => {
  it('should parse PASS verdict', () => {
    const result = parseVerdict('VERDICT: PASS\nFEEDBACK: Code looks good.');
    assert.equal(result.verdict, 'PASS');
    assert.equal(result.feedback, 'Code looks good.');
  });

  it('should parse FAIL verdict', () => {
    const result = parseVerdict('VERDICT: FAIL\nFEEDBACK: Missing error handling.');
    assert.equal(result.verdict, 'FAIL');
    assert.equal(result.feedback, 'Missing error handling.');
  });

  it('should be case-insensitive', () => {
    const result = parseVerdict('verdict: pass\nfeedback: All good');
    assert.equal(result.verdict, 'PASS');
    assert.equal(result.feedback, 'All good');
  });

  it('should default to FAIL when no verdict found', () => {
    const result = parseVerdict('Some random text without a verdict');
    assert.equal(result.verdict, 'FAIL');
    assert.equal(result.feedback, 'No feedback provided.');
  });

  it('should handle multiline feedback', () => {
    const result = parseVerdict('VERDICT: FAIL\nFEEDBACK: Issue 1: no tests.\nIssue 2: no docs.\nIssue 3: hardcoded values.');
    assert.equal(result.verdict, 'FAIL');
    assert.ok(result.feedback.includes('Issue 1'));
    assert.ok(result.feedback.includes('Issue 3'));
  });
});
