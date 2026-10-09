import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePostmortem, POSTMORTEM_SECTIONS } from './Inspector.js';

/** Index of the exact `### <section>` heading line in the normalized output. */
function headingIndex(output: string, section: string): number {
  return output.split('\n').findIndex(line => line.trim() === `### ${section}`);
}

/** The non-blank lines between `### <section>` and the next heading (or end). */
function sectionBody(output: string, section: string): string[] {
  const lines = output.split('\n');
  const start = headingIndex(output, section);
  assert.ok(start >= 0, `output is missing the heading: ${section}`);
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (/^#{1,6}\s/.test(line)) break;
    if (line) body.push(line);
  }
  return body;
}

describe('normalizePostmortem puts the six sections in POSTMORTEM_SECTIONS order', () => {
  it('reorders a scrambled post-mortem into the canonical order', () => {
    const input = [
      '### Unverified claims',
      '- maybe it is fine',
      '### Codebase facts',
      '- routing lives in index.ts',
      '### What review caught',
      '- a missed null check',
      '### Planning advice',
      '- split the migration',
      '### Escalations applied',
      '- escalated to the cloud reviewer',
      '### What worked',
      '- the tests ran first',
    ].join('\n');

    const output = normalizePostmortem(input);
    const indices = POSTMORTEM_SECTIONS.map(section => headingIndex(output, section));

    assert.ok(indices.every(index => index >= 0), 'every known heading survives');
    const ascending = [...indices].sort((a, b) => a - b);
    assert.deepEqual(indices, ascending, 'headings are ordered exactly as POSTMORTEM_SECTIONS');
  });

  it('emits the heading list in a fixed order even when the input already matches', () => {
    const input = POSTMORTEM_SECTIONS.map(section => `### ${section}\n- note`).join('\n');
    const headings = normalizePostmortem(input)
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.startsWith('### '))
      .map(line => line.replace(/^###\s+/, ''));

    assert.deepEqual(headings, POSTMORTEM_SECTIONS);
  });
});

describe('normalizePostmortem fills a missing section with "- none"', () => {
  it('writes - none for every section the model did not produce', () => {
    const output = normalizePostmortem('### What worked\n- one real bullet');

    for (const section of POSTMORTEM_SECTIONS) {
      const body = sectionBody(output, section);
      if (section === 'What worked') {
        assert.deepEqual(body, ['- one real bullet']);
      } else {
        assert.deepEqual(body, ['- none'], `${section} must be filled with - none`);
      }
    }
  });

  it('returns all six sections as - none for empty input', () => {
    const output = normalizePostmortem('   \n\n');
    for (const section of POSTMORTEM_SECTIONS) {
      assert.deepEqual(sectionBody(output, section), ['- none'], `${section} must be - none`);
    }
  });
});

describe('normalizePostmortem drops headings that are not in the list', () => {
  it('removes an unknown heading and everything under it', () => {
    const input = [
      '### What worked',
      '- kept bullet',
      '### Secret sauce',
      '- this must not survive',
      '### Codebase facts',
      '- also kept',
    ].join('\n');

    const output = normalizePostmortem(input);

    assert.doesNotMatch(output, /Secret sauce/);
    assert.doesNotMatch(output, /must not survive/);
    assert.deepEqual(sectionBody(output, 'What worked'), ['- kept bullet']);
    assert.deepEqual(sectionBody(output, 'Codebase facts'), ['- also kept']);
  });

  it('keeps only the six known headings', () => {
    const input = '### Something else entirely\n- noise\n### What worked\n- kept';
    const headings = normalizePostmortem(input)
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.startsWith('### '));
    assert.deepEqual(headings, POSTMORTEM_SECTIONS.map(section => `### ${section}`));
  });
});

describe('normalizePostmortem preserves the bullets under known headings', () => {
  it('keeps every bullet in order, normalizing the marker to a dash', () => {
    const input = [
      '### What worked',
      '- the tests ran fast',
      '* reused the existing client',
      '• no new dependency',
      'a plain sentence with no marker',
      '### Codebase facts',
      '- index.ts owns routing',
      '- config is folded YAML',
    ].join('\n');

    const output = normalizePostmortem(input);

    assert.deepEqual(sectionBody(output, 'What worked'), [
      '- the tests ran fast',
      '- reused the existing client',
      '- no new dependency',
      '- a plain sentence with no marker',
    ]);
    assert.deepEqual(sectionBody(output, 'Codebase facts'), [
      '- index.ts owns routing',
      '- config is folded YAML',
    ]);
  });

  it('does not lose a bullet just because the section was written lower-case', () => {
    const output = normalizePostmortem('### what worked\n- still here');
    assert.deepEqual(sectionBody(output, 'What worked'), ['- still here']);
  });
});
