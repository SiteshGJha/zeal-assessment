import { randomUUID } from 'node:crypto';
import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Response } from 'express';
import type { RequestWithActor } from '../auth/auth.types.js';
import { StructuredLoggerService } from './logger.service.js';
import { parseFaultInjectHeader, RequestContext } from './request-context.js';

/**
 * Sanitizes incoming X-Correlation-ID headers or generates a UUID v4, binds AsyncLocalStorage
 * context, and records HTTP completion logs.
 */
@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  constructor(private readonly logger: StructuredLoggerService) {}

  use(req: RequestWithActor, res: Response, next: NextFunction): void {
    const rawHeader = req.headers['x-correlation-id'];
    const raw = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
    const sanitized = raw ? raw.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 64) : '';
    const correlationId = sanitized.length > 0 ? sanitized : randomUUID();

    req.correlationId = correlationId;
    res.setHeader('X-Correlation-ID', correlationId);

    const faultInject = parseFaultInjectHeader(req.headers['x-fault-inject']);
    const scopeHeader = req.headers['x-fault-inject-scope'];
    const scopeVal = (Array.isArray(scopeHeader) ? scopeHeader[0] : scopeHeader)?.toLowerCase();
    const faultScopeCircuitBreaker =
      process.env.FAULT_INJECTION_ENABLED === 'true' && scopeVal === 'circuit-breaker';

    const startMs = Date.now();
    const store = {
      correlationId,
      faultInject,
      faultScopeCircuitBreaker,
    };

    RequestContext.run(store, () => {
      res.on('finish', () => {
        this.logger.info('http_request', {
          method: req.method,
          path: req.originalUrl || req.url,
          status: res.statusCode,
          durationMs: Date.now() - startMs,
        });
      });
      next();
    });
  }
}
