import { execa } from 'execa';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SandboxManager, type Mount } from './Sandbox.js';

/**
 * Runs a whole CLI coding agent (Claude Code, Gemini CLI) inside a container,
 * so an agent that runs its own commands is still behind a boundary. The
 * container is like the per-command sandbox (capabilities dropped, read-only
 * root, the worktree the only writable mount) with one difference: instead
 * of no network it sits on an internal Docker network whose only exit is
 * an allowlisting CONNECT proxy, so the agent can reach its model API and
 * nothing else.
 */
export interface AgentSpec {
  id: string;
  /** The npm package that provides the CLI, installed when the agent image is built. */
  npmPackage: string;
  executable: string;
  /** Environment variables carried from the host into the container; the credential among them. */
  passEnv: string[];
  /** Hosts the agent must reach; the proxy admits these and nothing else. */
  egress: string[];
  /** An env var that can redirect the agent's API; its host is admitted when set. */
  baseUrlEnv?: string;
}

export interface AgentRunOptions {
  root: string;
  cwd: string;
  args: string[];
  env?: Record<string, string>;
  signal?: AbortSignal;
  onOutput?: (line: string) => void;
  timeout?: number;
}

export interface AgentRunResult { stdout: string; stderr: string; exitCode: number }

const NETWORK = 'softfactory-egress';
const PROXY_NAME = 'softfactory-egress-proxy';
const PROXY_ALIAS = 'egress-proxy';
const PROXY_PORT = 3128;
const BASE_IMAGE = 'node:20-bookworm-slim';

export class AgentContainer {
  private proxyStarted = false;
  private proxyAllow = '';
  private readonly builtImages = new Set<string>();

  constructor(private readonly log: (line: string) => void = () => {}, private readonly docker: (args: string[], options?: { input?: string; timeout?: number }) => Promise<{ stdout: string; stderr: string; exitCode: number }> = defaultDocker) {}

  /** The Dockerfile for an agent: the project's node base plus the agent's own CLI. */
  static dockerfileFor(spec: AgentSpec, baseImage = BASE_IMAGE): string {
    return [
      `FROM ${baseImage}`,
      'RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*',
      `RUN npm install -g ${spec.npmPackage} && npm cache clean --force`,
      'ENV HOME=/tmp',
      'WORKDIR /work',
    ].join('\n') + '\n';
  }

  static imageNameFor(spec: AgentSpec): string {
    return `softfactory-agent-${spec.id}:latest`;
  }

  /** The hosts the proxy admits for an agent: its API, a configured base URL, and any extra the project allows. */
  static egressFor(spec: AgentSpec, env: NodeJS.ProcessEnv = process.env, extra: string[] = []): string[] {
    const hosts = new Set(spec.egress);
    if (spec.baseUrlEnv && env[spec.baseUrlEnv]) {
      try { hosts.add(new URL(env[spec.baseUrlEnv]!).hostname); } catch { /* not a URL: nothing to admit */ }
    }
    for (const host of (env.SOFTFACTORY_EGRESS_ALLOW || '').split(',')) if (host.trim()) hosts.add(host.trim());
    for (const host of extra) if (host.trim()) hosts.add(host.trim());
    return [...hosts];
  }

  /** The credential an agent needs inside the container, or why it cannot run there. */
  static credentialProblem(spec: AgentSpec, env: NodeJS.ProcessEnv = process.env): string | null {
    const present = spec.passEnv.filter(name => env[name]);
    if (present.length > 0) return null;
    return `${spec.id} inside the container needs one of ${spec.passEnv.join(', ')} in the environment; a login kept in the home directory is not available there. Set the key, or run with --sandbox=none to use the host login (unsandboxed).`;
  }

  /**
   * The agent never runs as root: Claude Code refuses to skip permission
   * checks for root, and a root process in a container is one kernel bug
   * from the host. On Linux the host user owns the worktree, so that uid is
   * used; elsewhere the Docker desktop maps bind mounts for any uid and the
   * image's `node` user (1000) serves.
   */
  static userFor(platform: NodeJS.Platform = process.platform): string {
    if (platform === 'linux' && typeof process.getuid === 'function' && process.getuid() !== 0) return `${process.getuid()}:${process.getgid?.() ?? process.getuid()}`;
    return '1000:1000';
  }

  /** The docker run arguments for an agent process; pure, for tests. */
  static buildRunArgs(spec: AgentSpec, image: string, options: AgentRunOptions, env: NodeJS.ProcessEnv = process.env, cacheMounts: Mount[] = []): string[] {
    const args = ['run', '--rm', '--init', '--network', NETWORK,
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--read-only', '--tmpfs', '/tmp:rw,exec,size=4g',
      '--memory', '4g', '--cpus', '2', '--pids-limit', '1024',
      '--user', AgentContainer.userFor(),
      '-w', options.cwd];
    for (const mount of [...SandboxManager.mountsFor(options.root), ...cacheMounts]) {
      args.push('-v', `${mount.host}:${mount.container}${mount.readOnly ? ':ro' : ''}`);
    }
    const proxy = `http://${PROXY_ALIAS}:${PROXY_PORT}`;
    const vars: Record<string, string> = {
      HOME: '/tmp', CI: 'true', TERM: 'dumb',
      HTTP_PROXY: proxy, HTTPS_PROXY: proxy, http_proxy: proxy, https_proxy: proxy, NO_PROXY: 'localhost,127.0.0.1',
      npm_config_cache: '/tmp/.npm', npm_config_update_notifier: 'false',
      ...(options.env || {}),
    };
    for (const name of spec.passEnv) if (env[name]) vars[name] = env[name]!;
    if (spec.baseUrlEnv && env[spec.baseUrlEnv]) vars[spec.baseUrlEnv] = env[spec.baseUrlEnv]!;
    for (const [key, value] of Object.entries(vars)) args.push('-e', `${key}=${value}`);
    args.push(image, spec.executable, ...options.args);
    return args;
  }

