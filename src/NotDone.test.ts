import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Factory } from './Factory.js';
import type { Task, Handoff } from './types.js';

const task = (over: Partial<Task> = {}): Task => ({
  id: 'T1',
  title: 'Harden the parser',
  description: 'Reject malformed headers.',
  executor: 'agent',
  files_hint: [],
  creates_files: [],
  acceptance_criteria: ['the parser rejects a malformed header'],
  verification_command: 'node --import tsx --test src/NotDone.test.ts',
  dependencies: [],
  ...over,
} as Task);

const handoff = (over: Partial<Handoff> = {}): Handoff => ({
  task_id: 'T1',
  status: 'success',
  files_changed: [],
  summary: 'done',
  ...over,
} as Handoff);

/** The method reads no instance state, so a bare receiver exercises it as used. */
const violation = (t: Task, h: Handoff) => Factory.prototype.notDoneViolation.call({} as Factory, t, h);

describe('a worker\'s own "not done" list is binding', () => {
  test('no not_done list is not a violation', () => {
    assert.equal(violation(task(), handoff()), null);
  });

  test('an empty not_done list is not a violation', () => {
    assert.equal(violation(task(), handoff({ not_done: [] })), null);
  });

  test('an item unrelated to the acceptance criteria is not a violation', () => {
    const h = handoff({ not_done: ['polished the changelog prose'] });
    assert.equal(violation(task(), h), null);
  });

  test('an item sharing a five-letter-or-longer word with a criterion is a violation', () => {
    const h = handoff({ not_done: ['the malformed header path is still unhandled'] });
    const message = violation(task(), h);
    assert.ok(message, 'a shared key word rejects the task');
    assert.match(message, /reported acceptance work as not done/);
    assert.match(message, /malformed header path is still unhandled/);
  });

  test('an item containing the task\'s verification command is a violation', () => {
    const h = handoff({ not_done: ['could not run node --import tsx --test src/NotDone.test.ts'] });
    const message = violation(task(), h);
    assert.ok(message, 'quoting the acceptance command rejects the task');
    assert.match(message, /reported acceptance work as not done/);
    assert.match(message, /node --import tsx --test src\/NotDone\.test\.ts/);
  });

  test('a short shared word (under five letters) is not enough', () => {
    const h = handoff({ not_done: ['did not run the tests'] });
    assert.equal(violation(task(), h), null, '"the"/"run" are too short to match');
  });
});
