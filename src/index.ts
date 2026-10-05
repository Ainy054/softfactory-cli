#!/usr/bin/env node
import process from 'node:process';
import { Factory } from './Factory.js';
import { WorkerStrategy, CloudProvider } from './WorkerRegistry.js';
import { startFactoryRun } from './runMode.js';

const KNOWN_FLAGS = [
  '--no-tui', '--resume', '--retry-blocked', '--history', '--refine', '--no-docker', '--plan',
  '--strategy', '--local-model', '--cloud-model', '--frontier-model', '--cloud-provider',
  '--planner-provider', '--planner-model'
];

const USAGE = 'Usage: softfactory [--strategy=hybrid|local|cloud] [--cloud-provider=agy|openai|openai-api|anthropic|deepseek] [--planner-provider=openai|agy|local|deepseek] [--planner-model=model] [--local-model=model] [--cloud-model=model] [--frontier-model=model] [--no-tui] [--no-docker] [--plan] [--resume [feature-id]] [--retry-blocked] [--refine] [--history] <requirement>';

let globalFactory: Factory | null = null;

let shuttingDown = false;
const handleExit = async (signal: string, code: number) => {
  if (shuttingDown) process.exit(code);   // a second Ctrl-C exits immediately
  shuttingDown = true;
  console.log(`\n[SoftFactory] Caught ${signal} — reconciling tasks and pruning worktrees...`);
  if (globalFactory) {
    try {
      const { reset } = await globalFactory.shutdown();
      console.log(`[SoftFactory] Reset ${reset} in-flight task(s) to pending and cleaned up their worktrees. Run --resume to continue.`);
    } catch (err: any) {
      console.error(`[SoftFactory] Shutdown cleanup failed: ${err?.message}`);
    }
  }
  process.exit(code);
};

process.on('SIGINT', () => handleExit('SIGINT', 130));
process.on('SIGTERM', () => handleExit('SIGTERM', 143));

function getFlagValue(args: string[], flag: string): string | undefined {
  const exact = args.find(a => a.startsWith(`${flag}=`));
  if (exact) return exact.split('=')[1];
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length && !args[idx + 1].startsWith('--')) {
    return args[idx + 1];
  }
  return undefined;
}

async function main() {
  const apiKey = process.env.GEMINI_API_KEY || '';
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    process.exit(0);
  }
  const historyMode = args.includes('--history');

  const strategyArg = (getFlagValue(args, '--strategy') || 'hybrid') as WorkerStrategy;
  const localModelArg = getFlagValue(args, '--local-model') || 'qwen2.5-coder:7b';
  const cloudProviderArg = (getFlagValue(args, '--cloud-provider') || 'agy') as CloudProvider;
  if (!['agy', 'openai', 'openai-api', 'anthropic', 'deepseek'].includes(cloudProviderArg)) {
    throw new Error(`Unsupported --cloud-provider "${cloudProviderArg}". Use agy, openai, openai-api, anthropic, or deepseek.`);
  }
  const plannerProviderArg = getFlagValue(args, '--planner-provider') || (strategyArg === 'local' ? 'local' : cloudProviderArg === 'deepseek' ? 'deepseek' : 'openai');
  if (!['openai', 'agy', 'local', 'deepseek'].includes(plannerProviderArg)) {
    throw new Error(`Unsupported --planner-provider "${plannerProviderArg}". Use openai, agy, local, or deepseek.`);
  }
  const plannerModelArg = getFlagValue(args, '--planner-model') || '';
  // The Codex CLI already has an authenticated, user-configured default model.
  // Do not accidentally pass Antigravity's Gemini defaults to it.  Supplying
  // either option remains useful for explicitly choosing fast/frontier tiers.
  const cloudModelArg = getFlagValue(args, '--cloud-model') || (cloudProviderArg === 'openai' ? '' : cloudProviderArg === 'deepseek' ? 'deepseek-v4-flash' : 'Gemini 3.7 Flash (High)');
  const frontierModelArg = getFlagValue(args, '--frontier-model') || (cloudProviderArg === 'openai' ? '' : cloudProviderArg === 'deepseek' ? 'deepseek-v4-pro' : 'Gemini 3.1 Pro (High)');

  if (historyMode) {
    const factory = new Factory(process.cwd(), apiKey, {
      streamToTerminal: true,
      strategy: strategyArg,
      localModel: localModelArg,
      cloudModel: cloudModelArg,
      frontierModel: frontierModelArg,
      cloudProvider: cloudProviderArg,
      plannerProvider: plannerProviderArg,
      plannerModel: plannerModelArg,
    });
    globalFactory = factory;
    await factory.init();
    const features = await factory.getHistory();
    if (features.length === 0) {
      console.log('No features built yet.');
    } else {
      console.log('Feature History:');
      console.log('-'.repeat(80));
      for (const f of features) {
        const done = `${f.tasks_done}/${f.task_count}`;
        console.log(`  ${f.feature_id.padEnd(20)} ${f.status.padEnd(10)} ${done.padEnd(6)} ${f.feature}`);
      }
    }
    process.exit(0);
  }

  const noTui = args.includes('--no-tui') || !process.stdout.isTTY;
  const resumeMode = args.includes('--resume');
  const retryBlocked = args.includes('--retry-blocked');
  const refineMode = args.includes('--refine');
  const planMode = args.includes('--plan');
  const noDocker = args.includes('--no-docker');

  let resumeFeatureId: string | undefined;
  if (resumeMode) {
    const resumeIdx = args.indexOf('--resume');
    const nextArg = args[resumeIdx + 1];
    if (nextArg && !nextArg.startsWith('--') && nextArg.startsWith('f-')) {
      resumeFeatureId = nextArg;
    }
  }

  // Filter out flag values from requirement
  const requirement = args.filter((a, idx) => {
    if (KNOWN_FLAGS.some(f => a === f || a.startsWith(`${f}=`))) return false;
    const prev = args[idx - 1];
    if (prev && ['--strategy', '--local-model', '--cloud-model', '--frontier-model', '--cloud-provider', '--planner-provider', '--planner-model'].includes(prev)) return false;
    if (a === resumeFeatureId) return false;
    return true;
  }).join(' ');

  if (!resumeMode && !requirement) {
    console.error(USAGE);
    process.exit(1);
  }

  if (refineMode && !requirement) {
    console.error('Error: --refine requires a refinement description.');
    console.error('Example: softfactory --refine "use PostgreSQL instead of SQLite"');
    process.exit(1);
  }

  if (planMode && !requirement) {
    console.error('Error: --plan requires a requirement description.');
    console.error('Example: softfactory --plan "Add user authentication with JWT"');
    process.exit(1);
  }

  const factory = new Factory(process.cwd(), apiKey, {
    streamToTerminal: noTui,
    useDocker: !noDocker,
    strategy: strategyArg,
    localModel: localModelArg,
    cloudModel: cloudModelArg,
    frontierModel: frontierModelArg,
    cloudProvider: cloudProviderArg,
    plannerProvider: plannerProviderArg,
    plannerModel: plannerModelArg,
  });
  globalFactory = factory;
  await factory.init();

  if (noTui) {
    await startFactoryRun(factory, requirement, { resumeMode, resumeFeatureId, retryBlocked, refineMode, planMode });
  } else {
    const { render } = await import('ink');
    const React = await import('react');
    const { App } = await import('./components/App.js');

    const { waitUntilExit } = render(
      React.createElement(App, { factory, requirement, resumeMode, resumeFeatureId, retryBlocked, refineMode, planMode })
    );
    await waitUntilExit();
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
