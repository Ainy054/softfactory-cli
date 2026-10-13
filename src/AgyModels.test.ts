import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { agyModelProblem, agyFailure, AGY_WORKER_MODEL, AGY_FRONTIER_MODEL } from './TextModel.js';
import { Factory } from './Factory.js';

// October 2026: agy retired Gemini 3.1 Pro and 3.7 Flash. A run planned with
// the old default failed with the command line echoed and agy's reason cut off.

const LISTING = 'Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\nclaude-opus-5-5-high\tClaude Opus 5.5 (High)\n';
const agyModels = async () => ({ exitCode: 0, stdout: LISTING });

describe('Antigravity models', () => {
  it('names a retired model and lists what agy offers', async () => {
    const problem = await agyModelProblem(['Gemini 3.1 Pro (High)', 'Gemini 3.8 Flash (High)'], agyModels);
    assert.match(problem ?? '', /no model "Gemini 3\.1 Pro \(High\)"\. Available: Gemini 3\.8 Flash \(High\), Claude Opus 5\.5 \(High\)/);
  });

  it('accepts names and ids, and never blocks when the list cannot be read', async () => {
    assert.equal(await agyModelProblem(['Gemini 3.8 Flash (High)', 'claude-opus-5-5-high'], agyModels), null);
    assert.equal(await agyModelProblem(['Anything'], async () => ({ exitCode: 1, stdout: '' })), null);
    assert.equal(await agyModelProblem(['Anything'], async () => { throw new Error('no agy'); }), null);
  });

  it('defaults to models agy offers now', async () => {
    assert.equal(await agyModelProblem([AGY_WORKER_MODEL, AGY_FRONTIER_MODEL], agyModels), null);
  });

  it("reports agy's own error instead of the echoed command", () => {
    const error = { shortMessage: "Command failed with exit code 1: agy --dangerously-skip-permissions --model 'X' --print 'You are the planner...'",
      stderr: 'Error: invalid model selection (--model "X"): model X is not recognized\nAvailable models:\n  Gemini 3.8 Flash (High)' };
    assert.match(agyFailure(error), /^Error: invalid model selection .*; Available models:; Gemini 3\.8 Flash \(High\)$/);
    assert.ok(!agyFailure({ shortMessage: "Command failed: agy --model 'X' --print 'long prompt here'" }).includes('long prompt'));
  });

  it('a run configured with a retired agy model stops before planning', async () => {
    const f: any = new Factory('/tmp', '', { strategy: 'cloud', cloudProvider: 'agy', plannerProvider: 'agy', cloudModel: 'Gemini 3.7 Flash (High)', frontierModel: AGY_FRONTIER_MODEL, sandbox: 'none' });
    f.agyModelCheck = (models: string[]) => agyModelProblem(models, agyModels);
    let planned = false;
    f.planner.generateBlueprint = async () => { planned = true; throw new Error('should not plan'); };
    await assert.rejects(f.build('anything'), /no model "Gemini 3\.7 Flash \(High\)"/);
    assert.equal(planned, false);
  });
});

describe('every planning path checks agy models', () => {
  it('--plan stops before planning with a retired model', async () => {
    const f: any = new Factory('/tmp', '', { strategy: 'cloud', cloudProvider: 'agy', plannerProvider: 'agy', plannerModel: 'Gemini 3.1 Pro (High)', sandbox: 'none' });
    f.agyModelCheck = (models: string[]) => agyModelProblem(models, agyModels);
    f.planner.generateBlueprint = async () => { throw new Error('should not plan'); };
    await assert.rejects(f.plan('anything'), /no model "Gemini 3\.1 Pro \(High\)"/);
  });
});
