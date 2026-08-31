import pino, { DestinationStream, Logger, LoggerOptions } from 'pino';

const usePretty = process.stdout.isTTY && process.env.NODE_ENV !== 'test';

const coinbaseCredentialFields = [
  'CDP_API_KEY_ID',
  'CDP_API_KEY_SECRET',
  'CDP_WALLET_SECRET',
  'cdpApiKeyId',
  'cdpApiKeySecret',
  'cdpWalletSecret',
  'apiKeyId',
  'apiKeySecret',
  'walletSecret',
];

export const CENSOR = '[REDACTED]';

/**
 * Credential-shaped keys, compared case-insensitively. A CDP or Axios error can
 * nest its config, headers, and auth several levels below the logged object, and
 * a child logger's bindings add more, so redaction here is by key name at any
 * depth rather than by a fixed set of Pino paths. `fast-redact`'s `*` matches
 * exactly one level and has no recursive wildcard, so path-based redaction
 * always has a cliff — see MAX_REDACTION_DEPTH for the only bound that remains.
 */
const CREDENTIAL_KEYS = new Set(coinbaseCredentialFields.map((field) => field.toLowerCase()));

/**
 * Walk bound purely as a guard against pathological or adversarial nesting; it is
 * not a redaction cliff in the way the old `*.*.*.field` path list was. Objects
 * deeper than this are emitted unchanged, so keep it comfortably above the
 * deepest shape we expect to log (SDK error -> config -> headers -> auth).
 */
export const MAX_REDACTION_DEPTH = 12;

function isCredentialKey(key: string): boolean {
  return CREDENTIAL_KEYS.has(key.toLowerCase());
}

/**
 * Returns a redacted copy, or the original value when nothing matched, so the
 * common path allocates nothing. `onPath` tracks the objects on the current walk
 * so a true cycle terminates; Pino renders those as `[Circular]` itself, and this
 * matches that rendering rather than re-emitting the unredacted object.
 */
function redactDeep(value: unknown, onPath: Set<object>, depth: number): unknown {
  if (depth > MAX_REDACTION_DEPTH) return value;
  if (value === null || typeof value !== 'object') return value;

  const object = value as object;
  if (onPath.has(object)) return '[Circular]';
  onPath.add(object);

  try {
    if (Array.isArray(value)) {
      let changed = false;
      const next = value.map((entry) => {
        const redacted = redactDeep(entry, onPath, depth + 1);
        if (redacted !== entry) changed = true;
        return redacted;
      });
      return changed ? next : value;
    }

    // An Error's message and stack are non-enumerable, so only its enumerable own
    // properties can be walked -- which are also the only ones JSON serialization
    // would have emitted.
    const source = value instanceof Error ? { ...value } : (value as Record<string, unknown>);

    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(source)) {
      if (isCredentialKey(key)) {
        next[key] = CENSOR;
        changed = true;
        continue;
      }
      const redacted = redactDeep(entry, onPath, depth + 1);
      if (redacted !== entry) changed = true;
      next[key] = redacted;
    }

    if (!changed) return value;

    if (value instanceof Error) {
      // Clone through property descriptors so the non-enumerable message and
      // stack survive for Pino's error serializer.
      const clone = Object.create(
        Object.getPrototypeOf(value),
        Object.getOwnPropertyDescriptors(value),
      ) as Record<string, unknown>;
      for (const [key, entry] of Object.entries(next)) {
        Object.defineProperty(clone, key, {
          value: entry,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return clone;
    }

    return next;
  } finally {
    onPath.delete(object);
  }
}

/**
 * Exported so a caller binding dynamic configuration to a child logger can
 * censor it first: `logger.child(redactCredentials(config))`, since bindings
 * passed to `child()` do not pass through `formatters.log`.
 */
export function redactCredentials<T>(value: T): T {
  return redactDeep(value, new Set<object>(), 0) as T;
}

const options: LoggerOptions = {
  level: process.env.LOG_LEVEL ?? 'info',
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers["stripe-signature"]',
      'req.headers["x-worker-key"]',
    ],
    censor: CENSOR,
  },
  formatters: {
    // Runs before serializers and receives the merged log object, so every
    // credential-shaped key in anything passed to a log call is censored at any
    // depth -- which is the case the old finite path list could not reach.
    log(object) {
      return redactCredentials(object);
    },
    // Covers the root logger's bindings only. Pino serializes the bindings passed
    // to `child()` once at creation and never routes them through a formatter, so
    // those are not walked; `redactCredentials` is the caller-side escape hatch,
    // and every `child()` call in this repo binds a static { module } string.
    //
    // Overriding `child` to close that gap was tried and rejected: app.ts hands
    // this instance to Fastify as `loggerInstance`, Fastify builds its
    // per-request logger through `child()`, and shadowing it drops Fastify's own
    // req/res serializers -- which silently turned the redact paths above into
    // no-ops and dumped raw request objects into the log.
    bindings(bindings) {
      return redactCredentials(bindings);
    },
  },
  serializers: {
    err: (error: unknown) => redactCredentials(pino.stdSerializers.err(error as Error)),
  },
};

export function createLogger(destination?: DestinationStream): Logger {
  return destination ? pino(options, destination) : pino(options);
}

export const logger = usePretty
  ? pino(options, pino.transport({ target: 'pino-pretty', options: { colorize: true } }))
  : createLogger();
