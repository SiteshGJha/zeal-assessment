import { createHash, randomUUID } from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { ActorContext } from '../auth/auth.types.js';
import { ProblemException } from '../common/problem-details.filter.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { UpstreamUnavailableError } from '../resilience/resilience.executor.js';
import {
  canonicalizeAccountId,
  UpstreamClientsService,
  type RawSalesforceCase,
} from '../upstreams/upstream-clients.service.js';
import type {
  CaseCommentDto,
  CaseCommentSummaryDto,
  CaseDto,
  CaseListResponseDto,
  CasePriority,
  CaseSort,
  CaseStatus,
  CreateCommentDto,
  EscalateCaseDto,
  ListCasesQueryDto,
} from './cases.dto.js';

export const PRIORITY_RANK: Record<CasePriority, number> = {
  P1: 3,
  P2: 2,
  P3: 1,
};

interface CaseCursorPayload {
  sort: CaseSort;
  filterHash: string;
  asOf: string;
  sortKey: number | string;
  openedAt: string;
  id: string;
}

/**
 * Recursively sorts object keys for deterministic JSON SHA-256 request hashing.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Computes SHA-256 hash over HTTP method, path, actorSub, and canonical request body.
 */
export function computeIdempotencyRequestHash(
  method: string,
  path: string,
  actorSub: string,
  body: unknown,
): string {
  return createHash('sha256')
    .update(`${method}:${path}:${actorSub}:${canonicalJson(body)}`)
    .digest('hex');
}

/**
 * Parses a strong HTTP ETag header ("v1") and returns the integer version number.
 */
export function parseStrongEtagVersion(ifMatch: string | undefined): number {
  if (!ifMatch) {
    throw new ProblemException(HttpStatus.PRECONDITION_REQUIRED, {
      title: 'Precondition Required',
      detail: 'If-Match header is required for case escalation',
    });
  }
  const match = /^"v(\d+)"$/.exec(ifMatch.trim());
  if (!match) {
    throw new ProblemException(HttpStatus.PRECONDITION_FAILED, {
      title: 'Precondition Failed',
      detail: 'If-Match must be a strong ETag matching format "v<version>"',
    });
  }
  return Number.parseInt(match[1], 10);
}

function compareCases(a: CaseDto, b: CaseDto, sort: CaseSort): number {
  if (sort === 'openedAt:asc') {
    const diff = Date.parse(a.openedAt) - Date.parse(b.openedAt);
    return diff !== 0 ? diff : a.id.localeCompare(b.id);
  }
  if (sort === 'openedAt:desc') {
    const diff = Date.parse(b.openedAt) - Date.parse(a.openedAt);
    return diff !== 0 ? diff : a.id.localeCompare(b.id);
  }
  if (sort === 'priority:desc') {
    const rankDiff = PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority];
    if (rankDiff !== 0) return rankDiff;
    const dateDiff = Date.parse(b.openedAt) - Date.parse(a.openedAt);
    return dateDiff !== 0 ? dateDiff : a.id.localeCompare(b.id);
  }
  // priority:asc (P3 -> P2 -> P1)
  const rankDiff = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
  if (rankDiff !== 0) return rankDiff;
  const dateDiff = Date.parse(b.openedAt) - Date.parse(a.openedAt);
  return dateDiff !== 0 ? dateDiff : a.id.localeCompare(b.id);
}

function compareAgainstCursor(item: CaseDto, cursor: CaseCursorPayload): number {
  const cursorStub: CaseDto = {
    id: cursor.id,
    accountId: '',
    priority:
      cursor.sortKey === 3 ? 'P1' : cursor.sortKey === 2 ? 'P2' : 'P3',
    status: 'open',
    openedAt: cursor.openedAt,
    subject: '',
    etag: 'v1',
    comments: [],
  };
  return compareCases(item, cursorStub, cursor.sort);
}

/**
 * Implements support case search, idempotent commenting, and optimistic-concurrency escalation.
 */
