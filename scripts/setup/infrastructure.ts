import net from 'net';
import { log, select, isCancel } from '@clack/prompts';
import { SetupContext } from './types';
import { exec, pollUntil } from './utils';

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

interface PortInfo {
  inUse: boolean;
  pid: string | null;
  process: string | null;
  isDockerInternal: boolean;
  isDockerContainer: boolean;
  containerName: string | null;
}

const DOCKER_PROCESS_PATTERNS = [
  'com.docker',
  'docker-proxy',
  'dockerd',
  'containerd',
  'vpnkit',
  'Docker Desktop',
];

/**
 * Check if a port is in use by attempting a TCP connect.
 * This is reliable regardless of how the process binds (works for
 * native Postgres, Docker, etc. on macOS and Linux).
 */
function isPortListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(1000);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => {
      resolve(false);
    });
    socket.connect(port, '127.0.0.1');
  });
}

/**
 * Try to identify what's using a port via lsof. This may return no results
 * on macOS for some processes — callers should not rely on this as the
 * sole port-in-use check.
 */
function identifyPortProcess(port: number): Omit<PortInfo, 'inUse'> {
  const result = exec(`lsof -i :${port} -t 2>/dev/null`);
  if (result.code !== 0 || !result.stdout.trim()) {
    return { pid: null, process: null, isDockerInternal: false, isDockerContainer: false, containerName: null };
  }

  const pid = result.stdout.trim().split('\n')[0];
  const psResult = exec(`ps -p ${pid} -o command= 2>/dev/null`);
  const fullCommand = psResult.code === 0 ? psResult.stdout.trim() : 'unknown';

  const psShort = exec(`ps -p ${pid} -o comm= 2>/dev/null`);
  const processName = psShort.code === 0 ? psShort.stdout.trim() : 'unknown';

  const isDockerInternal = DOCKER_PROCESS_PATTERNS.some(
    (p) => fullCommand.toLowerCase().includes(p.toLowerCase()),
  );

  let isDockerContainer = false;
  let containerName: string | null = null;

  if (fullCommand.includes('docker-proxy') || isDockerInternal) {
    const containerCheck = exec(
      `docker ps --filter "publish=${port}" --format "{{.Names}}" 2>/dev/null`,
    );
    if (containerCheck.code === 0 && containerCheck.stdout.trim()) {
      isDockerContainer = true;
      containerName = containerCheck.stdout.trim().split('\n')[0];
    }
  }

  return { pid, process: processName, isDockerInternal, isDockerContainer, containerName };
}

function findFreePort(startPort: number): number {
  // Use a synchronous connect check via exec for simplicity in this sync context
  for (let port = startPort + 1; port < startPort + 100; port++) {
    const result = exec(`nc -z 127.0.0.1 ${port} 2>/dev/null`);
    if (result.code !== 0) return port; // nc fails = port is free
  }
  return startPort + 1;
}

