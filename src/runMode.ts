import type { Factory } from './Factory.js';

export interface RunOptions {
  resumeMode?: boolean;
  resumeFeatureId?: string;
  retryBlocked?: boolean;
  refineMode?: boolean;
  planMode?: boolean;
}

/**
 * Single dispatch point for "which Factory entry point does this invocation
 * run, with which flags". The TUI and the plain-stdout path used to duplicate
 * this, and the copies drifted: --retry-blocked reached one and not the other.
 */
export function startFactoryRun(factory: Factory, requirement: string, options: RunOptions): Promise<void> {
  if (options.resumeMode) return factory.resume(options.resumeFeatureId, options.retryBlocked);
  if (options.refineMode) return factory.refine(requirement);
  if (options.planMode) return factory.plan(requirement);
  return factory.build(requirement);
}
