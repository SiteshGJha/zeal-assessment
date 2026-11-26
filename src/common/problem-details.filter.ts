import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import type { Response } from 'express';
import type { RequestWithActor } from '../auth/auth.types.js';
import { StructuredLoggerService } from './logger.service.js';

export interface ProblemFieldError {
  field: string;
  message: string;
}

export interface ProblemPayload {
  type?: string;
  title?: string;
  detail?: string;
  errors?: ProblemFieldError[];
  retryAfterSec?: number;
}

/**
 * Custom exception carrying explicit RFC 9457 metadata.
 */
export class ProblemException extends HttpException {
  constructor(status: HttpStatus, payload: ProblemPayload) {
    super(payload, status);
  }
}

const DEFAULT_TITLES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  412: 'Precondition Failed',
  422: 'Unprocessable Entity',
  428: 'Precondition Required',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

const PROBLEM_TYPES: Record<number, string> = {
  400: 'urn:zeal:problem:bad-request',
  401: 'urn:zeal:problem:unauthorized',
  403: 'urn:zeal:problem:forbidden',
  404: 'urn:zeal:problem:not-found',
  409: 'urn:zeal:problem:conflict',
  412: 'urn:zeal:problem:precondition-failed',
  422: 'urn:zeal:problem:unprocessable-entity',
  428: 'urn:zeal:problem:precondition-required',
  429: 'urn:zeal:problem:rate-limit-exceeded',
  500: 'urn:zeal:problem:internal-error',
  503: 'urn:zeal:problem:service-unavailable',
};

/**
 * Converts all thrown exceptions into RFC 9457 application/problem+json responses.
 */
@Catch()
@Injectable()
export class ProblemDetailsFilter implements ExceptionFilter {
  constructor(private readonly logger: StructuredLoggerService) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<RequestWithActor>();
    const res = ctx.getResponse<Response>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let type = PROBLEM_TYPES[500];
    let title = DEFAULT_TITLES[500];
    let detail = 'An unexpected error occurred';
    let errors: ProblemFieldError[] | undefined;
    let retryAfterSec: number | undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      type = PROBLEM_TYPES[status] ?? 'about:blank';
      title = DEFAULT_TITLES[status] ?? 'Error';
      const body = exception.getResponse();

      if (typeof body === 'string') {
        detail = body;
      } else if (body && typeof body === 'object') {
        const obj = body as Record<string, unknown>;
        if (typeof obj.type === 'string') type = obj.type;
        if (typeof obj.title === 'string') title = obj.title;
        if (typeof obj.retryAfterSec === 'number') retryAfterSec = obj.retryAfterSec;
        if (Array.isArray(obj.errors)) {
          errors = obj.errors as ProblemFieldError[];
        }
        if (typeof obj.detail === 'string') {
          detail = obj.detail;
        } else if (Array.isArray(obj.message)) {
          detail = 'Request validation failed';
          errors = obj.message.map((msg) => ({
            field: String(msg).split(' ')[0] || 'body',
            message: String(msg),
          }));
        } else if (typeof obj.message === 'string') {
          detail = obj.message;
        }
      }
    } else if (exception instanceof Error) {
      this.logger.error('unhandled_exception', {
        error: exception.message,
      });
    }

    if (req.rateLimitHeaders) {
      for (const [k, v] of Object.entries(req.rateLimitHeaders)) {
        res.setHeader(k, v);
      }
    }
    if (status === HttpStatus.TOO_MANY_REQUESTS || status === HttpStatus.SERVICE_UNAVAILABLE) {
      res.setHeader('Retry-After', String(retryAfterSec ?? 5));
    }

    const problem: Record<string, unknown> = {
      type,
      title,
      status,
      detail,
      instance: req.originalUrl || req.url,
      correlationId: req.correlationId ?? 'unknown',
    };
    if (errors && errors.length > 0) {
      problem.errors = errors;
    }

    res.status(status).type('application/problem+json').json(problem);
  }
}
