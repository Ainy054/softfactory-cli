import { execa } from 'execa';
import path from 'node:path';
import fs from 'node:fs/promises';

export interface VerifyResult {
  passed: boolean;
  logs: string;
}

export class DockerVerifier {
  private provisionedServices: string[] = [];
  private composeFile: string | null = null;

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

  async ensureTestServicesRunning(projectDir: string, onOutput?: (msg: string) => void): Promise<boolean> {
    const composeFile = await this.getComposeFile(projectDir);
    if (!composeFile) return false;
    this.composeFile = composeFile;

    try {
      const content = await fs.readFile(composeFile, 'utf-8');

      // Candidate database / cache services used during testing
      const candidateServices = ['postgres_test', 'db_test', 'postgres', 'redis', 'mysql', 'mariadb', 'mongo'];
      const targetServices: string[] = [];

      for (const s of candidateServices) {
        const regex = new RegExp(`^\\s{2}${s}:`, 'm');
        if (regex.test(content) && !targetServices.includes(s)) {
          targetServices.push(s);
        }
      }

      // If postgres_test exists, prefer postgres_test (+ redis if available)
      const servicesToStart = targetServices.includes('postgres_test')
        ? targetServices.filter(s => s === 'postgres_test' || s === 'redis')
        : targetServices;

      if (servicesToStart.length === 0) return false;

      onOutput?.(`[Docker] Provisioning test services: ${servicesToStart.join(', ')}...`);

      await execa('docker', ['compose', '-f', composeFile, 'up', '-d', ...servicesToStart], {
        cwd: projectDir,
        timeout: 60000,
      });

      this.provisionedServices = servicesToStart;

      // Wait 3 seconds for containers to be ready
      await new Promise(r => setTimeout(r, 3000));
      onOutput?.(`[Docker] Test services ready (${servicesToStart.join(', ')})`);
      return true;
    } catch (e: any) {
      onOutput?.(`[Docker] Warning: Could not start test services: ${e.message}`);
      return false;
    }
  }

  async stopTestServices(projectDir: string): Promise<void> {
    if (!this.composeFile || this.provisionedServices.length === 0) return;

    try {
      await execa('docker', ['compose', '-f', this.composeFile, 'stop', ...this.provisionedServices], {
        cwd: projectDir,
        timeout: 30000,
        reject: false,
      });
    } catch {}
  }

  async verify(projectDir: string): Promise<VerifyResult> {
    const composeFile = await this.getComposeFile(projectDir);
    if (!composeFile) {
      return { passed: false, logs: 'No docker-compose.yml or compose.yml found in project root.' };
    }

    const logs: string[] = [];

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
