import { HttpStatus, Injectable } from '@nestjs/common';
import type { ActorContext } from '../auth/auth.types.js';
import { ProblemException } from '../common/problem-details.filter.js';
import { UpstreamUnavailableError } from '../resilience/resilience.executor.js';
import {
  canonicalizeAccountId,
  UpstreamClientsService,
  type SupportTier,
  type UsageRow,
} from '../upstreams/upstream-clients.service.js';

export interface CustomerAggregateDto {
  accountId: string;
  name: string;
  supportTier: SupportTier;
  renewalDate: string;
  daysUntilRenewal: number;
  arrUsd: number | null;
  redactedFields: string[];
  usage: {
    month: string;
    protectedTb: number;
    apiCalls: number;
    activeUsers: number;
  } | null;
  degraded: boolean;
  degradedReasons: string[];
}

/**
 * Computes whole UTC days remaining from today's UTC midnight until renewalDate.
 */
function computeDaysUntilRenewal(renewalDate: string): number {
  const now = new Date();
  const todayUtcMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const renewalMs = Date.parse(`${renewalDate}T00:00:00Z`);
  return Math.ceil((renewalMs - todayUtcMs) / 86_400_000);
}

/**
 * Aggregates NetSuite customer entitlements and Snowflake SQL usage with graceful degradation
 * and scope-gated ARR redaction.
 */
@Injectable()
export class CustomersService {
  constructor(private readonly upstreams: UpstreamClientsService) {}

  async getCustomerById(
    rawId: string,
    actor: ActorContext,
    includeUsage = true,
  ): Promise<CustomerAggregateDto> {
    const accountId = canonicalizeAccountId(rawId);

    const entitlementPromise = this.upstreams.fetchNetSuiteEntitlement(accountId).catch((err) => {
      if (err instanceof UpstreamUnavailableError) {
        throw new ProblemException(HttpStatus.SERVICE_UNAVAILABLE, {
          title: 'Service Unavailable',
          detail: 'Entitlement upstream is temporarily unavailable',
          retryAfterSec: 5,
        });
      }
      throw err;
    });

    let degraded = false;
    const degradedReasons: string[] = [];

    const usagePromise: Promise<UsageRow | null> = includeUsage
      ? this.upstreams.fetchUsageSummary(accountId).catch((err) => {
          if (err instanceof UpstreamUnavailableError) {
            degraded = true;
            degradedReasons.push('usage_warehouse_unavailable');
            return null;
          }
          throw err;
        })
      : Promise.resolve(null);

    const [entitlement, usage] = await Promise.all([entitlementPromise, usagePromise]);

    if (!entitlement) {
      throw new ProblemException(HttpStatus.NOT_FOUND, {
        title: 'Not Found',
        detail: `Customer ${accountId} was not found`,
      });
    }

    const hasFinanceScope = actor.scopes.includes('finance:read');
    const arrUsd = hasFinanceScope ? entitlement.arrUsd : null;
    const redactedFields = hasFinanceScope ? [] : ['arrUsd'];

    return {
      accountId: entitlement.accountId,
      name: entitlement.name,
      supportTier: entitlement.supportTier,
      renewalDate: entitlement.renewalDate,
      daysUntilRenewal: computeDaysUntilRenewal(entitlement.renewalDate),
      arrUsd,
      redactedFields,
      usage: usage
        ? {
            month: usage.month,
            protectedTb: usage.protectedTb,
            apiCalls: usage.apiCalls,
            activeUsers: usage.activeUsers,
          }
        : null,
      degraded,
      degradedReasons,
    };
  }
}
