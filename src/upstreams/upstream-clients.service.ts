import { Injectable } from '@nestjs/common';
import { parse } from 'csv-parse/sync';
import { XMLParser } from 'fast-xml-parser';
import { StructuredLoggerService } from '../common/logger.service.js';
import { RequestContext } from '../common/request-context.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ResilienceExecutor } from '../resilience/resilience.executor.js';
import { MockUpstreamServer } from './mock-upstream.server.js';

export type SupportTier = 'Platinum' | 'Gold' | 'Silver';

export interface RawSalesforceComment {
  id: string;
  author: string;
  body: string;
  at: string;
}

export interface RawSalesforceCase {
  id: string;
  accountId: string;
  priority: 'P1' | 'P2' | 'P3';
  Status: string;
  openedAt: string;
  subject: string;
  Comments?: RawSalesforceComment[];
}

export interface NormalizedEntitlement {
  accountId: string;
  name: string;
  supportTier: SupportTier;
  renewalDate: string;
  arrUsd: number;
}

export interface UsageRow {
  accountId: string;
  month: string;
  protectedTb: number;
  apiCalls: number;
  activeUsers: number;
}

const LEGACY_ACCOUNT_ALIASES: Record<string, string> = {
  'ACC-77': 'ACC-007',
};

/**
 * Normalizes legacy account IDs via explicit alias table and zero-padding for ACC-<n>.
 */
export function canonicalizeAccountId(rawId: string): string {
  const upper = rawId.trim().toUpperCase();
  if (LEGACY_ACCOUNT_ALIASES[upper]) {
    return LEGACY_ACCOUNT_ALIASES[upper];
  }
  const match = /^ACC-(\d+)$/.exec(upper);
  if (match) {
    return `ACC-${match[1].padStart(3, '0')}`;
  }
  return upper;
}

/**
 * Fetches and normalizes upstream Salesforce, NetSuite (CSV + XML), and Snowflake SQL data.
 */
@Injectable()
export class UpstreamClientsService {
  private readonly xmlParser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
  });

  constructor(
    private readonly mockServer: MockUpstreamServer,
    private readonly resilience: ResilienceExecutor,
    private readonly prisma: PrismaService,
    private readonly logger: StructuredLoggerService,
  ) {}

  private buildOutboundHeaders(): Record<string, string> {
    const ctx = RequestContext.get();
    const headers: Record<string, string> = {};
    if (ctx?.correlationId) {
      headers['X-Correlation-ID'] = ctx.correlationId;
    }
    if (ctx && ctx.faultInject.size > 0) {
      const pairs = Array.from(ctx.faultInject.entries()).map(([k, v]) => `${k}=${v}`);
      headers['X-Fault-Inject'] = pairs.join(',');
    }
    return headers;
  }

  async fetchSalesforceCases(): Promise<RawSalesforceCase[]> {
    const baseUrl = `http://127.0.0.1:${this.mockServer.getPort()}`;
    const response = await this.resilience.executeHttp(
      'salesforce',
      `${baseUrl}/mock/salesforce/cases`,
      { headers: this.buildOutboundHeaders() },
    );
    return (await response.json()) as RawSalesforceCase[];
  }

  async fetchNetSuiteEntitlement(rawId: string): Promise<NormalizedEntitlement | null> {
    const targetId = canonicalizeAccountId(rawId);
    const baseUrl = `http://127.0.0.1:${this.mockServer.getPort()}`;
    const headers = this.buildOutboundHeaders();

    const csvPromise = this.resilience
      .executeHttp('netsuite', `${baseUrl}/mock/netsuite/entitlements.csv`, { headers })
      .then((r) => r.text());

    const xmlPromise = this.resilience
      .executeHttp('netsuite-xml', `${baseUrl}/mock/netsuite/entitlements.xml`, { headers })
      .then((r) => r.text())
      .catch((err: unknown) => {
        this.logger.warn('netsuite_xml_fallback_to_csv', {
          accountId: targetId,
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      });

    const [csvText, xmlText] = await Promise.all([csvPromise, xmlPromise]);

    const csvRows = parse(csvText, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    }) as Array<{
      account_id: string;
      name: string;
      support_tier: SupportTier;
      contract_end: string;
      arr_usd: string;
    }>;

    const csvMatch = csvRows.find((row) => canonicalizeAccountId(row.account_id) === targetId);
    if (!csvMatch) {
      return null;
    }

    if (xmlText) {
      this.crossCheckXmlEntitlement(targetId, csvMatch, xmlText);
    }

    return {
      accountId: targetId,
      name: csvMatch.name,
      supportTier: csvMatch.support_tier,
      renewalDate: csvMatch.contract_end,
      arrUsd: Number.parseFloat(csvMatch.arr_usd),
    };
  }

  async fetchUsageSummary(rawId: string): Promise<UsageRow | null> {
    const targetId = canonicalizeAccountId(rawId);
    return this.resilience.executeSql('snowflake', this.prisma, async (tx) => {
      const rows = await tx.$queryRaw<
        Array<{
          account_id: string;
          month: string;
          protected_tb: number;
          api_calls: number;
          active_users: number;
        }>
      >`SELECT account_id, month, protected_tb, api_calls, active_users
        FROM usage_metrics
        WHERE account_id = ${targetId}
        ORDER BY month DESC
        LIMIT 1`;

      const row = rows[0];
      if (!row) {
        return null;
      }
      return {
        accountId: row.account_id,
        month: row.month,
        protectedTb: Number(row.protected_tb),
        apiCalls: Number(row.api_calls),
        activeUsers: Number(row.active_users),
      };
    });
  }

  private crossCheckXmlEntitlement(
    accountId: string,
    csvRow: { support_tier: string; contract_end: string },
    xmlText: string,
  ): void {
    try {
      const parsed = this.xmlParser.parse(xmlText) as {
        accounts?: {
          account?:
            | Array<{ '@_id'?: string; tier?: string; renewal?: string }>
            | { '@_id'?: string; tier?: string; renewal?: string };
        };
      };
      const rawList = parsed.accounts?.account;
      const accounts = Array.isArray(rawList) ? rawList : rawList ? [rawList] : [];
      const match = accounts.find(
        (acc) => typeof acc['@_id'] === 'string' && canonicalizeAccountId(acc['@_id']) === accountId,
      );
      if (match) {
        if (match.tier !== csvRow.support_tier || match.renewal !== csvRow.contract_end) {
          this.logger.warn('netsuite_csv_xml_mismatch_csv_wins', {
            accountId,
            csvTier: csvRow.support_tier,
            xmlTier: match.tier,
            csvRenewal: csvRow.contract_end,
            xmlRenewal: match.renewal,
          });
        }
      }
    } catch (err) {
      this.logger.warn('netsuite_xml_parse_failed', {
        accountId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
