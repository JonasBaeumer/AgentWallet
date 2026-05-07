import { getRedisClient } from '@/config/redis';

const KEY_PREFIX = 'telegram_signup:';
const DEFAULT_TTL_SECONDS = 600; // 10 minutes

export interface SignupSession {
  step: 'awaiting_confirmation' | 'awaiting_email';
  agentId: string;
  pairingCode: string;
  // message_ids of every bot-sent and user-sent message during signup,
  // bulk-deleted on success or when a stale session is replaced by a new /start.
  messageIds?: number[];
}

export async function getSignupSession(chatId: number | string): Promise<SignupSession | null> {
  const redis = getRedisClient();
  const raw = await redis.get(`${KEY_PREFIX}${chatId}`);
  if (!raw) return null;
  return JSON.parse(raw) as SignupSession;
}

export async function setSignupSession(
  chatId: number | string,
  session: SignupSession,
  ttlSeconds = DEFAULT_TTL_SECONDS,
): Promise<void> {
  const redis = getRedisClient();
  await redis.set(`${KEY_PREFIX}${chatId}`, JSON.stringify(session), 'EX', ttlSeconds);
}

export async function clearSignupSession(chatId: number | string): Promise<void> {
  const redis = getRedisClient();
  await redis.del(`${KEY_PREFIX}${chatId}`);
}

// ── Preferences session (custom TTL input) ────────────────────────────────────

const PREF_KEY_PREFIX = 'telegram_pref:';
const PREF_TTL_SECONDS = 300; // 5 minutes to reply with a number

export interface PrefSession {
  awaitingCustomTtl: true;
  promptMessageId?: number;
}

export async function getPrefSession(chatId: number | string): Promise<PrefSession | null> {
  const redis = getRedisClient();
  const raw = await redis.get(`${PREF_KEY_PREFIX}${chatId}`);
  if (!raw) return null;
  return JSON.parse(raw) as PrefSession;
}

export async function setPrefSession(chatId: number | string, session: PrefSession): Promise<void> {
  const redis = getRedisClient();
  await redis.set(`${PREF_KEY_PREFIX}${chatId}`, JSON.stringify(session), 'EX', PREF_TTL_SECONDS);
}

export async function clearPrefSession(chatId: number | string): Promise<void> {
  const redis = getRedisClient();
  await redis.del(`${PREF_KEY_PREFIX}${chatId}`);
}
