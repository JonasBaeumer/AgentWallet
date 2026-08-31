export interface PairingCodeData {
  code: string;
  agentId: string;
  claimedByUserId: string | null;
  expiresAt: Date;
  codeIssuedAt: Date;
  credentialHash: string | null;
  credentialPrefix: string | null;
  credentialExpiresAt: Date | null;
  credentialVersion: number;
  credentialRevokedAt: Date | null;
  createdAt: Date;
}

export class PairingCodeNotFoundError extends Error {
  constructor(agentId: string) {
    super(`Pairing code not found for agentId: ${agentId}`);
    this.name = 'PairingCodeNotFoundError';
  }
}

export class PairingCodeExpiredError extends Error {
  constructor(code: string) {
    super(`Pairing code expired: ${code}`);
    this.name = 'PairingCodeExpiredError';
  }
}

export class PairingCodeAlreadyClaimedError extends Error {
  constructor(code: string) {
    super(`Pairing code already claimed: ${code}`);
    this.name = 'PairingCodeAlreadyClaimedError';
  }
}

export class AgentNotFoundError extends Error {
  constructor(agentId: string) {
    super(`Agent not found: ${agentId}`);
    this.name = 'AgentNotFoundError';
  }
}
