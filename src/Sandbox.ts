import { execa } from 'execa';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentContainer } from './AgentContainer.js';

export interface ExecOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeout?: number;
  input?: string;
}

export interface ExecResult { stdout: string; stderr: string; exitCode: number }

/**
 * Runs one executable with arguments, on the host or in a container. Both
 * reject the way execa does on a non-zero exit (an error carrying exitCode,
 * stdout and stderr), so callers written for execa keep working unchanged.
 */
export interface CommandRunner {
  readonly kind: 'host' | 'docker';
  describe(): string;
  exec(file: string, args: string[], options: ExecOptions): Promise<ExecResult>;
}

export class HostRunner implements CommandRunner {
  readonly kind = 'host';
  describe() { return 'host process (allowlist only)'; }
  async exec(file: string, args: string[], options: ExecOptions): Promise<ExecResult> {
    const result = await execa(file, args, { cwd: options.cwd, env: options.env, timeout: options.timeout, input: options.input });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode ?? 0 };
  }
}

export interface Mount { host: string; container: string; readOnly?: boolean }

export interface DockerRunnerConfig {
  image: string;
  mounts: Mount[];
  /** Environment passed into the container; nothing from the host leaks in by default. */
  env?: Record<string, string>;
  user?: string;
  memory?: string;
  cpus?: string;
  /** Docker network; `none` unless an orchestrator step (a dependency install) needs the registry. */
  network?: string;
}

/**
 * `docker run --rm --network none` with the worktree as the only writable
 * mount, at the same absolute path as on the host so no path translation is
 * needed. Everything else the command can see is read-only or absent.
 */
export class DockerRunner implements CommandRunner {
  readonly kind = 'docker';
  constructor(private readonly config: DockerRunnerConfig) {}

  describe() { return `docker ${this.config.image}, network off, writable: ${this.config.mounts.filter(m => !m.readOnly).map(m => m.host).join(', ')}`; }

  static buildArgs(config: DockerRunnerConfig, file: string, args: string[], options: ExecOptions): string[] {
    // The image's own filesystem is read-only too, so "the worktree is the
    // only writable mount" is literally true; tools get /tmp for caches.
    const dockerArgs = ['run', '--rm', '--network', config.network || 'none', '--init',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--read-only', '--tmpfs', '/tmp:rw,exec,size=2g',
      '--memory', config.memory || '2g', '--cpus', config.cpus || '2', '--pids-limit', '512',
      '-w', options.cwd];
    if (options.input !== undefined) dockerArgs.push('-i');
    if (config.user) dockerArgs.push('--user', config.user);
    for (const mount of config.mounts) {
      dockerArgs.push('-v', `${mount.host}:${mount.container}${mount.readOnly ? ':ro' : ''}`);
    }
    for (const [key, value] of Object.entries({ CI: 'true', HOME: '/tmp', ...(config.env || {}) })) {
      dockerArgs.push('-e', `${key}=${value}`);
    }
    // An explicit entrypoint: the node image's own entrypoint rewrites an
    // unknown command into `node <command>`, which hid "rg is not installed"
    // behind "Cannot find module .../rg".
    dockerArgs.push('--entrypoint', file, config.image, ...args);
    return dockerArgs;
  }

