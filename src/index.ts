#!/usr/bin/env node
import process from 'node:process';
import { Factory } from './Factory.js';

const FLAGS = ['--no-tui', '--resume', '--history', '--refine', '--no-docker', '--plan'];

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  const args = process.argv.slice(2);
  const historyMode = args.includes('--history');

  if (historyMode) {
    if (!apiKey) {
      console.error('Error: GEMINI_API_KEY environment variable is required.');
      process.exit(1);
    }
    const factory = new Factory(process.cwd(), apiKey, { streamToTerminal: true });
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

  if (!apiKey) {
    console.error('Error: GEMINI_API_KEY environment variable is required.');
    process.exit(1);
  }

  const noTui = args.includes('--no-tui') || !process.stdout.isTTY;
  const resumeMode = args.includes('--resume');
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

  const requirement = args.filter(a => !FLAGS.includes(a) && a !== resumeFeatureId).join(' ');

  if (!resumeMode && !requirement) {
    console.error('Usage: softfactory [--no-tui] [--no-docker] [--plan] [--resume [feature-id]] [--refine] [--history] <requirement>');
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
  });
  await factory.init();

  if (noTui) {
    if (resumeMode) {
      await factory.resume(resumeFeatureId);
    } else if (refineMode) {
      await factory.refine(requirement);
    } else if (planMode) {
      await factory.plan(requirement);
    } else {
      await factory.build(requirement);
    }
  } else {
    const { render } = await import('ink');
    const React = await import('react');
    const { App } = await import('./components/App.js');

    const { waitUntilExit } = render(
      React.createElement(App, { factory, requirement, resumeMode, resumeFeatureId, refineMode, planMode })
    );
    await waitUntilExit();
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
