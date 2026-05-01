import { execSync, spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { log, spinner as clackSpinner } from '@clack/prompts';
import color from 'picocolors';

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

export function projectPath(...segments: string[]): string {
  return path.join(PROJECT_ROOT, ...segments);
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export function exec(cmd: string, opts?: { cwd?: string; timeout?: number; env?: Record<string, string> }): ExecResult {
  try {
    const stdout = execSync(cmd, {
      cwd: opts?.cwd ?? PROJECT_ROOT,
      timeout: opts?.timeout ?? 30_000,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
      ...(opts?.env ? { env: { ...process.env, ...opts.env } } : {}),
    });
    return { stdout: stdout.trim(), stderr: '', code: 0 };
  } catch (err: any) {
    return {
      stdout: (err.stdout ?? '').toString().trim(),
      stderr: (err.stderr ?? '').toString().trim(),
      code: err.status ?? 1,
    };
  }
}

export function spawnDetached(
  cmd: string,
  args: string[],
  opts?: { cwd?: string; env?: Record<string, string> },
): ChildProcess {
  const child = spawn(cmd, args, {
    cwd: opts?.cwd ?? PROJECT_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: opts?.env ? { ...process.env, ...opts.env } : process.env,
    detached: true,
  });
  child.unref();
  return child;
}

export function commandExists(cmd: string): boolean {
  const { code } = exec(`which ${cmd}`);
  return code === 0;
}

export function detectOS(): { os: 'darwin' | 'linux'; hasBrew: boolean; hasApt: boolean } {
  const platform = os.platform() === 'darwin' ? 'darwin' : 'linux';
  return {
    os: platform,
    hasBrew: commandExists('brew'),
    hasApt: commandExists('apt-get'),
  };
}

export function generateRandomHex(bytes: number): string {
  return require('crypto').randomBytes(bytes).toString('hex');
}

export function readEnvFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};
  const content = fs.readFileSync(filePath, 'utf-8');
  const vars: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    vars[key] = value;
  }
  return vars;
}

export function writeEnvFile(
  envPath: string,
  vars: Record<string, string>,
  templatePath: string,
): void {
  const template = fs.readFileSync(templatePath, 'utf-8');
  const lines = template.split('\n');
  const output: string[] = [];

  const written = new Set<string>();

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      output.push(line);
      continue;
    }
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) {
      output.push(line);
      continue;
    }
    const key = trimmed.slice(0, eqIdx).trim();
    if (key in vars) {
      output.push(`${key}=${vars[key]}`);
      written.add(key);
    } else {
      output.push(line);
    }
  }

  // Append any vars not present in the template
  for (const [key, value] of Object.entries(vars)) {
    if (!written.has(key)) {
      output.push(`${key}=${value}`);
    }
  }

  fs.writeFileSync(envPath, output.join('\n'), 'utf-8');
}

export async function pollUntil(
  check: () => boolean | Promise<boolean>,
  opts: { intervalMs: number; timeoutMs: number; label: string },
): Promise<boolean> {
  const s = clackSpinner();
  s.start(opts.label);
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    const ok = await check();
    if (ok) {
      s.stop(`${opts.label} — ready`);
      return true;
    }
    await sleep(opts.intervalMs);
  }
  s.stop(`${opts.label} — timed out`);
  return false;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const PLACEHOLDER_VALUES = new Set([
  'sk_test_placeholder',
  'whsec_placeholder',
  '',
]);

export function isPlaceholder(value: string | undefined): boolean {
  return !value || PLACEHOLDER_VALUES.has(value);
}

/**
 * Run a command with real-time output streaming. Unlike exec(), this shows
 * output as it happens (good for long-running commands like test suites).
 * Returns a promise with the exit code and captured output.
 */
export function execStreaming(
  cmd: string,
  args: string[],
  opts?: { cwd?: string; timeout?: number; env?: Record<string, string> },
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts?.cwd ?? PROJECT_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: opts?.env ? { ...process.env, ...opts.env } : process.env,
      shell: true,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = opts?.timeout
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
        }, opts.timeout)
      : null;

    child.stdout?.on('data', (data: Buffer) => {
      const text = data.toString();
      stdout += text;
      process.stdout.write(text);
    });

    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString();
      stderr += text;
      process.stderr.write(text);
    });

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        code: timedOut ? 124 : (code ?? 1),
      });
    });

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({ stdout: stdout.trim(), stderr: err.message, code: 1 });
    });
  });
}

// ── Sub-step rendering ────────────────────────────────────────────

export interface SubStep {
  icon: string;
  label: string;
  detail: string;
}

export function subStepPass(label: string, detail: string): SubStep {
  return { icon: color.green('✓'), label, detail };
}

export function subStepFail(label: string, detail: string): SubStep {
  return { icon: color.red('✗'), label, detail };
}

export function subStepWarn(label: string, detail: string): SubStep {
  return { icon: color.yellow('▲'), label, detail };
}

export function subStepSkip(label: string, detail: string): SubStep {
  return { icon: color.dim('○'), label, detail };
}

/**
 * Render sub-steps as indented lines on the clack │ bar.
 * Call this after a spinner stops to show individual results
 * grouped under the parent step.
 */
export function logSubSteps(steps: SubStep[]): void {
  if (steps.length === 0) return;
  const labelWidth = Math.max(...steps.map((s) => s.label.length), 12);
  const lines = steps.map((s) => {
    const padded = s.label + ' '.repeat(Math.max(0, labelWidth - s.label.length));
    return `  ${s.icon} ${padded}  ${color.dim(s.detail)}`;
  });
  log.message(lines.join('\n'), { symbol: color.gray('│') });
}