  async exec(file: string, args: string[], options: ExecOptions): Promise<ExecResult> {
    const result = await execa('docker', DockerRunner.buildArgs(this.config, file, args, options), {
      timeout: options.timeout ? options.timeout + 30000 : undefined,
      input: options.input,
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode ?? 0 };
  }
}

export type SandboxMode = 'auto' | 'docker' | 'none';

const IMAGES: Record<string, string> = {
  node: 'node:20-bookworm-slim',
  go: 'golang:1.22-bookworm',
  python: 'python:3.12-slim-bookworm',
  rust: 'rust:1-slim-bookworm',
  generic: 'debian:bookworm-slim',
};

/**
 * What the allowlist promises a worker and the stock images do not ship:
 * git (`git diff`, `git status`, and any test suite that shells out to git),
 * ripgrep (the search tool the prompt names), make. The first dogfood run
 * burned a third of a worker's tool calls on `rg` failing inside the image.
 */
const SANDBOX_TOOLS = ['git', 'ripgrep', 'make', 'ca-certificates'];

export function sandboxDockerfile(base: string): string {
  return `FROM ${base}\nRUN apt-get update && apt-get install -y --no-install-recommends ${SANDBOX_TOOLS.join(' ')} && rm -rf /var/lib/apt/lists/*\n`;
}

/** The locally built image for a stock base; an override image is used as is. */
export function derivedImageName(base: string): string | undefined {
  const key = Object.entries(IMAGES).find(([, value]) => value === base)?.[0];
  return key ? `softfactory-sandbox-${key}:latest` : undefined;
}

export interface NodeDependencyPlan {
  /** The directory holding package.json: the root, or frontend/. */
  pkgDir: string;
  lockfile: string;
  manager: 'npm' | 'pnpm' | 'yarn';
  /** Named Docker volume, one per lockfile content and CPU architecture. */
  volume: string;
  /** The install command, run once inside the Linux image with the network on. */
  install: string;
}

const LOCKFILES: Array<[string, NodeDependencyPlan['manager'], string]> = [
  ['package-lock.json', 'npm', 'npm ci --ignore-scripts --no-audit --no-fund'],
  ['npm-shrinkwrap.json', 'npm', 'npm ci --ignore-scripts --no-audit --no-fund'],
  ['pnpm-lock.yaml', 'pnpm', 'corepack enable && corepack pnpm install --frozen-lockfile --ignore-scripts'],
  ['yarn.lock', 'yarn', 'corepack enable && corepack yarn install --frozen-lockfile --ignore-scripts'],
];

/**
 * Node dependencies for the sandbox. Installing them on the host and sharing
 * the directory put macOS binaries (esbuild, and so tsx and vitest) in front
 * of a Linux container: every test failed at load, on the base branch too,
 * and the first run of softfactory on its own repository could not verify a
 * thing. The plan names a volume per lockfile; the install happens once, in
 * the Linux image, and the volume shadows <pkgDir>/node_modules thereafter.
 */
export async function nodeDependencyPlan(rootPath: string): Promise<NodeDependencyPlan | undefined> {
  for (const sub of ['', 'frontend']) {
    const pkgDir = path.join(rootPath, sub);
    if (!await fs.access(path.join(pkgDir, 'package.json')).then(() => true, () => false)) continue;
    for (const [lockfile, manager, install] of LOCKFILES) {
      let content: string;
      try { content = await fs.readFile(path.join(pkgDir, lockfile), 'utf8'); } catch { continue; }
      const hash = createHash('sha256').update(`${manager}\n${process.arch}\n${content}`).digest('hex').slice(0, 12);
      return { pkgDir, lockfile, manager, volume: `softfactory-deps-${hash}`, install };
    }
    return undefined;
  }
  return undefined;
}

/**
 * Decides where model-chosen commands run. "auto" uses Docker when it is
 * available and refuses to proceed when it is not, so an unsandboxed run is
 * always a choice the user made with --sandbox=none.
 */
export class SandboxManager {
  available = false;
  private detected = false;
  private readonly ensuredImages = new Set<string>();
  private readonly dependencyVolumes = new Map<string, Promise<boolean>>();
  private readonly log: (line: string) => void;
  private agents: AgentContainer | undefined;

  constructor(readonly mode: SandboxMode = 'auto', log: (line: string) => void = () => {}) {
    this.log = log;
  }

  get active(): boolean { return this.mode !== 'none' && this.available; }

  async detect(): Promise<boolean> {
    if (this.detected) return this.available;
    this.detected = true;
    if (this.mode === 'none') return false;
    try {
      await execa('docker', ['version', '--format', '{{.Server.Version}}'], { timeout: 8000 });
      this.available = true;
    } catch {
      this.available = false;
    }
    return this.available;
  }

  /** Why a run may not proceed, or null when it may. */
  blockingReason(): string | null {
    if (this.mode === 'none') return null;
    if (this.available) return null;
    return this.mode === 'docker'
      ? 'Sandbox mode is "docker" but Docker is not running. Start Docker, or pass --sandbox=none to run worker commands on the host under the allowlist only.'
      : 'No sandbox: Docker is not available, so worker commands would run on the host with only an allowlist between them and your files. Start Docker, or pass --sandbox=none to accept that.';
  }

  describe(): string {
    if (this.active) return 'docker container per command: network off, worktree the only writable mount';
    return 'UNSANDBOXED: commands run on the host under the command allowlist only';
  }

