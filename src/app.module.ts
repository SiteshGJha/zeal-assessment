import { MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { JwtAuthGuard } from './auth/jwt-auth.guard.js';
import { ScopesGuard } from './auth/scopes.guard.js';
import { CasesModule } from './cases/cases.module.js';
import { AuditInterceptor } from './common/audit.interceptor.js';
import { CoreModule } from './common/core.module.js';
import { CorrelationMiddleware } from './common/correlation.middleware.js';
import { ProblemDetailsFilter } from './common/problem-details.filter.js';
import { RateLimitGuard } from './common/rate-limit.guard.js';
import { CustomersModule } from './customers/customers.module.js';
import { HealthController } from './health/health.controller.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { WebhooksModule } from './webhooks/webhooks.module.js';

/**
 * Root NestJS module wiring global guards, filters, audit logging, resilience,
 * loopback upstream mocks, and feature modules.
 */
@Module({
  imports: [PrismaModule, CoreModule, CustomersModule, CasesModule, WebhooksModule],
  controllers: [HealthController],
  providers: [
    RateLimitGuard,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: ScopesGuard },
    { provide: APP_GUARD, useExisting: RateLimitGuard },
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
    { provide: APP_FILTER, useClass: ProblemDetailsFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationMiddleware).forRoutes('*');
  }
}
