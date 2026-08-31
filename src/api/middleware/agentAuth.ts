import { FastifyReply, FastifyRequest } from 'fastify';
import { prisma } from '@/db/client';
import { workerAuthMiddleware } from '@/api/middleware/auth';
import {
  getAgentCredentialPrefix,
  isAgentCredentialFormat,
  verifyAgentCredential,
} from '@/security/agentCredentials';

export interface AuthenticatedAgent {
  id: string;
  userId: string | null;
  credentialVersion: number;
  credentialExpiresAt: Date;
}

declare module 'fastify' {
  interface FastifyRequest {
    authenticatedAgent?: AuthenticatedAgent;
    agentId?: string;
  }
}

function sendAgentAuthError(
  reply: FastifyReply,
  statusCode: 401 | 403,
  code: string,
  message: string,
): void {
  reply.status(statusCode).send({ error: message, code });
}

export async function agentAuthMiddleware(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const rawCredential = request.headers['x-agent-key'];
  if (typeof rawCredential !== 'string' || !isAgentCredentialFormat(rawCredential)) {
    sendAgentAuthError(
      reply,
      401,
      rawCredential ? 'agent_credential_invalid' : 'agent_credential_missing',
      'Unauthorized: invalid or missing X-Agent-Key',
    );
    return;
  }

  const record = await prisma.pairingCode.findUnique({
    where: { credentialPrefix: getAgentCredentialPrefix(rawCredential) },
    select: {
      agentId: true,
      claimedByUserId: true,
      credentialHash: true,
      credentialExpiresAt: true,
      credentialVersion: true,
      credentialRevokedAt: true,
    },
  });

  if (
    !record?.credentialHash ||
    record.credentialRevokedAt ||
    !(await verifyAgentCredential(rawCredential, record.credentialHash))
  ) {
    sendAgentAuthError(
      reply,
      401,
      'agent_credential_invalid',
      'Unauthorized: invalid or rotated agent credential',
    );
    return;
  }

  if (!record.credentialExpiresAt || record.credentialExpiresAt.getTime() <= Date.now()) {
    sendAgentAuthError(
      reply,
      401,
      'agent_credential_expired',
      'Unauthorized: agent credential has expired',
    );
    return;
  }

  const claimedUser = record.claimedByUserId
    ? await prisma.user.findUnique({
        where: { id: record.claimedByUserId },
        select: { id: true, agentId: true },
      })
    : null;
  const userId = claimedUser?.agentId === record.agentId ? claimedUser.id : null;

  const claimedAgentId = request.headers['x-agent-id'];
  if (claimedAgentId && claimedAgentId !== record.agentId) {
    sendAgentAuthError(
      reply,
      403,
      'agent_identity_mismatch',
      'Forbidden: X-Agent-Id does not match the authenticated agent',
    );
    return;
  }

  request.authenticatedAgent = {
    id: record.agentId,
    userId,
    credentialVersion: record.credentialVersion,
    credentialExpiresAt: record.credentialExpiresAt,
  };
  request.agentId = record.agentId;
}

export async function claimedAgentAuthMiddleware(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  await agentAuthMiddleware(request, reply);
  if (reply.sent) return;

  if (!request.authenticatedAgent?.userId) {
    sendAgentAuthError(
      reply,
      403,
      'agent_not_linked',
      'Forbidden: authenticated agent is not linked to a user',
    );
  }
}

export async function agentRegistrationAuthMiddleware(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (request.headers['x-agent-key'] !== undefined) {
    await agentAuthMiddleware(request, reply);
    return;
  }
  await workerAuthMiddleware(request, reply);
}

/**
 * Re-reads the credential and link that authentication cached on the request.
 *
 * The authentication hook runs once, early. A caller that has already sent its
 * headers can hold the connection open and finish the request later -- after the
 * user unlinks or the credential is revoked or rotated. `request.authenticatedAgent`
 * still holds the identity captured before that happened, so a guard that compares
 * only the cached identity will authorize a mutation the agent is no longer
 * entitled to make. Anything that moves money or reveals a card therefore has to
 * confirm the credential is still live at the moment it acts, not at the moment
 * the request arrived.
 *
 * This is a re-read by agent id, not a second bcrypt verification: the credential
 * itself was already proven, and the fields that can change underneath it --
 * revocation, rotation, expiry, and the user link -- are all observable without it.
 */
async function agentLinkStillValid(agent: AuthenticatedAgent): Promise<boolean> {
  const record = await prisma.pairingCode.findUnique({
    where: { agentId: agent.id },
    select: {
      claimedByUserId: true,
      credentialExpiresAt: true,
      credentialVersion: true,
      credentialRevokedAt: true,
    },
  });

  if (!record || record.credentialRevokedAt) return false;
  if (record.credentialVersion !== agent.credentialVersion) return false;
  if (!record.credentialExpiresAt || record.credentialExpiresAt.getTime() <= Date.now()) {
    return false;
  }
  if (!record.claimedByUserId || record.claimedByUserId !== agent.userId) return false;

  // The link is bidirectional; a stale claimedByUserId must not resurrect it.
  const claimedUser = await prisma.user.findUnique({
    where: { id: record.claimedByUserId },
    select: { agentId: true },
  });
  return claimedUser?.agentId === agent.id;
}

export async function requireOwnedIntent(
  request: FastifyRequest,
  reply: FastifyReply,
  intentId: string,
) {
  const agent = request.authenticatedAgent;
  if (!agent?.userId) {
    sendAgentAuthError(
      reply,
      403,
      'agent_not_linked',
      'Forbidden: authenticated agent is not linked to a user',
    );
    return null;
  }

  if (!(await agentLinkStillValid(agent))) {
    sendAgentAuthError(
      reply,
      401,
      'agent_credential_invalid',
      'Unauthorized: agent credential was revoked, rotated, or unlinked',
    );
    return null;
  }

  const intent = await prisma.purchaseIntent.findUnique({ where: { id: intentId } });
  if (!intent) {
    reply.status(404).send({ error: `Intent not found: ${intentId}`, code: 'intent_not_found' });
    return null;
  }

  if (intent.userId !== agent.userId || intent.agentId !== agent.id) {
    sendAgentAuthError(
      reply,
      403,
      'agent_intent_forbidden',
      'Forbidden: intent does not belong to the authenticated agent',
    );
    return null;
  }

  return intent;
}
