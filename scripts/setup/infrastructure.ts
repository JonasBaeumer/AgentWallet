import { log, confirm, select, isCancel } from '@clack/prompts';
import { SetupContext } from './types';
import { exec, pollUntil } from './utils';
import net from 'net';

interface PortConflict {
  port: number;
  service: string;
  pid: string | null;
  process: string | null;
}

function isContainerRunning(serviceName: string): boolean {
  const result = exec(`docker compose ps --format json ${serviceName}`);
  if (result.code !== 0) return false;
  for (const line of result.stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.State === 'running') return true;
    } catch {
      if (line.toLowerCase().includes('running')) return true;
    }
  }
  return false;
}

function isPortInUse(port: number): boolean {
  return new Promise<boolean>((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(true));
    server.once('listening', () => {
      server.close();
      resolve(false);
    });
    server.listen(port, '0.0.0.0');
  }) as any; // sync check below
}

function checkPortSync(port: number): { inUse: boolean; pid: string | null; process: string | null } {
  const result = exec(`lsof -i :${port} -t 2>/dev/null`);
  if (result.code !== 0 || !result.stdout.trim()) {
    return { inUse: false, pid: null, process: null };
  }

  const pid = result.stdout.trim().split('\n')[0];
  const psResult = exec(`ps -p ${pid} -o comm= 2>/dev/null`);
  const processName = psResult.code === 0 ? psResult.stdout.trim() : 'unknown';

  return { inUse: true, pid, process: processName };
}

function findFreePort(startPort: number): number {
  for (let port = startPort + 1; port < startPort + 100; port++) {
    const { inUse } = checkPortSync(port);
    if (!inUse) return port;
  }
  return startPort + 1;
}

async function resolvePortConflict(
  ctx: SetupContext,
  port: number,
  serviceName: string,
): Promise<{ resolved: boolean; newPort?: number }> {
  const { pid, process: processName } = checkPortSync(port);

  if (!pid) {
    return { resolved: false };
  }

  log.warn(
    `Port ${port} is in use by ${processName || 'unknown'} (PID ${pid})`,
  );

  if (ctx.nonInteractive) {
    return { resolved: false };
  }

  const freePort = findFreePort(port);

  const action = await select({
    message: `Port ${port} (${serviceName}) is occupied. What would you like to do?`,
    options: [
      {
        value: 'kill',
        label: `Stop the process (kill PID ${pid} — ${processName || 'unknown'})`,
      },
      {
        value: 'remap',
        label: `Use port ${freePort} instead for ${serviceName}`,
      },
      {
        value: 'skip',
        label: 'Skip — I\'ll fix it myself',
      },
    ],
  });

  if (isCancel(action) || action === 'skip') {
    return { resolved: false };
  }

  if (action === 'kill') {
    log.info(`Stopping PID ${pid}...`);
    const kill = exec(`kill ${pid}`);
    if (kill.code !== 0) {
      log.warn(`Could not stop PID ${pid}. Try: sudo kill ${pid}`);
      return { resolved: false };
    }
    // Give it a moment to release the port
    await new Promise((r) => setTimeout(r, 1500));
    const recheck = checkPortSync(port);
    if (recheck.inUse) {
      log.warn(`Port ${port} still in use after killing PID ${pid}`);
      return { resolved: false };
    }
    log.success(`Port ${port} is now free`);
    return { resolved: true };
  }

  if (action === 'remap') {
    return { resolved: true, newPort: freePort };
  }

  return { resolved: false };
}

