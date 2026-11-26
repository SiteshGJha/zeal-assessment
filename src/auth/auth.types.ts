import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';

export type Scope = 'support:read' | 'support:write' | 'finance:read';

export interface ActorContext {
  sub: string;
  email?: string;
  scopes: string[];
  agentId?: string;
}

export interface RequestWithActor extends RawBodyRequest<Request> {
  actor?: ActorContext;
  correlationId?: string;
  rateLimitHeaders?: Record<string, string>;
}

/**
 * Returns the HS256 JWT signing secret, failing fast in production if unset.
 */
export function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (process.env.NODE_ENV === 'production' && !secret) {
    throw new Error('JWT_SECRET must be set in production');
  }
  return secret || 'dev-jwt-secret-change-me';
}

/**
 * Returns the webhook HMAC signing secret, failing fast in production if unset.
 */
export function getWebhookSigningSecret(): string {
  const secret = process.env.WEBHOOK_SIGNING_SECRET;
  if (process.env.NODE_ENV === 'production' && !secret) {
    throw new Error('WEBHOOK_SIGNING_SECRET must be set in production');
  }
  return secret || 'dev-webhook-secret';
}
