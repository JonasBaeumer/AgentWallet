import { getRedisClient } from '@/config/redis';

const KEY_PREFIX = 'telegram_signup:';
const MSGS_KEY_PREFIX = 'telegram_signup_msgs:';
const DEFAULT_TTL_SECONDS = 600; // 10 minutes

export interface SignupSession {
  step: 'awaiting_confirmation' | 'awaiting_email';
  agentId: string;
  pairingCode: string;
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
  await redis.del(`${KEY_PREFIX}${chatId}`, `${MSGS_KEY_PREFIX}${chatId}`);
}

// Atomic append via RPUSH so concurrent webhook handlers for the same chat
// cannot race and clobber each other's tracked message ids. RPUSH and EXPIRE
// are pipelined so a network blip between the two cannot leave an orphaned
// list with no TTL.
export async function appendSignupMessageId(
  chatId: number | string,
  messageId: number,
  ttlSeconds = DEFAULT_TTL_SECONDS,
): Promise<void> {
  const redis = getRedisClient();
  const key = `${MSGS_KEY_PREFIX}${chatId}`;
  await redis.pipeline().rpush(key, String(messageId)).expire(key, ttlSeconds).exec();
}

export async function getSignupMessageIds(chatId: number | string): Promise<number[]> {
  const redis = getRedisClient();
  const ids = await redis.lrange(`${MSGS_KEY_PREFIX}${chatId}`, 0, -1);
  return ids.map((id) => Number(id));
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
