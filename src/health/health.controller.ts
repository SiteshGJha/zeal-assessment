import { Controller, Get, HttpStatus } from '@nestjs/common';
import { Public } from '../auth/public.decorator.js';
import { ProblemException } from '../common/problem-details.filter.js';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Unauthenticated readiness and healthcheck endpoint.
 */
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get()
  async check(): Promise<{ status: string; db: string }> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'ok', db: 'connected' };
    } catch {
      throw new ProblemException(HttpStatus.SERVICE_UNAVAILABLE, {
        title: 'Service Unavailable',
        detail: 'Database health check failed',
      });
    }
  }
}
