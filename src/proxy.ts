import { createServer, request } from 'node:http';
import type {
  IncomingHttpHeaders,
  IncomingMessage,
  ClientRequest,
} from 'node:http';
import type { Rule } from './scenario.js';
import { createCollector } from './report.js';
import type { AttemptEvent } from './report.js';

function forwardHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const blocked = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
    'proxy-connection',
    ...(headers.connection ?? '')
      .split(',')
      .map((name) => name.trim().toLowerCase()),
  ]);
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !blocked.has(name)),
  );
}

export function createProxy(options: {
  upstreamPort: number;
  timeoutMs: number;
  rules?: Rule[];
  collector?: ReturnType<typeof createCollector>;
}) {
  const collector = options.collector ?? createCollector(100);
  return createServer((downstreamRequest, downstreamResponse) => {
    const rawPath = downstreamRequest.url ?? '/';
    const path = rawPath.split('?')[0];
    const logicalRequestId = String(
      downstreamRequest.headers['x-logical-request-id'] ?? '',
    );
    const rawAttempt = downstreamRequest.headers['x-attempt'];
    const attempt =
      typeof rawAttempt === 'string' && /^\d{1,2}$/.test(rawAttempt)
        ? Number(rawAttempt)
        : 0;
    const rule = options.rules?.find(
      (candidate) =>
        candidate.method === downstreamRequest.method &&
        candidate.path === path &&
        candidate.logicalRequestId === logicalRequestId &&
        candidate.attempt === attempt,
    );
    const event: AttemptEvent = {
      logicalRequestId: logicalRequestId.slice(0, 64),
      attempt,
      method: (downstreamRequest.method ?? '').slice(0, 16),
      path: path.slice(0, 128),
      startMs: collector.now(),
      forwarded: false,
      matchedRule: rule?.id,
      fault: rule?.fault.type,
    };
    collector.add(event);
    let upstreamRequest: ClientRequest | undefined = undefined;
    let upstreamResponse: IncomingMessage | undefined;
    let stopped = false;

    function cleanup(): void {
      clearTimeout(timer);
      downstreamRequest.unpipe();
      upstreamResponse?.unpipe();
      upstreamResponse?.destroy();
      upstreamRequest?.destroy();
    }

    function stop(outcome: string, status?: number): void {
      if (stopped) return;
      stopped = true;
      event.outcome = outcome;
      event.endMs = collector.now();
      cleanup();
      if (
        status &&
        !downstreamResponse.headersSent &&
        !downstreamResponse.destroyed
      ) {
        event.status = status;
        downstreamResponse.writeHead(status, {
          'Content-Type': 'application/json',
          Connection: 'close',
        });
        downstreamResponse.end(JSON.stringify({ error: outcome }));
      } else {
        downstreamResponse.destroy();
      }
    }

    const timer = setTimeout(
      () => stop('proxy-deadline', 504),
      options.timeoutMs,
    );
    downstreamRequest.on('error', () => stop('client-disconnected'));
    downstreamResponse.on('error', () => stop('client-disconnected'));
    downstreamResponse.once('close', () => {
      if (!stopped) {
        stopped = true;
        event.outcome = downstreamResponse.writableFinished
          ? 'response-written'
          : 'client-disconnected';
        event.endMs = collector.now();
        cleanup();
      }
    });

    if (!rawPath.startsWith('/') || rawPath.startsWith('//')) {
      stop('unsupported-request-target', 400);
      return;
    }

    if (rule?.fault.type === 'rate-limit') {
      const now = Date.now();
      const target =
        Math.ceil(now / 1000) * 1000 + rule.fault.delaySeconds * 1000;
      const retryAfter =
        rule.fault.format === 'seconds'
          ? String(rule.fault.delaySeconds)
          : new Date(target).toUTCString();
      event.retryAfterMs =
        rule.fault.format === 'seconds'
          ? rule.fault.delaySeconds * 1000
          : target - now;
      event.retryAfterStartMs = collector.now();
      event.status = 429;
      downstreamRequest.resume();
      downstreamResponse.writeHead(429, {
        'Retry-After': retryAfter,
        'Content-Type': 'application/json',
      });
      downstreamResponse.end(JSON.stringify({ error: 'Injected rate limit' }));
      return;
    }

    event.forwarded = true;
    upstreamRequest = request(
      {
        hostname: '127.0.0.1',
        port: options.upstreamPort,
        method: downstreamRequest.method,
        path: rawPath,
        agent: false,
        headers: {
          ...forwardHeaders(downstreamRequest.headers),
          host: `127.0.0.1:${options.upstreamPort}`,
        },
      },
      (incoming) => {
        upstreamResponse = incoming;
        event.upstreamStatus = incoming.statusCode;
        incoming.on('error', () => stop('upstream-interrupted', 502));
        incoming.on('end', () => {
          event.upstreamComplete = incoming.complete;
          if (!incoming.complete) stop('upstream-interrupted', 502);
        });

        if (rule?.fault.type === 'lost-response') {
          incoming.once('end', () => stop('response-lost'));
          incoming.resume();
          return;
        }

        event.status = incoming.statusCode ?? 502;
        downstreamResponse.writeHead(
          event.status,
          forwardHeaders(incoming.headers),
        );
        if (rule?.fault.type === 'truncate') {
          let remaining = rule.fault.bytes;
          downstreamResponse.flushHeaders();
          incoming.on('data', (chunk: Buffer) => {
            incoming.pause();
            const prefix = chunk.subarray(0, remaining);
            remaining -= prefix.length;
            downstreamResponse.write(prefix, () => {
              if (remaining === 0) stop('response-truncated');
              else incoming.resume();
            });
          });
          incoming.once('end', () => {
            if (remaining > 0) stop('truncation-prefix-exceeds-response');
          });
          return;
        }

        incoming.pipe(downstreamResponse);
      },
    );
    upstreamRequest.on('error', () => stop('upstream-unavailable', 502));
    downstreamRequest.pipe(upstreamRequest);
  });
}
