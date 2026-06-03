import { execa } from 'execa';
import path from 'node:path';
import fs from 'node:fs/promises';

export interface VerifyResult {
  passed: boolean;
  logs: string;
}

export class DockerVerifier {
  async detect(): Promise<boolean> {
    try {
      await execa('docker', ['compose', 'version'], { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  async verify(projectDir: string): Promise<VerifyResult> {
    const composePath = path.join(projectDir, 'docker-compose.yml');
    const composeAltPath = path.join(projectDir, 'compose.yml');

    let composeFile: string;
    try {
      await fs.access(composePath);
      composeFile = composePath;
    } catch {
      try {
        await fs.access(composeAltPath);
        composeFile = composeAltPath;
      } catch {
        return { passed: false, logs: 'No docker-compose.yml or compose.yml found in project root.' };
      }
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

      // Check for crashed containers
      const psOutput = ps.stdout || '';
      const hasCrashed = psOutput.includes('"exited"') || psOutput.includes('"dead"');
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
        const file = composeFile;
        await execa('docker', ['compose', '-f', file, 'down', '--volumes', '--remove-orphans'],
          { cwd: projectDir, timeout: 30000 });
      } catch {}
    }
  }
}
