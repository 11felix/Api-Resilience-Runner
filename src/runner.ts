import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createDemoServer } from '../demo/service.js';
import { requestJson, runClient } from '../demo/client.js';
import { close, listen } from './lifecycle.js';
import { createProxy } from './proxy.js';
import { check, createCollector } from './report.js';
import { scenarioSchema } from './scenario.js';

export async function runScenario(input: unknown, signal?: AbortSignal) {
  const scenario = scenarioSchema.parse(input);
  const runId = randomUUID();
  const started = performance.now();
  const collector = createCollector(scenario.maxEvents, started);
  const service = createDemoServer();
  let proxy: ReturnType<typeof createProxy> | undefined;
  try {
    signal?.throwIfAborted();
    const servicePort = await listen(service);
    const serviceUrl = `http://127.0.0.1:${servicePort}`;
    const health = await requestJson(serviceUrl + '/health', {
      timeoutMs: 1000,
      signal,
    });
    if (health.status !== 200) throw new Error('Demo service is not ready');
    proxy = createProxy({
      upstreamPort: servicePort,
      timeoutMs: scenario.proxyTimeoutMs,
      rules: scenario.rules,
      collector,
    });
    const proxyPort = await listen(proxy);
    const client = await runClient(
      `http://127.0.0.1:${proxyPort}`,
      scenario,
      runId,
      signal,
    );
    await close(proxy);
    signal?.throwIfAborted();
    const orderReply = await requestJson(
      serviceUrl + `/orders?testId=${runId}`,
      { timeoutMs: 1000, signal },
    );
    if (orderReply.status !== 200)
      throw new Error('Cannot inspect demo orders');
    const orders = z
      .array(z.object({ id: z.string(), testId: z.literal(runId) }))
      .parse(orderReply.body);
    const events = collector.events;
    const toleranceMs = 50;
    const assertions = [
      check('client outcome', scenario.expected.outcome, client.outcome),
      check('order count', scenario.expected.orderCount, orders.length),
      check(
        'client attempts',
        scenario.expected.attempts,
        client.attempts.length,
      ),
      check('observed proxy attempts', client.attempts.length, events.length),
      check(
        'attempt limit',
        scenario.maxAttempts,
        client.attempts.length,
        client.attempts.length <= scenario.maxAttempts,
      ),
      check(
        'operation deadline (50 ms tolerance)',
        scenario.deadlineMs + toleranceMs,
        client.durationMs,
        client.durationMs <= scenario.deadlineMs + toleranceMs,
      ),
      check('complete event evidence', 0, collector.dropped),
      check(
        'fault exercised',
        true,
        events.some(
          (event) =>
            (event.fault === 'lost-response' &&
              event.outcome === 'response-lost' &&
              event.upstreamComplete === true) ||
            (event.fault === 'truncate' &&
              event.outcome === 'response-truncated') ||
            (event.fault === 'rate-limit' &&
              event.status === 429 &&
              !event.forwarded),
        ),
      ),
      check(
        'proxy attempts settled',
        true,
        events.every((event) => event.endMs !== undefined),
      ),
    ];
    if (scenario.expected.respectRetryAfter) {
      for (const event of events) {
        if (
          event.retryAfterMs === undefined ||
          event.retryAfterStartMs === undefined
        )
          continue;
        const next = events.find(
          (candidate) => candidate.attempt === event.attempt + 1,
        );
        if (next) {
          const spacing = next.startMs - event.retryAfterStartMs;
          assertions.push(
            check(
              `retry spacing after attempt ${event.attempt}`,
              event.retryAfterMs,
              spacing,
              spacing + toleranceMs >= event.retryAfterMs,
            ),
          );
        }
      }
    }
    return {
      reportVersion: 1,
      scenarioVersion: scenario.version,
      runId,
      scenario: scenario.name,
      clientMode: scenario.client,
      configuration: scenario,
      status: assertions.every((assertion) => assertion.passed)
        ? ('passed' as const)
        : ('assertion-failed' as const),
      durationMs: performance.now() - started,
      timingToleranceMs: toleranceMs,
      client,
      orderCount: orders.length,
      droppedEvents: collector.dropped,
      events,
      assertions,
    };
  } finally {
    if (proxy) await close(proxy);
    await close(service);
  }
}
