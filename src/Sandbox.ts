import { execa } from 'execa';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

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
    const dockerArgs = ['run', '--rm', '--network', 'none', '--init',
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
    dockerArgs.push(config.image, file, ...args);
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
 * Decides where model-chosen commands run. "auto" uses Docker when it is
 * available and refuses to proceed when it is not, so an unsandboxed run is
 * always a choice the user made with --sandbox=none.
 */
export class SandboxManager {
  available = false;
  private detected = false;
  private readonly ensuredImages = new Set<string>();
  private readonly log: (line: string) => void;

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

  async ensureImage(image: string): Promise<void> {
    if (this.ensuredImages.has(image)) return;
    try {
      await execa('docker', ['image', 'inspect', image], { timeout: 15000 });
    } catch {
      this.log(`Sandbox: pulling ${image} (first use)...`);
      await execa('docker', ['pull', image], { timeout: 15 * 60_000 });
    }
    this.ensuredImages.add(image);
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

  async runnerFor(rootPath: string, executable?: string): Promise<CommandRunner> {
    if (!this.active) return new HostRunner();
    const image = await this.imageFor(rootPath, executable);
    await this.ensureImage(image);
    const user = process.platform === 'linux' && typeof process.getuid === 'function' ? `${process.getuid()}:${process.getgid?.() ?? 0}` : undefined;
    return new DockerRunner({
      image,
      mounts: [...SandboxManager.mountsFor(rootPath), ...await SandboxManager.cacheMounts()],
      env: { GOFLAGS: '-mod=mod', GOMODCACHE: '/go/pkg/mod', GOCACHE: '/tmp/gocache', npm_config_cache: '/tmp/.npm', npm_config_update_notifier: 'false', PIP_NO_INDEX: '1' },
      user,
    });
  }
}