  /** Image for a project root, by its manifests, with per-project and env overrides. */
  async imageFor(rootPath: string, executable?: string): Promise<string> {
    const override = process.env.SOFTFACTORY_SANDBOX_IMAGE || await this.configuredImage(rootPath);
    if (override) return override;
    const has = async (...parts: string[]) => fs.access(path.join(rootPath, ...parts)).then(() => true, () => false);
    const present = {
      node: await has('package.json') || await has('frontend', 'package.json'),
      go: await has('go.mod') || await has('backend', 'go.mod'),
      python: await has('pyproject.toml') || await has('requirements.txt') || await has('pytest.ini'),
      rust: await has('Cargo.toml'),
    };
    if (executable) {
      if (['npm', 'pnpm', 'yarn', 'node', 'vitest', 'tsc', 'eslint'].includes(executable) && present.node) return IMAGES.node;
      if (executable === 'go' && present.go) return IMAGES.go;
      if (['pytest', 'python', 'python3'].includes(executable) && present.python) return IMAGES.python;
      if (executable === 'cargo' && present.rust) return IMAGES.rust;
    }
    for (const key of ['node', 'go', 'python', 'rust'] as const) if (present[key]) return IMAGES[key];
    return IMAGES.generic;
  }

  private async configuredImage(rootPath: string): Promise<string | undefined> {
    try {
      const raw = JSON.parse(await fs.readFile(path.join(rootPath, '.softfactory', 'config.json'), 'utf8'));
      return typeof raw?.sandboxImage === 'string' && raw.sandboxImage ? raw.sandboxImage : undefined;
    } catch {
      return undefined;
    }
  }

  /** Pulls an override image, or builds the tool-complete image on a stock base; returns the image to run. */
  async ensureImage(image: string): Promise<string> {
    const derived = derivedImageName(image);
    const target = derived ?? image;
    if (this.ensuredImages.has(target)) return target;
    try {
      await execa('docker', ['image', 'inspect', target], { timeout: 15000 });
    } catch {
      if (derived) {
        this.log(`Sandbox: building ${target} from ${image} with ${SANDBOX_TOOLS.slice(0, 3).join(', ')} (first use)...`);
        await execa('docker', ['build', '-q', '-t', target, '-'], { input: sandboxDockerfile(image), timeout: 15 * 60_000 });
      } else {
        this.log(`Sandbox: pulling ${image} (first use)...`);
        await execa('docker', ['pull', image], { timeout: 15 * 60_000 });
      }
    }
    this.ensuredImages.add(target);
    return target;
  }

  /**
   * Mounts for a root: the root itself writable, plus, for a git worktree,
   * the main repository read-only (the worktree's .git file points into it)
   * and that worktree's own gitdir writable, so `git status` and `git diff`
   * work inside without exposing the main checkout to writes.
   */
  static mountsFor(rootPath: string): Mount[] {
    const root = path.resolve(rootPath);
    const mounts: Mount[] = [];
    const marker = `${path.sep}.git${path.sep}softfactory-worktrees${path.sep}`;
    const at = root.indexOf(marker);
    if (at !== -1) {
      const repo = root.slice(0, at);
      const taskId = root.slice(at + marker.length).split(path.sep)[0];
      mounts.push({ host: repo, container: repo, readOnly: true });
      mounts.push({ host: path.join(repo, '.git', 'worktrees', taskId), container: path.join(repo, '.git', 'worktrees', taskId) });
    }
    mounts.push({ host: root, container: root });
    return mounts;
  }

  /** Read-only module caches so offline builds resolve dependencies the host already has. */
  static async cacheMounts(): Promise<Mount[]> {
    const mounts: Mount[] = [];
    const goModCache = process.env.GOMODCACHE || path.join(process.env.GOPATH || path.join(os.homedir(), 'go'), 'pkg', 'mod');
    if (await fs.access(goModCache).then(() => true, () => false)) {
      mounts.push({ host: goModCache, container: '/go/pkg/mod', readOnly: true });
    }
    return mounts;
  }

