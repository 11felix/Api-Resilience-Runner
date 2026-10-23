export type AttemptEvent = {
  logicalRequestId: string;
  attempt: number;
  method: string;
  path: string;
  startMs: number;
  endMs?: number;
  matchedRule?: string;
  fault?: string;
  forwarded: boolean;
  upstreamStatus?: number;
  upstreamComplete?: boolean;
  status?: number;
  retryAfterMs?: number;
  retryAfterStartMs?: number;
  outcome?: string;
};

export type Assertion = { name: string; passed: boolean; expected: unknown; actual: unknown };

export function createCollector(limit: number, started = performance.now()) {
  const events: AttemptEvent[] = [];
  let dropped = 0;
  return {
    events,
    now: () => performance.now() - started,
    add(event: AttemptEvent): void {
      if (events.length < limit) events.push(event);
      else dropped += 1;
    },
    get dropped() { return dropped; },
  };
}

export function check(name: string, expected: unknown, actual: unknown, passed = expected === actual): Assertion {
  return { name, passed, expected, actual };
}
