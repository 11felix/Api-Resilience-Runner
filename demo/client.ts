import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Scenario } from '../src/scenario.js';

type Reply = { status: number; body: unknown; retryAfter?: string };
export type ClientAttempt = {
  attempt: number;
  startMs: number;
  endMs: number;
  status?: number;
  error?: string;
};
export type ClientResult = {
  outcome: 'success' | 'failure';
  attempts: ClientAttempt[];
  durationMs: number;
  reason?: string;
};

export function retryAfterMs(
  value: string | undefined,
  now = Date.now(),
): number | undefined {
  if (value === undefined) return undefined;
  if (/^\d+$/.test(value)) {
    const milliseconds = Number(value) * 1000;
    return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
  }
  if (
    !/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)
  )
    return undefined;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

export function requestJson(
  url: string,
  options: {
    method?: string;
    body?: string;
    headers?: Record<string, string>;
    timeoutMs: number;
    signal?: AbortSignal;
    acceptHeadersOnly?: boolean;
  },
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, reply?: Reply) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else if (reply) resolve(reply);
      req.destroy();
    };
    const timer = setTimeout(
      () => finish(new Error('attempt-deadline')),
      options.timeoutMs,
    );
    const req = request(
      url,
      {
        method: options.method ?? 'GET',
        agent: false,
        signal: options.signal,
        headers: {
          ...options.headers,
          ...(options.body === undefined
            ? {}
            : {
                'Content-Type': 'application/json',
                'Content-Length': String(Buffer.byteLength(options.body)),
              }),
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        res.on('error', () => finish(new Error('incomplete-response')));
        if (options.acceptHeadersOnly && status >= 200 && status < 300) {
          res.destroy();
          finish(undefined, { status, body: null });
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 1024 * 1024) {
            res.destroy();
            finish(new Error('response-too-large'));
          } else chunks.push(chunk);
        });
        res.on('end', () => {
          if (!res.complete) {
            finish(new Error('incomplete-response'));
            return;
          }
          try {
            const body: unknown = JSON.parse(
              Buffer.concat(chunks).toString('utf8'),
            );
            finish(undefined, {
              status,
              body,
              retryAfter: res.headers['retry-after'],
            });
          } catch {
            finish(new Error('invalid-json'));
          }
        });
      },
    );
    req.on('error', () =>
      finish(
        new Error(options.signal?.aborted ? 'cancelled' : 'connection-failed'),
      ),
    );
    req.end(options.body);
  });
}

export async function runClient(
  baseUrl: string,
  scenario: Scenario,
  testId: string,
  signal?: AbortSignal,
): Promise<ClientResult> {
  const started = performance.now();
  const key = randomUUID();
  const attempts: ClientAttempt[] = [];
  const remaining = () => scenario.deadlineMs - (performance.now() - started);
  const result = (
    outcome: 'success' | 'failure',
    reason?: string,
  ): ClientResult => ({
    outcome,
    attempts,
    durationMs: performance.now() - started,
    reason,
  });
  const truncated = scenario.kind === 'truncated-response';
  for (let attempt = 1; attempt <= scenario.maxAttempts; attempt += 1) {
    signal?.throwIfAborted();
    if (remaining() <= 0) return result('failure', 'operation-deadline');
    const observation: ClientAttempt = {
      attempt,
      startMs: performance.now() - started,
      endMs: 0,
    };
    attempts.push(observation);
    let reply: Reply;
    try {
      reply = await requestJson(
        baseUrl + (truncated ? '/payload' : '/orders'),
        {
          method: truncated ? 'GET' : 'POST',
          body: truncated
            ? undefined
            : JSON.stringify({ testId, item: 'book', quantity: 1 }),
          headers: {
            'x-logical-request-id': scenario.logicalRequestId,
            'x-attempt': String(attempt),
            ...(scenario.client === 'corrected'
              ? { 'Idempotency-Key': key }
              : {}),
          },
          timeoutMs: Math.max(
            1,
            Math.min(scenario.attemptTimeoutMs, remaining()),
          ),
          signal,
          acceptHeadersOnly: truncated && scenario.client === 'flawed',
        },
      );
      observation.status = reply.status;
    } catch (error) {
      observation.error =
        error instanceof Error ? error.message : 'request-failed';
      observation.endMs = performance.now() - started;
      signal?.throwIfAborted();
      if (truncated || attempt === scenario.maxAttempts)
        return result('failure', observation.error);
      continue;
    }
    observation.endMs = performance.now() - started;
    if (reply.status >= 200 && reply.status < 300) return result('success');
    if (reply.status !== 429) return result('failure', `http-${reply.status}`);
    if (attempt === scenario.maxAttempts)
      return result('failure', 'attempt-limit');
    if (scenario.client === 'corrected') {
      const delay = retryAfterMs(reply.retryAfter);
      if (delay === undefined) return result('failure', 'invalid-retry-after');
      if (delay >= remaining()) return result('failure', 'operation-deadline');
      await sleep(delay, undefined, { signal });
    }
  }
  return result('failure', 'attempt-limit');
}
