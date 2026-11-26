import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { RequestWithActor } from '../auth/auth.types.js';
import { RequiredScopes } from '../auth/scopes.decorator.js';
import {
  CreateCommentDto,
  EscalateCaseDto,
  ListCasesQueryDto,
  type CaseCommentDto,
  type CaseDto,
  type CaseListResponseDto,
} from './cases.dto.js';
import { CasesService } from './cases.service.js';

/**
 * Exposes case search, idempotent commenting, and optimistic-concurrency escalation endpoints.
 */
@Controller('v1/cases')
export class CasesController {
  constructor(private readonly casesService: CasesService) {}

  @Get()
  @RequiredScopes('support:read')
  async listCases(@Query() query: ListCasesQueryDto): Promise<CaseListResponseDto> {
    return this.casesService.listCases(query);
  }

  @Post(':id/comments')
  @HttpCode(201)
  @RequiredScopes('support:write')
  async addComment(
    @Param('id') caseId: string,
    @Body() dto: CreateCommentDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: RequestWithActor,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CaseCommentDto> {
    const result = await this.casesService.addComment(caseId, dto, idempotencyKey, req.actor!);
    if (result.replayed) {
      res.setHeader('Idempotent-Replayed', 'true');
    }
    return result.body;
  }

  @Post(':id/escalate')
  @HttpCode(200)
  @RequiredScopes('support:write')
  async escalateCase(
    @Param('id') caseId: string,
    @Body() dto: EscalateCaseDto,
    @Headers('if-match') ifMatch: string | undefined,
    @Req() req: RequestWithActor,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CaseDto> {
    const updated = await this.casesService.escalateCase(caseId, dto, ifMatch, req.actor!);
    res.setHeader('ETag', `"${updated.etag}"`);
    return updated;
  }
}
