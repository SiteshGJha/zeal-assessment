export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  cooldownMs?: number;
}

/**
 * Per-upstream circuit breaker implementing CLOSED -> OPEN -> HALF_OPEN transitions.
 */
export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private consecutiveFailures = 0;
  private openedAtMs = 0;
  private halfOpenProbeInFlight = false;

  private readonly failureThreshold: number;
  private readonly cooldownMs: number;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 3;
    this.cooldownMs = options.cooldownMs ?? 15_000;
  }

  canExecute(nowMs = Date.now()): boolean {
    if (this.state === 'CLOSED') {
      return true;
    }
    if (this.state === 'OPEN') {
      if (nowMs - this.openedAtMs >= this.cooldownMs) {
        this.state = 'HALF_OPEN';
        this.halfOpenProbeInFlight = true;
        return true;
      }
      return false;
    }
    // HALF_OPEN allows a single probe request.
    if (!this.halfOpenProbeInFlight) {
      this.halfOpenProbeInFlight = true;
      return true;
    }
    return false;
  }

  recordSuccess(): void {
    this.state = 'CLOSED';
    this.consecutiveFailures = 0;
    this.halfOpenProbeInFlight = false;
  }

  recordFailure(nowMs = Date.now()): void {
    this.halfOpenProbeInFlight = false;
    if (this.state === 'HALF_OPEN') {
      this.state = 'OPEN';
      this.openedAtMs = nowMs;
      return;
    }
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.failureThreshold) {
      this.state = 'OPEN';
      this.openedAtMs = nowMs;
    }
  }

  getState(nowMs = Date.now()): CircuitState {
    if (this.state === 'OPEN' && nowMs - this.openedAtMs >= this.cooldownMs) {
      return 'HALF_OPEN';
    }
    return this.state;
  }

  reset(): void {
    this.state = 'CLOSED';
    this.consecutiveFailures = 0;
    this.openedAtMs = 0;
    this.halfOpenProbeInFlight = false;
  }
}
