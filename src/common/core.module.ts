import { Global, Module } from '@nestjs/common';
import { StructuredLoggerService } from './logger.service.js';
import { ResilienceExecutor } from '../resilience/resilience.executor.js';
import { MockUpstreamServer } from '../upstreams/mock-upstream.server.js';
import { UpstreamClientsService } from '../upstreams/upstream-clients.service.js';

/**
 * Global core module providing singleton logger, resilience executor, loopback upstream
 * stub server, and upstream clients across all feature modules.
 */
@Global()
@Module({
  providers: [
    StructuredLoggerService,
    ResilienceExecutor,
    MockUpstreamServer,
    UpstreamClientsService,
  ],
  exports: [
    StructuredLoggerService,
    ResilienceExecutor,
    MockUpstreamServer,
    UpstreamClientsService,
  ],
})
export class CoreModule {}
