import { Module } from '@nestjs/common';
import { WebhookOutboxWorker } from './webhook-outbox.worker.js';
import { WebhooksController } from './webhooks.controller.js';
import { WebhooksService } from './webhooks.service.js';

@Module({
  controllers: [WebhooksController],
  providers: [WebhooksService, WebhookOutboxWorker],
  exports: [WebhooksService, WebhookOutboxWorker],
})
export class WebhooksModule {}
