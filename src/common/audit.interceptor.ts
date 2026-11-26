import {
  CallHandler,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Prisma } from '@prisma/client';
import { catchError, Observable, tap, throwError } from 'rxjs';
import type { RequestWithActor } from '../auth/auth.types.js';
import { IS_PUBLIC_KEY } from '../auth/public.decorator.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StructuredLoggerService } from './logger.service.js';

interface RouteAuditMeta {
  action: string;
  resourceType: string;
  resourceId: string;
}

/**
 * Resolves canonical audit metadata from the HTTP method, path, and route params.
 */
function resolveAuditMeta(req: RequestWithActor): RouteAuditMeta {
  const path = (req.route?.path as string | undefined) || req.path || '';
  const idParam = typeof req.params?.id === 'string' ? req.params.id : 'collection';

  if (req.method === 'GET' && path.includes('/customers')) {
    return { action: 'customer.read', resourceType: 'customer', resourceId: idParam };
  }
  if (req.method === 'GET' && path.includes('/cases')) {
    return { action: 'cases.search', resourceType: 'case', resourceId: 'collection' };
  }
  if (req.method === 'POST' && path.includes('/comments')) {
    return { action: 'case.comment.create', resourceType: 'case', resourceId: idParam };
  }
  if (req.method === 'POST' && path.includes('/escalate')) {
    return { action: 'case.escalate', resourceType: 'case', resourceId: idParam };
  }
  if (req.method === 'POST' && path.includes('/webhooks/subscriptions')) {
    return {
      action: 'webhook.subscribe',
      resourceType: 'webhook_subscription',
      resourceId: 'collection',
    };
  }
  return {
    action: `${req.method.toLowerCase()}.${path || 'unknown'}`,
    resourceType: 'platform',
    resourceId: idParam,
  };
}

/**
 * Persists immutable AuditLog entries for every authenticated /v1/* HTTP request.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
    private readonly logger: StructuredLoggerService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const req = context.switchToHttp().getRequest<RequestWithActor>();
    if (isPublic || !req.path.startsWith('/v1')) {
      return next.handle();
    }

    const meta = resolveAuditMeta(req);

    return next.handle().pipe(
      tap(() => {
        void this.writeAudit(req, meta, 'success');
      }),
      catchError((err: unknown) => {
        const status = err instanceof HttpException ? err.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
        const outcome =
          status === HttpStatus.UNAUTHORIZED || status === HttpStatus.FORBIDDEN
            ? 'denied'
            : 'error';
        void this.writeAudit(req, meta, outcome, {
          status,
          error: err instanceof Error ? err.message : String(err),
        });
        return throwError(() => err);
      }),
    );
  }

  private async writeAudit(
    req: RequestWithActor,
    meta: RouteAuditMeta,
    outcome: 'success' | 'denied' | 'error',
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          correlationId: req.correlationId ?? 'unknown',
          actorSub: req.actor?.sub ?? 'anonymous',
          agentId: req.actor?.agentId ?? null,
          action: meta.action,
          resourceType: meta.resourceType,
          resourceId: meta.resourceId,
          scopes: req.actor?.scopes ?? [],
          outcome,
          metadata: {
            method: req.method,
            path: req.originalUrl || req.url,
            ...extra,
          } as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      this.logger.warn('audit_log_write_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
