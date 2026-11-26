import { IsIn, IsString, IsUrl, Length } from 'class-validator';

export class CreateWebhookSubscriptionDto {
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true, require_tld: false })
  targetUrl!: string;

  @IsIn(['case.escalated'])
  eventType!: 'case.escalated';

  @IsString()
  @Length(16, 128)
  secret!: string;
}

export interface WebhookSubscriptionDto {
  id: string;
  targetUrl: string;
  eventType: 'case.escalated';
  active: boolean;
  createdAt: string;
}

export interface VerifiedWebhookDelivery {
  webhookId: string;
  eventType: string;
  timestamp: string;
  payload: Record<string, unknown>;
  receivedAt: string;
}
