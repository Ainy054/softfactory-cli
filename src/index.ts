#!/usr/bin/env node
import process from 'node:process';
import { Factory } from './Factory.js';

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('Error: GEMINI_API_KEY environment variable is required.');
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const noTui = args.includes('--no-tui') || !process.stdout.isTTY;
  const requirement = args.filter(a => a !== '--no-tui').join(' ');

  if (!requirement) {
    console.error('Usage: softfactory [--no-tui] <requirement>');
    process.exit(1);
  }

  const factory = new Factory(process.cwd(), apiKey, {
    streamToTerminal: noTui,
  });
  await factory.init();

  if (noTui) {
    // Plain console output mode
    factory.on('log', (msg: string) => {
      // Already logged by Factory when streamToTerminal=true
    });
    await factory.build(requirement);
  } else {
    // TUI mode with Ink
    const { render } = await import('ink');
    const React = await import('react');
    const { App } = await import('./components/App.js');

    const { waitUntilExit } = render(
      React.createElement(App, { factory, requirement })
    );
    await waitUntilExit();
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
