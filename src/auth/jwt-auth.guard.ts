import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import jwt from 'jsonwebtoken';
import { getJwtSecret, type RequestWithActor } from './auth.types.js';
import { IS_PUBLIC_KEY } from './public.decorator.js';
import { RequestContext } from '../common/request-context.js';

interface JwtPayload {
  sub?: unknown;
  email?: unknown;
  scope?: unknown;
}

/**
 * Normalizes a JWT scope claim (array or space-delimited string) into a string array.
 */
function normalizeScopes(rawScope: unknown): string[] {
  if (Array.isArray(rawScope)) {
    return rawScope.filter((item): item is string => typeof item === 'string' && item.length > 0);
  }
  if (typeof rawScope === 'string') {
    return rawScope
      .split(/\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return [];
}

/**
 * Sanitizes an incoming X-Agent-Id header to safe identifier characters.
 */
function sanitizeAgentId(raw: string | string[] | undefined): string | undefined {
  const val = Array.isArray(raw) ? raw[0] : raw;
  if (!val) {
    return undefined;
  }
  const cleaned = val.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * Validates HS256 bearer JWTs and attaches ActorContext to incoming requests.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
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
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing or malformed Bearer authorization header');
    }

    const token = authHeader.slice('Bearer '.length).trim();
    if (!token) {
      throw new UnauthorizedException('Empty Bearer token');
    }

    let decoded: JwtPayload;
    try {
      decoded = jwt.verify(token, getJwtSecret(), { algorithms: ['HS256'] }) as JwtPayload;
    } catch {
      throw new UnauthorizedException('Invalid or expired Bearer token');
    }

    if (typeof decoded.sub !== 'string' || decoded.sub.trim().length === 0) {
      throw new UnauthorizedException('JWT missing valid sub claim');
    }

    const agentId = sanitizeAgentId(req.headers['x-agent-id']);
    const scopes = normalizeScopes(decoded.scope);
    const email = typeof decoded.email === 'string' ? decoded.email : undefined;

    req.actor = {
      sub: decoded.sub.trim(),
      email,
      scopes,
      agentId,
    };

    const store = RequestContext.get();
    if (store) {
      store.actorSub = req.actor.sub;
      store.agentId = agentId;
    }

    return true;
  }
}
