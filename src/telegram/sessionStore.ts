import { getRedisClient } from '@/config/redis';

const KEY_PREFIX = 'telegram_signup:';
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
  await redis.del(`${KEY_PREFIX}${chatId}`);
}
