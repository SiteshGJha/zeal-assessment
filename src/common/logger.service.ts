import { Injectable } from '@nestjs/common';
import { RequestContext } from './request-context.js';

export type LogLevel = 'info' | 'warn' | 'error';

/**
 * Emits single-line structured JSON logs enriched with correlation and actor metadata.
 */
@Injectable()
export class StructuredLoggerService {
  log(level: LogLevel, message: string, fields: Record<string, unknown> = {}): void {
    const ctx = RequestContext.get();
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      correlationId: ctx?.correlationId ?? null,
      actorSub: ctx?.actorSub ?? null,
      agentId: ctx?.agentId ?? null,
      message,
      ...fields,
    };
    const line = JSON.stringify(entry);
    if (level === 'error') {
      process.stderr.write(`${line}\n`);
    } else {
      process.stdout.write(`${line}\n`);
    }
  }

  info(message: string, fields?: Record<string, unknown>): void {
    this.log('info', message, fields);
  }

  warn(message: string, fields?: Record<string, unknown>): void {
    this.log('warn', message, fields);
  }

  error(message: string, fields?: Record<string, unknown>): void {
    this.log('error', message, fields);
  }
}
