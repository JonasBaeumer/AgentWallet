export interface AgentWalletUser {
  id: string;
  email: string;
}

export interface StoredPermission {
  permissionHash: string;
  tokenAddress: string;
  assetSymbol: string;
  tokenDecimals: number;
  allowanceAtomic: string;
  periodSeconds: number;
  validAfter: string;
  validUntil: string;
  status: string;
  revokedAt: string | null;
  lastSyncedAt: string | null;
}

export interface CustomerWallet {
  id: string;
  network: string;
  chainId: number;
  customerAddress: string;
  executorAddress: string | null;
  status: 'PROVISIONING' | 'ACTIVE' | 'SUSPENDED' | 'FAILED' | 'CLOSED';
  disconnectedAt: string | null;
  permission: StoredPermission | null;
}

const API_BASE = import.meta.env.VITE_API_BASE_URL?.replace(/\/$/, '') ?? '';

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
  ) {
    super(code);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, apiKey: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  });
  const body = (await response.json().catch(() => ({}))) as { error?: string } & T;
  if (!response.ok) throw new ApiError(body.error ?? 'request_failed', response.status);
  return body;
}

export function authenticateAgentWallet(apiKey: string): Promise<AgentWalletUser> {
  return request<AgentWalletUser>('/v1/users/me', apiKey);
}

export async function getCustomerWallet(apiKey: string): Promise<CustomerWallet | null> {
  const response = await request<{ wallet: CustomerWallet | null }>('/v1/crypto/wallet', apiKey);
  return response.wallet;
}

export async function bindCustomerWallet(
  apiKey: string,
  accessToken: string,
  smartAccountAddress: string,
): Promise<CustomerWallet> {
  const response = await request<{ wallet: CustomerWallet }>('/v1/crypto/wallet/bind', apiKey, {
    method: 'POST',
    body: JSON.stringify({ accessToken, smartAccountAddress }),
  });
  return response.wallet;
}

export function disconnectCustomerWallet(apiKey: string): Promise<{ disconnected: true }> {
  return request('/v1/crypto/wallet/disconnect', apiKey, { method: 'POST' });
}