  /**
   * The Linux-installed node_modules for a root, as a mount over the package
   * directory's own; empty when the project has no lockfile or the install
   * failed (the log says why), in which case commands see whatever is there.
   */
  async nodeDependencyMounts(rootPath: string): Promise<Mount[]> {
    const plan = await nodeDependencyPlan(rootPath);
    if (!plan) return [];
    // Mounting over a symlinked node_modules makes Docker resolve the link on
    // the host side; it once replaced the link's target, another checkout's
    // node_modules, with a self-referencing link.
    const existing = await fs.lstat(path.join(plan.pkgDir, 'node_modules')).catch(() => null);
    if (existing?.isSymbolicLink()) {
      this.log(`Sandbox: ${path.join(plan.pkgDir, 'node_modules')} is a symlink; Linux dependencies are not mounted over it. Replace it with a real install to test in the sandbox.`);
      return [];
    }
    if (!await this.ensureDependencyVolume(plan)) return [];
    return [{ host: plan.volume, container: path.join(plan.pkgDir, 'node_modules') }];
  }

  /** True when the volume exists or was just populated; memoized per volume for the run. */
  ensureDependencyVolume(plan: NodeDependencyPlan): Promise<boolean> {
    let pending = this.dependencyVolumes.get(plan.volume);
    if (!pending) {
      pending = this.installDependencyVolume(plan);
      this.dependencyVolumes.set(plan.volume, pending);
    }
    return pending;
  }

  protected async installDependencyVolume(plan: NodeDependencyPlan): Promise<boolean> {
    try {
      await execa('docker', ['volume', 'inspect', plan.volume], { timeout: 15000 });
      return true;
    } catch { /* not yet */ }
    const image = await this.ensureImage(IMAGES.node);
    const started = Date.now();
    this.log(`Sandbox: installing Node dependencies from ${path.relative(process.cwd(), path.join(plan.pkgDir, plan.lockfile)) || plan.lockfile} into volume ${plan.volume} (Linux, network on for this step only)...`);
    try {
      await execa('docker', ['volume', 'create', '--label', 'softfactory.deps=1', '--label', `softfactory.manager=${plan.manager}`, plan.volume], { timeout: 30000 });
      await execa('docker', [
        'run', '--rm', '--network', 'bridge', '--init', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
        '--tmpfs', '/tmp:rw,exec,size=2g', '--memory', '4g', '--cpus', '2', '--pids-limit', '512',
        '-v', `${plan.pkgDir}:/src:ro`, '-v', `${plan.volume}:/pkg/node_modules`, '-w', '/pkg',
        '-e', 'HOME=/tmp', '-e', 'CI=true', '-e', 'npm_config_cache=/tmp/.npm', '-e', 'npm_config_update_notifier=false', '-e', 'COREPACK_ENABLE_DOWNLOAD_PROMPT=0',
        '--entrypoint', 'sh', image, '-c', `cp /src/package.json /src/${plan.lockfile} /pkg/ && ${plan.install}`,
      ], { timeout: 15 * 60_000 });
      this.log(`Sandbox: dependencies ready in ${Math.round((Date.now() - started) / 1000)}s (${plan.volume})`);
      return true;
    } catch (error: any) {
      await execa('docker', ['volume', 'rm', '-f', plan.volume], { timeout: 30000 }).catch(() => undefined);
      const tail = String(error?.stderr || error?.stdout || error?.message || error).trim().split('\n').slice(-4).join(' | ');
      this.log(`Sandbox: dependency install failed; commands will see the project's own node_modules. ${tail}`);
      return false;
    }
  }

  /** Where whole CLI agents run when the sandbox is active; built on first use. */
  agentContainer(): AgentContainer {
    if (!this.agents) this.agents = new AgentContainer(this.log);
    return this.agents;
  }

  /** Stops anything long-lived the sandbox started (the egress proxy). */
  async close(): Promise<void> {
    await this.agents?.close();
  }

  async runnerFor(rootPath: string, executable?: string): Promise<CommandRunner> {
    if (!this.active) return new HostRunner();
    const image = await this.ensureImage(await this.imageFor(rootPath, executable));
    const user = process.platform === 'linux' && typeof process.getuid === 'function' ? `${process.getuid()}:${process.getgid?.() ?? 0}` : undefined;
    return new DockerRunner({
      image,
      mounts: [...SandboxManager.mountsFor(rootPath), ...await SandboxManager.cacheMounts(), ...await this.nodeDependencyMounts(rootPath)],
      env: { GOFLAGS: '-mod=mod', GOMODCACHE: '/go/pkg/mod', GOCACHE: '/tmp/gocache', npm_config_cache: '/tmp/.npm', npm_config_update_notifier: 'false', PIP_NO_INDEX: '1' },
      user,
    });
  }
}
