export const MAX_TEXT_CHARS = 500;
export const MAX_PAYLOAD_BYTES = 8192;

const UNTRUSTED_TAG_REGEX = /<\/?\s*untrusted_case_data\b[^>]*>/gi;
const EMAIL_REGEX = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE_REGEX =
  /(?<!\w)(?:\+\d{1,3}[\s.-]?(?:\(\d{2,4}\)|\d{2,4})[\s.-]?\d{3,4}[\s.-]?\d{4}|(?:\(\d{3}\)\s?|\d{3}[\s.-])\d{3}[\s.-]\d{4})(?!\w)/g;

function removeControlChars(input: string): string {
  let out = '';
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    if ((code >= 0x20 && code !== 0x7f) || code === 0x09 || code === 0x0a || code === 0x0d) {
      out += input[i];
    }
  }
  return out;
}

export interface RawCaseComment {
  id: string;
  author: string;
  body: string;
  createdAt: string;
}

export interface RawCaseItem {
  id: string;
  accountId: string;
  priority: string;
  status: string;
  openedAt: string;
  subject: string;
  etag: string;
  comments?: RawCaseComment[];
  [key: string]: unknown;
}

export interface RawCasesListResponse {
  items: RawCaseItem[];
  nextCursor: string | null;
}

export interface SanitizedCasesListResponse {
  items: RawCaseItem[];
  nextCursor: string | null;
  truncated: boolean;
}

export interface RawCustomerResponse {
  accountId: string;
  name: string;
  supportTier: string;
  renewalDate: string;
  daysUntilRenewal?: number;
  arrUsd: number | null;
  redactedFields?: string[];
  usage?: Record<string, unknown> | null;
  degraded?: boolean;
  degradedReasons?: string[];
  [key: string]: unknown;
}

export interface EscalationConfirmationRequired {
  status: 'CONFIRMATION_REQUIRED';
  action: 'escalate_case';
  caseId: string;
  preview: {
    caseId: string;
    targetPriority: 'P1' | 'P2';
    expectedEtag: string;
    reason: string;
  };
  message: string;
}

export interface McpAuditEvent {
  event: string;
  tool?: string;
  agentId?: string;
  reason?: string;
  caseId?: string;
  details?: Record<string, unknown>;
}

/**
 * Strips C0 control characters (preserving tabs/newlines) and any forged untrusted XML delimiters.
 */
export function stripControlAndTags(input: string): string {
  return removeControlChars(input).replace(UNTRUSTED_TAG_REGEX, '');
}

/**
 * Redacts email addresses and phone numbers without altering IDs or timestamps.
 */
export function scrubPii(input: string): string {
  return input.replace(EMAIL_REGEX, '[REDACTED_EMAIL]').replace(PHONE_REGEX, '[REDACTED_PHONE]');
}

/**
 * Sanitizes free-form text (control char stripping, tag stripping, PII scrubbing, length truncation).
 */
export function sanitizeText(input: string, maxChars = MAX_TEXT_CHARS): string {
  const cleaned = scrubPii(stripControlAndTags(input));
  if (cleaned.length <= maxChars) {
    return cleaned;
  }
  return `${cleaned.slice(0, Math.max(0, maxChars - 3))}...`;
}

/**
 * Sanitizes and wraps untrusted customer or case text in explicit XML delimiters.
 */
export function wrapUntrustedData(input: string, maxChars = MAX_TEXT_CHARS): string {
  return `<untrusted_case_data>${sanitizeText(input, maxChars)}</untrusted_case_data>`;
}

/**
 * Sanitizes a single case DTO for safe LLM consumption.
 */
export function sanitizeCaseRecord(item: RawCaseItem): RawCaseItem {
  const sanitizedComments = Array.isArray(item.comments)
    ? item.comments.map((comment) => ({
        ...comment,
        author: sanitizeText(String(comment.author ?? ''), 120),
        body: wrapUntrustedData(String(comment.body ?? '')),
      }))
    : undefined;

  const sanitized: RawCaseItem = {
    ...item,
    subject: wrapUntrustedData(String(item.subject ?? '')),
    ...(sanitizedComments !== undefined ? { comments: sanitizedComments } : {}),
  };
  if (typeof item.accountName === 'string') {
    sanitized.accountName = wrapUntrustedData(item.accountName);
  }
  return sanitized;
}

/**
 * Sanitizes case search output and structurally truncates items below MAX_PAYLOAD_BYTES.
 */
export function sanitizeCasesResponse(
  response: RawCasesListResponse,
  maxBytes = MAX_PAYLOAD_BYTES,
): SanitizedCasesListResponse {
  const payload: SanitizedCasesListResponse = {
    items: (response.items ?? []).map(sanitizeCaseRecord),
    nextCursor: response.nextCursor ?? null,
    truncated: false,
  };

  while (payload.items.length > 0 && Buffer.byteLength(JSON.stringify(payload), 'utf8') > maxBytes) {
    payload.items.pop();
    payload.truncated = true;
    payload.nextCursor = null;
  }

  return payload;
}

/**
 * Sanitizes customer aggregate DTO before returning it through MCP.
 */
export function sanitizeCustomerSummary(
  customer: RawCustomerResponse,
  maxBytes = MAX_PAYLOAD_BYTES,
): RawCustomerResponse {
  const sanitized: RawCustomerResponse = {
    ...customer,
    name: wrapUntrustedData(String(customer.name ?? '')),
  };

  if (Buffer.byteLength(JSON.stringify(sanitized), 'utf8') > maxBytes) {
    sanitized.name = wrapUntrustedData(String(customer.name ?? ''), 120);
    if (sanitized.usage) {
      sanitized.usage = { truncated: true };
    }
  }

  return sanitized;
}

/**
 * Evaluates the out-of-band human-in-the-loop confirmation gate for case escalation.
 */
export function evaluateEscalationGate(
  input: {
    caseId: string;
    expectedEtag: string;
    reason: string;
    targetPriority?: 'P1' | 'P2';
    confirmed?: boolean;
  },
  env: NodeJS.ProcessEnv = process.env,
): { allowed: true } | { allowed: false; response: EscalationConfirmationRequired } {
  const executionEnabled = env.MCP_ALLOW_ESCALATE_EXECUTION === 'true';
  if (executionEnabled && input.confirmed === true) {
    return { allowed: true };
  }

  return {
    allowed: false,
    response: {
      status: 'CONFIRMATION_REQUIRED',
      action: 'escalate_case',
      caseId: input.caseId,
      preview: {
        caseId: input.caseId,
        targetPriority: input.targetPriority ?? 'P1',
        expectedEtag: input.expectedEtag,
        reason: sanitizeText(input.reason),
      },
      message:
        'Escalation requires explicit out-of-band human confirmation before execution. Ask an operator to approve this preview and execute via the host API or approved execution flow.',
    },
  };
}

/**
 * Emits structured JSON security/audit logs to stderr so stdout stays strictly JSON-RPC.
 */
export function logMcpAudit(entry: McpAuditEvent): void {
  process.stderr.write(
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      component: 'mcp-server',
      ...entry,
    })}\n`,
  );
}
