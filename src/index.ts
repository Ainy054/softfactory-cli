#!/usr/bin/env node
import { Factory } from './Factory.js';
import process from 'node:process';

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("Error: GEMINI_API_KEY environment variable is required.");
    process.exit(1);
  }

  const requirement = process.argv[2];
  if (!requirement) {
    console.error("Usage: softfactory <requirement>");
    process.exit(1);
  }

  const factory = new Factory(process.cwd(), apiKey);
  await factory.init();
  await factory.build(requirement);
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
