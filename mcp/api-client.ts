import { randomUUID } from 'node:crypto';
import type { RawCasesListResponse, RawCustomerResponse } from './guardrails.js';

export interface McpApiClientConfig {
  baseUrl?: string;
  jwt?: string;
  agentId?: string;
  fetchFn?: typeof fetch;
}

export class McpApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'McpApiError';
  }
}

/**
 * Formats an expected ETag into a strong RFC 9110 double-quoted ETag header value.
 */
export function formatIfMatchHeader(expectedEtag: string): string {
  const trimmed = expectedEtag.trim();
  if (!trimmed) {
    throw new McpApiError(428, 'MISSING_ETAG', 'expectedEtag must be a non-empty ETag value');
  }
  if (trimmed.startsWith('W/') || (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2)) {
    return trimmed;
  }
  return `"${trimmed.replace(/"/g, '')}"`;
}

/**
 * Typed HTTP client used by the MCP server to call the NestJS Platform REST API.
 */
export class McpApiClient {
  private readonly baseUrl: string;
  private readonly jwt: string;
  private readonly agentId: string;
  private readonly fetchFn: typeof fetch;

  constructor(config: McpApiClientConfig = {}) {
    this.baseUrl = (config.baseUrl ?? process.env.API_BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');
    this.jwt = config.jwt ?? process.env.MCP_USER_JWT ?? '';
    this.agentId = config.agentId ?? process.env.MCP_AGENT_ID ?? 'support-copilot';
    this.fetchFn = config.fetchFn ?? fetch;
  }

  async searchCases(params: {
    status?: 'open' | 'escalated' | 'closed';
    priority?: 'P1' | 'P2' | 'P3';
    accountId?: string;
    minAgeHours?: number;
    sort?: 'openedAt:asc' | 'openedAt:desc' | 'priority:asc' | 'priority:desc';
    limit?: number;
    cursor?: string;
  }): Promise<RawCasesListResponse> {
    const query = new URLSearchParams();
    if (params.status) query.set('status', params.status);
    if (params.priority) query.set('priority', params.priority);
    if (params.accountId) query.set('accountId', params.accountId);
    if (params.minAgeHours !== undefined) query.set('minAgeHours', String(params.minAgeHours));
    if (params.sort) query.set('sort', params.sort);
    if (params.limit !== undefined) query.set('limit', String(params.limit));
    if (params.cursor) query.set('cursor', params.cursor);

    const suffix = query.toString() ? `?${query.toString()}` : '';
    return this.request<RawCasesListResponse>('GET', `/v1/cases${suffix}`);
  }

  async getCustomerSummary(accountId: string, includeUsage = true): Promise<RawCustomerResponse> {
    return this.request<RawCustomerResponse>(
      'GET',
      `/v1/customers/${encodeURIComponent(accountId)}?includeUsage=${includeUsage ? 'true' : 'false'}`,
    );
  }

  async addCaseComment(
    caseId: string,
    body: string,
    idempotencyKey: string,
  ): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(
      'POST',
      `/v1/cases/${encodeURIComponent(caseId)}/comments`,
      {
        body: { body },
        headers: {
          'Idempotency-Key': idempotencyKey,
        },
      },
    );
  }

  async escalateCase(
    caseId: string,
    expectedEtag: string,
    reason: string,
    targetPriority: 'P1' | 'P2' = 'P1',
  ): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(
      'POST',
      `/v1/cases/${encodeURIComponent(caseId)}/escalate`,
      {
        body: { reason, targetPriority },
        headers: {
          'If-Match': formatIfMatchHeader(expectedEtag),
        },
      },
    );
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    options?: {
      body?: unknown;
      headers?: Record<string, string>;
    },
  ): Promise<T> {
    if (!this.jwt) {
      throw new McpApiError(
        401,
        'MISSING_MCP_JWT',
        'MCP_USER_JWT is not configured; cannot authenticate REST API call',
      );
    }

    const correlationId = randomUUID();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.jwt}`,
      'X-Agent-Id': this.agentId,
      'X-Correlation-ID': correlationId,
      ...(options?.headers ?? {}),
    };
    if (options?.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    const res = await this.fetchFn(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });

    const text = await res.text();
    const parsed = text ? this.tryParseJson(text) : null;

    if (!res.ok) {
      const code = typeof parsed?.code === 'string' ? parsed.code : `HTTP_${res.status}`;
      const title = typeof parsed?.title === 'string' ? parsed.title : res.statusText || 'API Error';
      const detail = typeof parsed?.detail === 'string' ? parsed.detail : text || title;
      throw new McpApiError(res.status, code, `[${res.status}] ${code}: ${detail}`);
    }

    return (parsed ?? {}) as T;
  }

  private tryParseJson(raw: string): Record<string, unknown> | null {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}
