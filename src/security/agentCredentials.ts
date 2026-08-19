import { randomBytes } from 'crypto';
import bcrypt from 'bcryptjs';

const AGENT_CREDENTIAL_PREFIX_LENGTH = 16;
const AGENT_CREDENTIAL_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const BCRYPT_COST = process.env.NODE_ENV === 'test' ? 4 : 12;

export interface IssuedAgentCredential {
  raw: string;
  prefix: string;
  hash: string;
  expiresAt: Date;
}

export function getAgentCredentialPrefix(raw: string): string {
  return raw.slice(0, AGENT_CREDENTIAL_PREFIX_LENGTH);
}

export function isAgentCredentialFormat(raw: string): boolean {
  return /^agk_[A-Za-z0-9_-]{43}$/.test(raw);
}

export async function issueAgentCredential(now = new Date()): Promise<IssuedAgentCredential> {
  const raw = `agk_${randomBytes(32).toString('base64url')}`;
  return {
    raw,
    prefix: getAgentCredentialPrefix(raw),
    hash: await bcrypt.hash(raw, BCRYPT_COST),
    expiresAt: new Date(now.getTime() + AGENT_CREDENTIAL_TTL_MS),
  };
}

export async function verifyAgentCredential(raw: string, hash: string): Promise<boolean> {
  return bcrypt.compare(raw, hash);
}