  async ensureImage(spec: AgentSpec, root: string): Promise<string> {
    const override = process.env.SOFTFACTORY_AGENT_IMAGE || await configured(root, 'agentImage');
    if (override) return override;
    const image = AgentContainer.imageNameFor(spec);
    if (this.builtImages.has(image)) return image;
    const inspect = await this.docker(['image', 'inspect', image], { timeout: 15_000 });
    if (inspect.exitCode !== 0) {
      this.log(`Agent container: building ${image} (${spec.npmPackage} on ${BASE_IMAGE}; first use)...`);
      const context = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-agent-image-'));
      try {
        await fs.writeFile(path.join(context, 'Dockerfile'), AgentContainer.dockerfileFor(spec));
        const build = await this.docker(['build', '-q', '-t', image, context], { timeout: 15 * 60_000 });
        if (build.exitCode !== 0) throw new Error(`docker build of ${image} failed: ${build.stderr.trim().split('\n').slice(-3).join(' ')}`);
      } finally {
        await fs.rm(context, { recursive: true, force: true });
      }
    }
    this.builtImages.add(image);
    return image;
  }

  /** The internal network and the proxy on it; the proxy is restarted when the allowlist changes. */
  async ensureEgress(allow: string[]): Promise<void> {
    const key = [...allow].sort().join(',');
    if (this.proxyStarted && this.proxyAllow === key) return;
    const network = await this.docker(['network', 'inspect', NETWORK], { timeout: 15_000 });
    if (network.exitCode !== 0) {
      const created = await this.docker(['network', 'create', '--internal', NETWORK], { timeout: 30_000 });
      if (created.exitCode !== 0) throw new Error(`could not create the ${NETWORK} network: ${created.stderr.trim()}`);
    }
    await this.docker(['rm', '-f', PROXY_NAME], { timeout: 30_000 });
    const script = AgentContainer.proxyScriptPath();
    const started = await this.docker(['run', '-d', '--rm', '--name', PROXY_NAME, '--network', NETWORK, '--network-alias', PROXY_ALIAS,
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only', '--memory', '256m', '--pids-limit', '64',
      '-v', `${script}:/proxy/egress-proxy.mjs:ro`, '-e', `EGRESS_ALLOW=${allow.join(',')}`, '-e', `PORT=${PROXY_PORT}`,
      BASE_IMAGE, 'node', '/proxy/egress-proxy.mjs'], { timeout: 60_000 });
    if (started.exitCode !== 0) throw new Error(`could not start the egress proxy: ${started.stderr.trim().split('\n').slice(-2).join(' ')}`);
    // The proxy is the one container with a route out: it is also on the default bridge.
    const bridged = await this.docker(['network', 'connect', 'bridge', PROXY_NAME], { timeout: 30_000 });
    if (bridged.exitCode !== 0) {
      await this.docker(['rm', '-f', PROXY_NAME]);
      throw new Error(`could not give the egress proxy a route out: ${bridged.stderr.trim()}`);
    }
    this.proxyStarted = true;
    this.proxyAllow = key;
    this.log(`Agent container: egress limited to ${allow.join(', ')}`);
  }

  /** The built proxy script next to this module; it is mounted, not copied, so it is always the current one. */
  static proxyScriptPath(): string {
    return fileURLToPath(new URL('./EgressProxy.js', import.meta.url));
  }

  async run(spec: AgentSpec, options: AgentRunOptions, extraEgress: string[] = []): Promise<AgentRunResult> {
    const problem = AgentContainer.credentialProblem(spec);
    if (problem) throw new Error(problem);
    const image = await this.ensureImage(spec, options.root);
    await this.ensureEgress(AgentContainer.egressFor(spec, process.env, extraEgress));
    const args = AgentContainer.buildRunArgs(spec, image, options, process.env, await SandboxManager.cacheMounts());
    const proc = execa('docker', args, { timeout: options.timeout ?? 60 * 60_000, all: true, reject: false, ...(options.signal ? { cancelSignal: options.signal } : {}) });
    if (options.onOutput) proc.all?.on('data', chunk => { for (const line of chunk.toString().split('\n')) if (line.trim()) options.onOutput!(line); });
    const result = await proc;
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode ?? 1 };
  }

  /** Stops the proxy this process started; the network stays, it costs nothing. */
  async close(): Promise<void> {
    if (!this.proxyStarted) return;
    this.proxyStarted = false;
    await this.docker(['rm', '-f', PROXY_NAME], { timeout: 30_000 });
  }
}

async function configured(root: string, key: string): Promise<string | undefined> {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(root, '.softfactory', 'config.json'), 'utf8'));
    return typeof raw?.[key] === 'string' && raw[key] ? raw[key] : undefined;
  } catch {
    return undefined;
  }
}

async function defaultDocker(args: string[], options: { input?: string; timeout?: number } = {}) {
  const result = await execa('docker', args, { input: options.input, timeout: options.timeout ?? 120_000, reject: false });
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode ?? 1 };
}
