import 'reflect-metadata';
import { HttpStatus, ValidationPipe, type ValidationError } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { getJwtSecret, getWebhookSigningSecret } from './auth/auth.types.js';
import { ProblemException, type ProblemFieldError } from './common/problem-details.filter.js';

function flattenValidationErrors(errors: ValidationError[]): ProblemFieldError[] {
  const result: ProblemFieldError[] = [];
  for (const err of errors) {
    if (err.constraints) {
      for (const message of Object.values(err.constraints)) {
        result.push({ field: err.property, message });
      }
    }
    if (err.children && err.children.length > 0) {
      result.push(...flattenValidationErrors(err.children));
    }
  }
  return result;
}

/**
 * Creates a globally configured ValidationPipe emitting RFC 9457 422 ProblemExceptions.
 */
export function createGlobalValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    exceptionFactory: (errors: ValidationError[]) =>
      new ProblemException(HttpStatus.UNPROCESSABLE_ENTITY, {
        title: 'Unprocessable Entity',
        detail: 'Request validation failed',
        errors: flattenValidationErrors(errors),
      }),
  });
}

async function bootstrap(): Promise<void> {
  // Enforce fail-fast secret configuration in production before booting NestJS.
  getJwtSecret();
  getWebhookSigningSecret();

  const app = await NestFactory.create(AppModule, {
    rawBody: true,
    logger: ['error', 'warn'],
  });
  app.useGlobalPipes(createGlobalValidationPipe());
  app.enableShutdownHooks();

  const port = Number.parseInt(process.env.PORT ?? '3000', 10);
  await app.listen(Number.isFinite(port) ? port : 3000);
}

if (require.main === module) {
  bootstrap().catch((err) => {
    console.error('Bootstrap failed:', err);
    process.exit(1);
  });
}