async function offerPortResolution(
  ctx: SetupContext,
  port: number,
  serviceName: string,
): Promise<{ resolved: boolean; newPort?: number }> {
  const processInfo = identifyPortProcess(port);

  // Build description
  let description: string;
  if (processInfo.isDockerContainer && processInfo.containerName) {
    description = `Docker container "${processInfo.containerName}"`;
  } else if (processInfo.isDockerInternal) {
    description = `Docker Desktop (internal process)`;
  } else if (processInfo.pid) {
    description = `${processInfo.process || 'unknown'} (PID ${processInfo.pid})`;
  } else {
    description = 'another process (could not identify — possibly a native service like Postgres.app or Homebrew Postgres)';
  }

  log.warn(`Port ${port} is in use by ${description}`);

  if (ctx.nonInteractive) {
    return { resolved: false };
  }

  const freePort = findFreePort(port);

  type Action = 'stop-container' | 'kill' | 'remap' | 'skip';
  const options: Array<{ value: Action; label: string }> = [];

  if (processInfo.isDockerContainer && processInfo.containerName) {
    options.push({
      value: 'stop-container',
      label: `Stop container "${processInfo.containerName}" (docker stop)`,
    });
  } else if (processInfo.isDockerInternal) {
    log.info('This port is managed by Docker Desktop — it cannot be stopped individually.');
  } else if (processInfo.pid) {
    options.push({
      value: 'kill',
      label: `Stop the process (kill PID ${processInfo.pid} — ${processInfo.process || 'unknown'})`,
    });
  }
  // Remap is always available
  options.push({
    value: 'remap',
    label: `Use port ${freePort} instead for ${serviceName}`,
  });
  options.push({
    value: 'skip',
    label: 'Skip — I\'ll fix it myself',
  });

  const action = await select({
    message: `Port ${port} (${serviceName}) is occupied. What would you like to do?`,
    options,
  });

  if (isCancel(action) || action === 'skip') {
    return { resolved: false };
  }

  if (action === 'stop-container' && processInfo.containerName) {
    log.info(`Stopping container "${processInfo.containerName}"...`);
    const stop = exec(`docker stop ${processInfo.containerName}`, { timeout: 15_000 });
    if (stop.code !== 0) {
      log.warn(`Could not stop container: ${stop.stderr}`);
      return { resolved: false };
    }
    await new Promise((r) => setTimeout(r, 1500));
    if (await isPortListening(port)) {
      log.warn(`Port ${port} still in use after stopping container`);
      return { resolved: false };
    }
    log.success(`Port ${port} is now free`);
    return { resolved: true };
  }

  if (action === 'kill' && processInfo.pid) {
    log.info(`Stopping PID ${processInfo.pid}...`);
    const kill = exec(`kill ${processInfo.pid}`);
    if (kill.code !== 0) {
      log.warn(`Could not stop PID ${processInfo.pid}. Try: sudo kill ${processInfo.pid}`);
      return { resolved: false };
    }
    await new Promise((r) => setTimeout(r, 1500));
    if (await isPortListening(port)) {
      log.warn(`Port ${port} still in use after killing PID ${processInfo.pid}`);
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

function applyPortRemap(
  ctx: SetupContext,
  composeService: string,
  originalPort: number,
  newPort: number,
): void {
  if (composeService === 'postgres') {
    ctx.envVars.DATABASE_URL = ctx.envVars.DATABASE_URL.replace(
      `:${originalPort}/`,
      `:${newPort}/`,
    );
  } else if (composeService === 'redis') {
    ctx.envVars.REDIS_URL = ctx.envVars.REDIS_URL.replace(
      `:${originalPort}`,
      `:${newPort}`,
    );
  }
}

/**
 * Build environment variables for docker compose that override host ports.
 * The docker-compose.yml uses ${POSTGRES_HOST_PORT:-5432} and ${REDIS_HOST_PORT:-6379}.
 */
function buildComposeEnv(portOverrides: Array<{ hostPort: number; containerPort: number; service: string }>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const { hostPort, service } of portOverrides) {
    if (service === 'postgres') env.POSTGRES_HOST_PORT = String(hostPort);
    if (service === 'redis') env.REDIS_HOST_PORT = String(hostPort);
  }
  return env;
}

function runCompose(cmd: string, composeEnv: Record<string, string>, timeout = 60_000) {
  return exec(cmd, { timeout, env: composeEnv });
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

  const services: Array<{ name: string; port: number; composeService: string }> = [
    { name: 'PostgreSQL', port: 5432, composeService: 'postgres' },
    { name: 'Redis', port: 6379, composeService: 'redis' },
  ];

  const portOverrides: Array<{ hostPort: number; containerPort: number; service: string }> = [];

  // Pre-flight port check using TCP connect (catches everything lsof misses)
  for (const svc of services) {
    if (isContainerRunning(svc.composeService)) continue;

    const listening = await isPortListening(svc.port);
    if (!listening) continue;

    const result = await offerPortResolution(ctx, svc.port, svc.name);

    if (!result.resolved) {
      ctx.results.push({
        name: svc.name,
        status: 'fail',
        message: `Port ${svc.port} is in use — resolve the conflict and re-run setup`,
      });
      continue;
    }

    if (result.newPort) {
      portOverrides.push({ hostPort: result.newPort, containerPort: svc.port, service: svc.composeService });
      applyPortRemap(ctx, svc.composeService, svc.port, result.newPort);
      log.info(`${svc.name} will use host port ${result.newPort} → container port ${svc.port}`);
    }
  }

  // If any ports are still unresolved, bail
  if (ctx.results.some((r) => r.status === 'fail' && r.message.includes('Port'))) {
    return;
  }

  // Build env vars for port overrides (docker-compose.yml uses
  // ${POSTGRES_HOST_PORT:-5432} and ${REDIS_HOST_PORT:-6379})
  const composeEnv = buildComposeEnv(portOverrides);

  // Force-recreate if ports were remapped so containers pick up new bindings
  if (portOverrides.length > 0) {
    const remappedServices = portOverrides.map((o) => o.service).join(' ');
    log.info('Recreating containers to apply new port mappings...');
    runCompose(`docker compose rm -f -s ${remappedServices}`, composeEnv, 15_000);
  }

  const composeCmd = portOverrides.length > 0
    ? 'docker compose up -d --force-recreate'
    : 'docker compose up -d';
  const up = runCompose(composeCmd, composeEnv);
  if (up.code !== 0) {
    const stderr = up.stderr || up.stdout;

    // If docker compose reports a port conflict we missed, offer resolution
    const portMatch = stderr.match(/(\d+): bind: address already in use/);
    if (portMatch) {
      const conflictPort = parseInt(portMatch[1], 10);
      const svc = services.find((s) => s.port === conflictPort);
      const svcName = svc?.name || `port ${conflictPort}`;

      const result = await offerPortResolution(ctx, conflictPort, svcName);

      if (result.resolved && result.newPort && svc) {
        portOverrides.push({ hostPort: result.newPort, containerPort: svc.port, service: svc.composeService });
        applyPortRemap(ctx, svc.composeService, svc.port, result.newPort);
        const retryEnv = buildComposeEnv(portOverrides);

        runCompose(`docker compose rm -f -s ${svc.composeService}`, retryEnv, 15_000);
        const retry = runCompose('docker compose up -d --force-recreate', retryEnv);
        if (retry.code !== 0) {
          log.error(`docker compose up failed on retry: ${retry.stderr}`);
          ctx.results.push({ name: svcName, status: 'fail', message: 'docker compose up failed after port remap' });
          return;
        }
      } else {
        ctx.results.push({
          name: svcName,
          status: 'fail',
          message: `Port ${conflictPort} conflict — stop the process using it or re-run setup`,
        });
        return;
      }
    } else {
      log.error(`docker compose up failed: ${stderr}`);
      ctx.results.push({ name: 'PostgreSQL', status: 'fail', message: 'docker compose up failed' });
      ctx.results.push({ name: 'Redis', status: 'fail', message: 'docker compose up failed' });
      return;
    }
  }

  // Health checks
  const pgPort = ctx.envVars.DATABASE_URL?.match(/:(\d+)\//)?.[1] || '5432';
  const redisPort = ctx.envVars.REDIS_URL?.match(/:(\d+)$/)?.[1] || '6379';

  const pgReady = await pollUntil(
    () => runCompose('docker compose exec -T postgres pg_isready -U postgres', composeEnv, 5000).code === 0,
    { intervalMs: 1000, timeoutMs: 30_000, label: 'Waiting for PostgreSQL' },
  );
  ctx.results.push({
    name: 'PostgreSQL',
    status: pgReady ? 'pass' : 'fail',
    message: pgReady ? `Healthy (port ${pgPort})` : 'Timed out — check `docker compose logs postgres`',
  });

  const redisReady = await pollUntil(
    () => runCompose('docker compose exec -T redis redis-cli ping', composeEnv, 5000).stdout.includes('PONG'),
    { intervalMs: 1000, timeoutMs: 15_000, label: 'Waiting for Redis' },
  );
  ctx.results.push({
    name: 'Redis',
    status: redisReady ? 'pass' : 'fail',
    message: redisReady ? `Healthy (port ${redisPort})` : 'Timed out — check `docker compose logs redis`',
  });

  // Persist env changes if ports were remapped
  if (portOverrides.length > 0) {
    const { writeEnvFile, projectPath } = require('./utils');
    writeEnvFile(ctx.envPath, ctx.envVars, projectPath('.env.example'));
    log.success('Updated .env with remapped ports');
  }
}
