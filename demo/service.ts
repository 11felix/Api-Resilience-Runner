import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { z } from 'zod';

const maxBodyBytes = 64 * 1024;
const identifierSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => value.trim().length > 0);
const orderSchema = z.strictObject({
  testId: identifierSchema,
  item: identifierSchema,
  quantity: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
type OrderPayload = z.infer<typeof orderSchema>;
type Order = OrderPayload & { id: string };

function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(value));
}

function readJson(
  request: IncomingMessage,
  response: ServerResponse,
  onValue: (value: unknown) => void,
): void {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let oversized = false;

  request.on('data', (chunk: Buffer) => {
    if (oversized) return;
    bytes += chunk.length;
    if (bytes > maxBodyBytes) {
      oversized = true;
      chunks.length = 0;
      response.setHeader('Connection', 'close');
      sendJson(response, 413, { error: 'Body exceeds 64 KiB' });
      return;
    }
    chunks.push(chunk);
  });

  request.on('end', () => {
    if (oversized) return;
    let value: unknown;
    try {
      value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      sendJson(response, 400, { error: 'Body must be valid JSON' });
      return;
    }
    onValue(value);
  });
}

/** Creates the local demo server without binding a port. */
export function createDemoServer(): Server {
  const orders: Order[] = [];
  const idempotency = new Map<
    string,
    { payload: OrderPayload; order: Order }
  >();

  return createServer((request, response) => {
    request.on('error', () => response.destroy());

    let url: URL;
    try {
      url = new URL(request.url ?? '/', 'http://127.0.0.1');
    } catch {
      sendJson(response, 400, { error: 'Invalid URL' });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/health') {
      sendJson(response, 200, { status: 'ok' });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/payload') {
      const body = JSON.stringify({ data: 'x'.repeat(256 * 1024) });
      response.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      });
      response.end(body);
      return;
    }

    if (request.method === 'POST' && url.pathname === '/echo') {
      readJson(request, response, (value) => sendJson(response, 200, value));
      return;
    }

    if (request.method === 'GET' && url.pathname === '/orders') {
      const testId = url.searchParams.get('testId');
      sendJson(
        response,
        200,
        testId === null
          ? orders
          : orders.filter((order) => order.testId === testId),
      );
      return;
    }

    if (request.method === 'POST' && url.pathname === '/orders') {
      readJson(request, response, (value) => {
        const parsed = orderSchema.safeParse(value);
        if (!parsed.success) {
          sendJson(response, 400, {
            error: 'Invalid order payload',
            issues: parsed.error.issues,
          });
          return;
        }

        const key = request.headers['idempotency-key'];
        if (key !== undefined && !identifierSchema.safeParse(key).success) {
          sendJson(response, 400, {
            error:
              'Idempotency-Key must be a nonblank string of at most 128 characters',
          });
          return;
        }

        const payload = parsed.data;
        const stored =
          typeof key === 'string' ? idempotency.get(key) : undefined;
        if (stored) {
          if (
            stored.payload.testId !== payload.testId ||
            stored.payload.item !== payload.item ||
            stored.payload.quantity !== payload.quantity
          ) {
            sendJson(response, 409, {
              error:
                'Idempotency-Key was already used with a different payload',
            });
            return;
          }
          sendJson(response, 201, stored.order);
          return;
        }

        const order: Order = { id: randomUUID(), ...payload };
        orders.push(order);
        if (typeof key === 'string') idempotency.set(key, { payload, order });
        sendJson(response, 201, order);
      });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/delay') {
      const rawDelay = url.searchParams.get('ms') ?? '1000';
      const delayMs = Number(rawDelay);
      if (
        !/^\d+$/.test(rawDelay) ||
        !Number.isSafeInteger(delayMs) ||
        delayMs > 10_000
      ) {
        sendJson(response, 400, {
          error: 'ms must be an integer from 0 to 10000',
        });
        return;
      }
      const timer = setTimeout(() => {
        sendJson(response, 200, { delayMs });
      }, delayMs);
      response.once('close', () => clearTimeout(timer));
      return;
    }

    sendJson(response, 404, { error: 'Route not found' });
  });
}
