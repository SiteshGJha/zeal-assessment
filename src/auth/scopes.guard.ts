import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { RequestWithActor, Scope } from './auth.types.js';
import { IS_PUBLIC_KEY } from './public.decorator.js';
import { SCOPES_KEY } from './scopes.decorator.js';

/**
 * Enforces @RequiredScopes metadata against the verified ActorContext scopes.
 */
@Injectable()
export class ScopesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const requiredScopes = this.reflector.getAllAndOverride<Scope[]>(SCOPES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!requiredScopes || requiredScopes.length === 0) {
      return true;
    }

    const req = context.switchToHttp().getRequest<RequestWithActor>();
    const actorScopes = req.actor?.scopes ?? [];
    const missing = requiredScopes.filter((s) => !actorScopes.includes(s));

    if (missing.length > 0) {
      throw new ForbiddenException(`Missing required scope(s): ${missing.join(', ')}`);
    }

    return true;
  }
}
