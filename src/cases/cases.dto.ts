import { Type } from 'class-transformer';
import { IsIn, IsInt, IsNumber, IsOptional, IsString, Length, Max, Min } from 'class-validator';

export type CaseStatus = 'open' | 'escalated' | 'closed';
export type CasePriority = 'P1' | 'P2' | 'P3';
export type CaseSort = 'openedAt:asc' | 'openedAt:desc' | 'priority:asc' | 'priority:desc';

export class ListCasesQueryDto {
  @IsOptional()
  @IsIn(['open', 'escalated', 'closed'])
  status?: CaseStatus;

  @IsOptional()
  @IsIn(['P1', 'P2', 'P3'])
  priority?: CasePriority;

  @IsOptional()
  @IsString()
  accountId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  minAgeHours?: number;

  @IsOptional()
  @IsIn(['openedAt:asc', 'openedAt:desc', 'priority:asc', 'priority:desc'])
  sort?: CaseSort = 'openedAt:desc';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @IsOptional()
  @IsString()
  cursor?: string;
}

export class CreateCommentDto {
  @IsString()
  @Length(1, 1000)
  body!: string;
}

export class EscalateCaseDto {
  @IsString()
  @Length(5, 500)
  reason!: string;

  @IsOptional()
  @IsIn(['P1', 'P2'])
  targetPriority?: 'P1' | 'P2' = 'P1';
}

export interface CaseCommentSummaryDto {
  id: string;
  author: string;
  body: string;
  createdAt: string;
}

export interface CaseCommentDto extends CaseCommentSummaryDto {
  caseId: string;
}

export interface CaseDto {
  id: string;
  accountId: string;
  priority: CasePriority;
  status: CaseStatus;
  openedAt: string;
  subject: string;
  etag: string;
  comments: CaseCommentSummaryDto[];
}

export interface CaseListResponseDto {
  items: CaseDto[];
  nextCursor: string | null;
}
