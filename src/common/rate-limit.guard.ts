import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import type { RequestWithActor } from '../auth/auth.types.js';
import { IS_PUBLIC_KEY } from '../auth/public.decorator.js';

const WINDOW_MS = 60_000;
const HTTP_LIMIT = 60;
const AGENT_LIMIT = 30;

interface BucketEvaluation {
  limit: number;
  remaining: number;
  resetEpochSec: number;
  exceeded: boolean;
  retryAfterSec: number;
}

/**
 * Enforces process-local 60-second sliding-window rate limits keyed primarily by verified
 * actorSub and secondarily by (actorSub, agentId) when X-Agent-Id is present.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly buckets = new Map<string, number[]>();

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const req = context.switchToHttp().getRequest<RequestWithActor>();
    const res = context.switchToHttp().getResponse<Response>();
    const actorSub = req.actor?.sub ?? 'anonymous';
    const agentId = req.actor?.agentId;
    const now = Date.now();

    const userBucket = this.consume(`user:${actorSub}`, HTTP_LIMIT, now);
    const evaluated: BucketEvaluation[] = [userBucket];

    if (agentId) {
      evaluated.push(this.consume(`agent:${actorSub}:${agentId}`, AGENT_LIMIT, now));
    }

    const exceededBucket = evaluated.find((b) => b.exceeded);
    const tighter = evaluated.reduce((min, cur) =>
      cur.remaining < min.remaining ? cur : min,
    );
    const active = exceededBucket ?? tighter;

    const headers: Record<string, string> = {
      'RateLimit-Limit': String(active.limit),
      'RateLimit-Remaining': String(active.remaining),
      'RateLimit-Reset': String(active.resetEpochSec),
    };
    req.rateLimitHeaders = headers;
    for (const [k, v] of Object.entries(headers)) {
      res.setHeader(k, v);
    }

    if (exceededBucket) {
      res.setHeader('Retry-After', String(exceededBucket.retryAfterSec));
      throw new HttpException(
        {
          type: 'urn:zeal:problem:rate-limit-exceeded',
          title: 'Too Many Requests',
          detail: `Rate limit of ${exceededBucket.limit} requests per minute exceeded`,
          retryAfterSec: exceededBucket.retryAfterSec,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return true;
  }

  /**
   * Clears all sliding-window buckets (used in test isolation).
   */
  reset(): void {
    this.buckets.clear();
  }

  private consume(key: string, limit: number, now: number): BucketEvaluation {
    const cutoff = now - WINDOW_MS;
    const timestamps = (this.buckets.get(key) ?? []).filter((ts) => ts > cutoff);

    if (timestamps.length >= limit) {
      this.buckets.set(key, timestamps);
      const oldest = timestamps[0] ?? now;
      const resetMs = oldest + WINDOW_MS;
      const retryAfterSec = Math.max(1, Math.ceil((resetMs - now) / 1000));
      return {
        limit,
        remaining: 0,
        resetEpochSec: Math.ceil(resetMs / 1000),
        exceeded: true,
        retryAfterSec,
      };
    }

    timestamps.push(now);
    this.buckets.set(key, timestamps);
    const oldest = timestamps[0] ?? now;
    return {
      limit,
      remaining: Math.max(0, limit - timestamps.length),
      resetEpochSec: Math.ceil((oldest + WINDOW_MS) / 1000),
      exceeded: false,
      retryAfterSec: 0,
    };
  }
}