@Injectable()
export class CasesService {
  constructor(
    private readonly upstreams: UpstreamClientsService,
    private readonly prisma: PrismaService,
  ) {}

  async listCases(query: ListCasesQueryDto): Promise<CaseListResponseDto> {
    const sort: CaseSort = query.sort ?? 'openedAt:desc';
    const limit = query.limit ?? 20;
    const canonicalAccountFilter = query.accountId
      ? canonicalizeAccountId(query.accountId)
      : undefined;

    const filterHash = createHash('sha256')
      .update(
        JSON.stringify({
          status: query.status ?? null,
          priority: query.priority ?? null,
          accountId: canonicalAccountFilter ?? null,
          minAgeHours: query.minAgeHours ?? null,
        }),
      )
      .digest('hex');

    let decodedCursor: CaseCursorPayload | null = null;
    if (query.cursor) {
      decodedCursor = this.decodeCursor(query.cursor);
      if (decodedCursor.sort !== sort || decodedCursor.filterHash !== filterHash) {
        throw new ProblemException(HttpStatus.BAD_REQUEST, {
          title: 'Bad Request',
          detail: 'Cursor does not match active sort or filter parameters',
        });
      }
    }

    const asOf = decodedCursor?.asOf ?? new Date().toISOString();
    const asOfMs = Date.parse(asOf);

    const rawCases = await this.fetchSalesforceWithProblemMapping();
    const overlays = await this.prisma.caseRecord.findMany({
      include: { comments: true },
    });
    const overlayMap = new Map(overlays.map((row) => [row.id, row]));

    const normalized = rawCases
      .map((raw) => this.mergeCaseWithOverlay(raw, overlayMap.get(raw.id)))
      .filter((c) => Date.parse(c.openedAt) <= asOfMs)
      .filter((c) => (!query.status ? true : c.status === query.status))
      .filter((c) => (!query.priority ? true : c.priority === query.priority))
      .filter((c) => (!canonicalAccountFilter ? true : c.accountId === canonicalAccountFilter))
      .filter((c) => {
        if (query.minAgeHours === undefined) return true;
        const ageHours = (asOfMs - Date.parse(c.openedAt)) / 3_600_000;
        return ageHours >= query.minAgeHours;
      })
      .sort((a, b) => compareCases(a, b, sort));

    const afterCursor = decodedCursor
      ? normalized.filter((item) => compareAgainstCursor(item, decodedCursor!) > 0)
      : normalized;

    const items = afterCursor.slice(0, limit);
    let nextCursor: string | null = null;
    if (afterCursor.length > limit && items.length > 0) {
      const last = items[items.length - 1];
      const cursorObj: CaseCursorPayload = {
        sort,
        filterHash,
        asOf,
        sortKey: sort.startsWith('priority:') ? PRIORITY_RANK[last.priority] : last.openedAt,
        openedAt: last.openedAt,
        id: last.id,
      };
      nextCursor = Buffer.from(JSON.stringify(cursorObj), 'utf8').toString('base64url');
    }

    return { items, nextCursor };
  }

