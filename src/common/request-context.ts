import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestStore {
  correlationId: string;
  actorSub?: string;
  agentId?: string;
  faultInject: Map<string, string>;
  faultScopeCircuitBreaker: boolean;
}

const storage = new AsyncLocalStorage<RequestStore>();

/**
 * Parses comma-separated X-Fault-Inject directives (e.g., "snowflake=timeout,netsuite-xml=503").
 */
export function parseFaultInjectHeader(raw: string | string[] | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (process.env.FAULT_INJECTION_ENABLED !== 'true') {
    return map;
  }
  const value = Array.isArray(raw) ? raw.join(',') : raw;
  if (!value) {
    return map;
  }
  for (const part of value.split(',')) {
    const trimmed = part.trim();
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex > 0) {
      const target = trimmed.slice(0, eqIndex).trim().toLowerCase();
      const fault = trimmed.slice(eqIndex + 1).trim().toLowerCase();
      if (target && fault) {
        map.set(target, fault);
      }
    }
  }
  return map;
}

/**
 * Provides request-scoped correlation, actor, and fault-injection context via AsyncLocalStorage.
 */
export const RequestContext = {
  run<T>(store: RequestStore, fn: () => T): T {
    return storage.run(store, fn);
  },
  get(): RequestStore | undefined {
    return storage.getStore();
  },
};
