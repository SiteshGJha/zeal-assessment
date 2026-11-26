import { Body, Controller, Get, Headers, HttpCode, Post, Req } from '@nestjs/common';
import type { RequestWithActor } from '../auth/auth.types.js';
import { Public } from '../auth/public.decorator.js';
import { RequiredScopes } from '../auth/scopes.decorator.js';
import {
  CreateWebhookSubscriptionDto,
  type VerifiedWebhookDelivery,
  type WebhookSubscriptionDto,
} from './webhooks.dto.js';
import { WebhooksService } from './webhooks.service.js';

/**
 * Exposes webhook subscription registration and local HMAC receiver inspection endpoints.
 */
@Controller()
export class WebhooksController {
  constructor(private readonly webhooksService: WebhooksService) {}

  @Post('v1/webhooks/subscriptions')
  @HttpCode(201)
  @RequiredScopes('support:write')
  async createSubscription(
    @Body() dto: CreateWebhookSubscriptionDto,
  ): Promise<WebhookSubscriptionDto> {
    return this.webhooksService.createSubscription(dto);
  }

  @Public()
  @Post('internal/webhook-receiver')
  @HttpCode(200)
  async receiveInternalWebhook(
    @Req() req: RequestWithActor,
    @Body() body: Record<string, unknown>,
    @Headers('x-webhook-id') webhookId?: string,
    @Headers('x-webhook-event') eventType?: string,
    @Headers('x-signature-timestamp') timestamp?: string,
    @Headers('x-signature-sha256') signature?: string,
  ): Promise<{ accepted: boolean }> {
    const rawBody = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(body);
    return this.webhooksService.receiveInternalWebhook(rawBody, body, {
      webhookId,
      eventType,
      timestamp,
      signature,
    });
  }

  @Get('internal/webhook-deliveries')
  @RequiredScopes('support:read')
  listDeliveries(): { items: VerifiedWebhookDelivery[] } {
    return this.webhooksService.listDeliveries();
  }
}
