#!/usr/bin/env node
import process from 'node:process';
import { Factory } from './Factory.js';

const FLAGS = ['--no-tui', '--resume'];

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('Error: GEMINI_API_KEY environment variable is required.');
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const noTui = args.includes('--no-tui') || !process.stdout.isTTY;
  const resumeMode = args.includes('--resume');
  const requirement = args.filter(a => !FLAGS.includes(a)).join(' ');

  if (!resumeMode && !requirement) {
    console.error('Usage: softfactory [--no-tui] [--resume] <requirement>');
    process.exit(1);
  }

  const factory = new Factory(process.cwd(), apiKey, {
    streamToTerminal: noTui,
  });
  await factory.init();

  if (noTui) {
    if (resumeMode) {
      await factory.resume();
    } else {
      await factory.build(requirement);
    }
  } else {
    const { render } = await import('ink');
    const React = await import('react');
    const { App } = await import('./components/App.js');

    const { waitUntilExit } = render(
      React.createElement(App, { factory, requirement, resumeMode })
    );
    await waitUntilExit();
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