  async addComment(
    caseId: string,
    dto: CreateCommentDto,
    idempotencyKey: string | undefined,
    actor: ActorContext,
  ): Promise<{ body: CaseCommentDto; replayed: boolean }> {
    if (!idempotencyKey || idempotencyKey.trim().length === 0 || idempotencyKey.length > 128) {
      throw new ProblemException(HttpStatus.BAD_REQUEST, {
        title: 'Bad Request',
        detail: 'Missing or invalid Idempotency-Key header',
      });
    }

    const baseCase = await this.findBaseCaseOrThrow(caseId);
    const path = `/v1/cases/${caseId}/comments`;
    const requestHash = computeIdempotencyRequestHash('POST', path, actor.sub, dto);

    try {
      const responseBody = await this.prisma.$transaction(async (tx) => {
        await tx.caseRecord.createMany({
          data: [
            {
              id: caseId,
              status: baseCase.Status.toLowerCase(),
              priority: baseCase.priority,
              version: 1,
            },
          ],
          skipDuplicates: true,
        });

        const comment = await tx.caseComment.create({
          data: {
            caseId,
            author: actor.sub,
            body: dto.body,
          },
        });

        const payload: CaseCommentDto = {
          id: comment.id,
          caseId,
          author: comment.author,
          body: comment.body,
          createdAt: comment.createdAt.toISOString(),
        };

        await tx.idempotencyRecord.create({
          data: {
            idempotencyKey,
            method: 'POST',
            path,
            actorSub: actor.sub,
            requestHash,
            statusCode: 201,
            responseBody: payload as unknown as Prisma.InputJsonValue,
          },
        });

        return payload;
      });

      return { body: responseBody, replayed: false };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const existing = await this.prisma.idempotencyRecord.findUnique({
          where: {
            idempotencyKey_method_path_actorSub: {
              idempotencyKey,
              method: 'POST',
              path,
              actorSub: actor.sub,
            },
          },
        });
        if (!existing) {
          throw err;
        }
        if (existing.requestHash !== requestHash) {
          throw new ProblemException(HttpStatus.CONFLICT, {
            title: 'Conflict',
            detail: 'Idempotency-Key was already used with a different request payload',
          });
        }
        return {
          body: existing.responseBody as unknown as CaseCommentDto,
          replayed: true,
        };
      }
      throw err;
    }
  }

  async escalateCase(
    caseId: string,
    dto: EscalateCaseDto,
    ifMatch: string | undefined,
    actor: ActorContext,
  ): Promise<CaseDto> {
    const expectedVersion = parseStrongEtagVersion(ifMatch);
    const targetPriority = dto.targetPriority ?? 'P1';
    const baseCase = await this.findBaseCaseOrThrow(caseId);

    const updatedRecord = await this.prisma.$transaction(async (tx) => {
      await tx.caseRecord.createMany({
        data: [
          {
            id: caseId,
            status: baseCase.Status.toLowerCase(),
            priority: baseCase.priority,
            version: 1,
          },
        ],
        skipDuplicates: true,
      });

      const current = await tx.caseRecord.findUniqueOrThrow({
        where: { id: caseId },
        include: { comments: true },
      });

      if (current.version !== expectedVersion) {
        throw new ProblemException(HttpStatus.PRECONDITION_FAILED, {
          title: 'Precondition Failed',
          detail: `Case ${caseId} ETag mismatch: expected "v${expectedVersion}", current "v${current.version}"`,
        });
      }

      if (current.status !== 'open') {
        throw new ProblemException(HttpStatus.UNPROCESSABLE_ENTITY, {
          title: 'Unprocessable Entity',
          detail: `Case ${caseId} cannot be escalated from status "${current.status}"`,
        });
      }

      const currentPriority = current.priority as CasePriority;
      if (PRIORITY_RANK[targetPriority] <= PRIORITY_RANK[currentPriority]) {
        throw new ProblemException(HttpStatus.UNPROCESSABLE_ENTITY, {
          title: 'Unprocessable Entity',
          detail: `Target priority ${targetPriority} must be higher severity than current priority ${currentPriority}`,
        });
      }

      const updateResult = await tx.caseRecord.updateMany({
        where: {
          id: caseId,
          version: expectedVersion,
          status: 'open',
        },
        data: {
          status: 'escalated',
          priority: targetPriority,
          version: { increment: 1 },
        },
      });

      if (updateResult.count === 0) {
        throw new ProblemException(HttpStatus.PRECONDITION_FAILED, {
          title: 'Precondition Failed',
          detail: `Case ${caseId} was modified concurrently`,
        });
      }

      const nextRecord = await tx.caseRecord.findUniqueOrThrow({
        where: { id: caseId },
        include: { comments: true },
      });

      const subscriptions = await tx.webhookSubscription.findMany({
        where: { eventType: 'case.escalated', active: true },
      });

      if (subscriptions.length > 0) {
        const occurredAt = new Date().toISOString();
        const canonicalAcc = canonicalizeAccountId(baseCase.accountId);
        await tx.webhookOutbox.createMany({
          data: subscriptions.map((sub) => ({
            subscriptionId: sub.id,
            eventType: 'case.escalated',
            payload: {
              eventId: randomUUID(),
              eventType: 'case.escalated',
              occurredAt,
              data: {
                caseId,
                accountId: canonicalAcc,
                previousPriority: currentPriority,
                newPriority: targetPriority,
                status: 'escalated',
                reason: dto.reason,
                actorSub: actor.sub,
              },
            } as unknown as Prisma.InputJsonValue,
          })),
        });
      }

      return nextRecord;
    });

    return this.mergeCaseWithOverlay(baseCase, updatedRecord);
  }

  private async fetchSalesforceWithProblemMapping(): Promise<RawSalesforceCase[]> {
    try {
      return await this.upstreams.fetchSalesforceCases();
    } catch (err) {
      if (err instanceof UpstreamUnavailableError) {
        throw new ProblemException(HttpStatus.SERVICE_UNAVAILABLE, {
          title: 'Service Unavailable',
          detail: 'Case upstream is temporarily unavailable',
          retryAfterSec: 5,
        });
      }
      throw err;
    }
  }

  private async findBaseCaseOrThrow(caseId: string): Promise<RawSalesforceCase> {
    const cases = await this.fetchSalesforceWithProblemMapping();
    const match = cases.find((c) => c.id === caseId);
    if (!match) {
      throw new ProblemException(HttpStatus.NOT_FOUND, {
        title: 'Not Found',
        detail: `Case ${caseId} was not found`,
      });
    }
    return match;
  }

  private mergeCaseWithOverlay(
    raw: RawSalesforceCase,
    overlay?: {
      status: string;
      priority: string;
      version: number;
      comments: Array<{ id: string; author: string; body: string; createdAt: Date }>;
    },
  ): CaseDto {
    const commentsById = new Map<string, CaseCommentSummaryDto>();
    for (const c of raw.Comments ?? []) {
      commentsById.set(c.id, {
        id: c.id,
        author: c.author,
        body: c.body,
        createdAt: c.at,
      });
    }
    for (const c of overlay?.comments ?? []) {
      commentsById.set(c.id, {
        id: c.id,
        author: c.author,
        body: c.body,
        createdAt: c.createdAt.toISOString(),
      });
    }
    const comments = Array.from(commentsById.values()).sort(
      (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
    );

    const version = overlay?.version ?? 1;
    return {
      id: raw.id,
      accountId: canonicalizeAccountId(raw.accountId),
      priority: (overlay?.priority ?? raw.priority) as CasePriority,
      status: (overlay?.status ?? raw.Status.toLowerCase()) as CaseStatus,
      openedAt: raw.openedAt,
      subject: raw.subject,
      etag: `v${version}`,
      comments,
    };
  }

  private decodeCursor(rawCursor: string): CaseCursorPayload {
    try {
      const json = Buffer.from(rawCursor, 'base64url').toString('utf8');
      const parsed = JSON.parse(json) as Partial<CaseCursorPayload>;
      if (
        !parsed ||
        typeof parsed.sort !== 'string' ||
        typeof parsed.filterHash !== 'string' ||
        typeof parsed.asOf !== 'string' ||
        typeof parsed.openedAt !== 'string' ||
        typeof parsed.id !== 'string'
      ) {
        throw new Error('Incomplete cursor payload');
      }
      return parsed as CaseCursorPayload;
    } catch {
      throw new ProblemException(HttpStatus.BAD_REQUEST, {
        title: 'Bad Request',
        detail: 'Malformed pagination cursor',
      });
    }
  }
}
