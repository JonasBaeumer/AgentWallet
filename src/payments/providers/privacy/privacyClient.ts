/**
 * Thin HTTP wrapper around the Privacy.com API.
 *
 * Docs: https://developers.privacy.com — base URL `https://api.privacy.com/v1/`.
 * Auth header is `Authorization: api-key <TOKEN>` (not Bearer).
 *
 * No sandbox is available (as of this writing), so this module is designed
 * to be fully mockable in tests via `setPrivacyFetch()`. Production calls go
 * through `globalThis.fetch`.
 */
import { env } from '@/config/env';

export interface PrivacyCardCreateParams {
  type: 'SINGLE_USE' | 'MERCHANT_LOCKED' | 'DIGITAL_WALLET' | 'UNLOCKED';
  memo?: string;
  spend_limit: number;
  spend_limit_duration: 'TRANSACTION' | 'MONTHLY' | 'ANNUALLY' | 'FOREVER';
  state: 'OPEN' | 'PAUSED';
}

export interface PrivacyCard {
  token: string;
  last_four: string;
  pan: string;
  cvv: string;
  exp_month: string;
  exp_year: string;
  memo?: string;
  type: string;
  spend_limit: number;
  spend_limit_duration: string;
  state: 'OPEN' | 'PAUSED' | 'CLOSED' | 'PENDING_ACTIVATION' | 'PENDING_FULFILLMENT';
  created: string;
}

export interface PrivacyCardUpdateParams {
  state?: 'OPEN' | 'PAUSED' | 'CLOSED';
}

/**
 * Minimal fetch-shaped type so tests can inject a mock. We only need
 * the subset that our client actually uses.
 */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

let _fetch: FetchLike | null = null;

/** Test-only: override the HTTP implementation. Production uses `globalThis.fetch`. */
export function setPrivacyFetch(fn: FetchLike | null): void {
  _fetch = fn;
}

function getFetch(): FetchLike {
  if (_fetch) return _fetch;
  return globalThis.fetch as unknown as FetchLike;
}

export class PrivacyApiError extends Error {
  public readonly status: number;
  public readonly body: string;

  constructor(status: number, body: string) {
    super(`Privacy.com API error ${status}: ${body}`);
    this.name = 'PrivacyApiError';
    this.status = status;
    this.body = body;
  }
}

function headers(): Record<string, string> {
  return {
    Authorization: `api-key ${env.PRIVACY_API_KEY}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const url = `${env.PRIVACY_API_BASE_URL}${path}`;
  const res = await getFetch()(url, {
    method,
    headers: headers(),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new PrivacyApiError(res.status, text);
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

export async function createCard(params: PrivacyCardCreateParams): Promise<PrivacyCard> {
  return request<PrivacyCard>('POST', '/cards', params);
}

export async function updateCard(
  cardToken: string,
  params: PrivacyCardUpdateParams,
): Promise<PrivacyCard> {
  return request<PrivacyCard>('PATCH', `/cards/${encodeURIComponent(cardToken)}`, params);
}
