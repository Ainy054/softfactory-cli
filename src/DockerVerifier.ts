import { execa } from 'execa';
import path from 'node:path';
import fs from 'node:fs/promises';
import net from 'node:net';

export interface VerifyResult {
  passed: boolean;
  logs: string;
}

export class DockerVerifier {
  async detect(): Promise<boolean> {
    // 1. Direct check if docker daemon is running
    try {
      await execa('docker', ['info'], { timeout: 3000 });
      return true;
    } catch {}

    // Do not launch desktop applications as a side effect of a CLI check.
    try {
      await execa('docker', ['compose', 'version'], { timeout: 3000 });
      return true;
    } catch {
      return false;
    }
  }

  async verify(projectDir: string): Promise<VerifyResult> {
    const composeFile = await this.getComposeFile(projectDir);
    if (!composeFile) {
      return { passed: false, logs: 'No docker-compose.yml or compose.yml found in project root.' };
    }

    const logs: string[] = [];

    // One Docker daemon is shared with every other project on the machine.
    // Starting every service in a compose file without checking is how a
    // verification run takes down a port another project is already serving.
    const conflicts = await this.conflictingPorts(projectDir, composeFile);
    if (conflicts.length > 0) {
      return {
        passed: false,
        logs: `Docker verification skipped: host port(s) ${conflicts.join(', ')} are already in use by something else on this machine. `
          + 'Starting this compose stack would collide with it. Free the ports, or run with --no-docker.',
      };
    }

    try {
      // Build
      logs.push('=== Docker Build ===');
      const build = await execa(
        'docker', ['compose', '-f', composeFile, 'build'],
        { cwd: projectDir, timeout: 300000 }
      );
      logs.push(build.stdout || '(no build output)');

      // Start services
      logs.push('\n=== Docker Start ===');
      await execa(
        'docker', ['compose', '-f', composeFile, 'up', '-d'],
        { cwd: projectDir, timeout: 60000 }
      );

      // Wait for services to stabilize
      await new Promise(resolve => setTimeout(resolve, 10000));

      // Check service status
      logs.push('\n=== Service Status ===');
      const ps = await execa(
        'docker', ['compose', '-f', composeFile, 'ps', '--format', 'json'],
        { cwd: projectDir, timeout: 10000 }
      );
      logs.push(ps.stdout || '(no status output)');

      // Capture service logs
      logs.push('\n=== Service Logs ===');
      const serviceLogs = await execa(
        'docker', ['compose', '-f', composeFile, 'logs', '--tail', '50'],
        { cwd: projectDir, timeout: 10000 }
      );
      logs.push(serviceLogs.stdout || '(no logs)');

      // A container that exited 0 is a completed one-shot job (a migration,
      // a seed step); only a non-zero exit or a dead container is a crash.
      const psOutput = ps.stdout || '';
      const hasCrashed = /"(?:ExitCode|exit_code)"\s*:\s*(?!0\b)\d+/.test(psOutput) || psOutput.includes('"dead"');
      const hasRunning = psOutput.includes('"running"') || psOutput.includes('"Up"');

      const passed = hasRunning && !hasCrashed;
      logs.push(`\n=== Result: ${passed ? 'PASS' : 'FAIL'} ===`);

      return { passed, logs: logs.join('\n') };
    } catch (e: any) {
      logs.push(`\n=== Error: ${e.message} ===`);
      if (e.stderr) logs.push(e.stderr);
      return { passed: false, logs: logs.join('\n') };
    } finally {
      // Always clean up
      try {
        // Never pass --volumes: these are the user's own compose volumes and may
        // hold their local database. Stop what we started; destroy nothing.
        await execa('docker', ['compose', '-f', composeFile, 'down', '--remove-orphans'],
          { cwd: projectDir, timeout: 30000 });
      } catch {}
    }
  }

  /** Published host ports in the compose file that something is already serving. */
  async conflictingPorts(projectDir: string, composeFile: string): Promise<number[]> {
    const ports = await this.publishedPorts(projectDir, composeFile);
    const taken: number[] = [];
    for (const port of ports) {
      if (await this.isPortInUse(port)) taken.push(port);
    }
    return taken;
  }

  /** Ask docker to resolve the file; fall back to reading it if that fails. */
  private async publishedPorts(projectDir: string, composeFile: string): Promise<number[]> {
    const ports = new Set<number>();
    try {
      const { stdout } = await execa('docker', ['compose', '-f', composeFile, 'config', '--format', 'json'],
        { cwd: projectDir, timeout: 15000 });
      for (const service of Object.values(JSON.parse(stdout).services || {}) as any[]) {
        for (const entry of service.ports || []) {
          const published = Number(entry?.published ?? entry);
          if (Number.isInteger(published) && published > 0) ports.add(published);
        }
      }
      return [...ports];
    } catch { /* older docker, or an unresolvable file */ }

    try {
      const raw = await fs.readFile(composeFile, 'utf-8');
      for (const match of raw.matchAll(/^\s*-\s*["']?(?:\d+\.\d+\.\d+\.\d+:)?(\d+):\d+/gm)) {
        ports.add(Number(match[1]));
      }
    } catch { /* unreadable: assume no ports rather than blocking */ }
    return [...ports];
  }

  private isPortInUse(port: number): Promise<boolean> {
    return new Promise(resolve => {
      const server = net.createServer();
      server.once('error', (error: any) => resolve(error?.code === 'EADDRINUSE'));
      server.once('listening', () => server.close(() => resolve(false)));
      server.listen(port, '127.0.0.1');
    });
  }

  private async getComposeFile(projectDir: string): Promise<string | null> {
    const composePath = path.join(projectDir, 'docker-compose.yml');
    const composeAltPath = path.join(projectDir, 'compose.yml');

    try {
      await fs.access(composePath);
      return composePath;
    } catch {
      try {
        await fs.access(composeAltPath);
        return composeAltPath;
      } catch {
        return null;
      }
    }
  }
}