export async function startInfrastructure(ctx: SetupContext): Promise<void> {
  log.info('Starting infrastructure...');

  const pgRunning = isContainerRunning('postgres');
  const redisRunning = isContainerRunning('redis');

  if (pgRunning && redisRunning) {
    log.info('Docker containers already running — skipping');
    ctx.results.push({ name: 'PostgreSQL', status: 'pass', message: 'Already running' });
    ctx.results.push({ name: 'Redis', status: 'pass', message: 'Already running' });
    return;
  }

  // Check for port conflicts before starting
  const services: Array<{ name: string; port: number; composeService: string }> = [
    { name: 'PostgreSQL', port: 5432, composeService: 'postgres' },
    { name: 'Redis', port: 6379, composeService: 'redis' },
  ];

  let portOverrides: string[] = [];

  for (const svc of services) {
    if (isContainerRunning(svc.composeService)) continue;

    const { inUse } = checkPortSync(svc.port);
    if (!inUse) continue;

    const result = await resolvePortConflict(ctx, svc.port, svc.name);

    if (!result.resolved) {
      ctx.results.push({
        name: svc.name,
        status: 'fail',
        message: `Port ${svc.port} is in use — resolve the conflict and re-run setup`,
      });
      // Don't return yet — check all ports first
      continue;
    }

    if (result.newPort) {
      portOverrides.push(`${result.newPort}:${svc.port}`);
      log.info(`${svc.name} will use host port ${result.newPort} → container port ${svc.port}`);

      // Update DATABASE_URL or REDIS_URL in envVars to reflect new port
      if (svc.composeService === 'postgres') {
        ctx.envVars.DATABASE_URL = ctx.envVars.DATABASE_URL.replace(
          `:${svc.port}/`,
          `:${result.newPort}/`,
        );
      } else if (svc.composeService === 'redis') {
        ctx.envVars.REDIS_URL = ctx.envVars.REDIS_URL.replace(
          `:${svc.port}`,
          `:${result.newPort}`,
        );
      }
    }
  }

  // If any ports are still unresolved, bail
  const portFails = ctx.results.filter(
    (r) => r.status === 'fail' && r.message.includes('Port'),
  );
  if (portFails.length > 0) {
    return;
  }

  // Build docker compose command with port overrides if needed
  let composeCmd = 'docker compose up -d';
  if (portOverrides.length > 0) {
    // Use environment variable overrides for port remapping
    // docker compose allows overriding ports via command line
    const overrideArgs = portOverrides
      .map((o) => {
        const [hostPort, containerPort] = o.split(':');
        if (containerPort === '5432') return `-e POSTGRES_PORT=${hostPort}`;
        if (containerPort === '6379') return `-e REDIS_PORT=${hostPort}`;
        return '';
      })
      .filter(Boolean);

    if (overrideArgs.length > 0) {
      // For port remapping, we need to use docker compose with --scale or override files
      // The simplest reliable approach: create a temporary override
      const overrideLines = ['version: "3.9"', 'services:'];
      for (const o of portOverrides) {
        const [hostPort, containerPort] = o.split(':');
        if (containerPort === '5432') {
          overrideLines.push('  postgres:', `    ports:`, `      - "${hostPort}:5432"`);
        }
        if (containerPort === '6379') {
          overrideLines.push('  redis:', `    ports:`, `      - "${hostPort}:6379"`);
        }
      }

      const fs = require('fs');
      const path = require('path');
      const overridePath = path.resolve(__dirname, '..', '..', 'docker-compose.override.yml');
      fs.writeFileSync(overridePath, overrideLines.join('\n') + '\n');
      log.info('Created docker-compose.override.yml with remapped ports');
    }
  }

  // Start containers
  const up = exec(composeCmd, { timeout: 60_000 });
  if (up.code !== 0) {
    const stderr = up.stderr;

    // Check if it's a port conflict we didn't catch
    const portMatch = stderr.match(/(\d+): bind: address already in use/);
    if (portMatch) {
      const conflictPort = parseInt(portMatch[1], 10);
      log.error(`Port ${conflictPort} is still in use`);
      ctx.results.push({
        name: 'Infrastructure',
        status: 'fail',
        message: `Port ${conflictPort} conflict — stop the process using it or re-run setup to pick a different port`,
      });
    } else {
      log.error(`docker compose up failed: ${stderr}`);
      ctx.results.push({ name: 'PostgreSQL', status: 'fail', message: 'docker compose up failed' });
      ctx.results.push({ name: 'Redis', status: 'fail', message: 'docker compose up failed' });
    }
    return;
  }

  // Determine which ports to health-check
  const pgPort = ctx.envVars.DATABASE_URL?.match(/:(\d+)\//)?.[1] || '5432';
  const redisPort = ctx.envVars.REDIS_URL?.match(/:(\d+)$/)?.[1] || '6379';

  // Health-check Postgres
  const pgReady = await pollUntil(
    () => exec('docker compose exec -T postgres pg_isready -U postgres').code === 0,
    { intervalMs: 1000, timeoutMs: 30_000, label: 'Waiting for PostgreSQL' },
  );
  ctx.results.push({
    name: 'PostgreSQL',
    status: pgReady ? 'pass' : 'fail',
    message: pgReady ? `Healthy (port ${pgPort})` : 'Timed out — check `docker compose logs postgres`',
  });

  // Health-check Redis
  const redisReady = await pollUntil(
    () => exec('docker compose exec -T redis redis-cli ping').stdout.includes('PONG'),
    { intervalMs: 1000, timeoutMs: 15_000, label: 'Waiting for Redis' },
  );
  ctx.results.push({
    name: 'Redis',
    status: redisReady ? 'pass' : 'fail',
    message: redisReady ? `Healthy (port ${redisPort})` : 'Timed out — check `docker compose logs redis`',
  });

  // If ports were remapped, update .env file
  if (portOverrides.length > 0) {
    const { writeEnvFile, projectPath } = require('./utils');
    writeEnvFile(ctx.envPath, ctx.envVars, projectPath('.env.example'));
    log.success('Updated .env with remapped ports');
  }
}
