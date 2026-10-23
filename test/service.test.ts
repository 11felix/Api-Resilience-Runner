import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { createDemoServer } from '../demo/service.js';

async function startServer(t: TestContext) {
  const server = createDemoServer();
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

test('health returns JSON', async (t) => {
  const { baseUrl } = await startServer(t);
  const response = await fetch(`${baseUrl}/health`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/json');
  assert.deepEqual(await response.json(), { status: 'ok' });
});

test('echo assembles a chunked JSON body, including split UTF-8 bytes', async (t) => {
  const { baseUrl } = await startServer(t);
  const body = Buffer.from('{"message":"hello 🌍"}');
  const split = body.indexOf(Buffer.from('🌍')) + 1;
  const response = await new Promise<string>((resolve, reject) => {
    const req = request(`${baseUrl}/echo`, { method: 'POST' }, (res) => {
      assert.equal(res.statusCode, 200);
      let result = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        result += chunk;
      });
      res.on('end', () => resolve(result));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.write(body.subarray(0, split));
    setImmediate(() => req.end(body.subarray(split)));
  });
  assert.deepEqual(JSON.parse(response), { message: 'hello 🌍' });
});

test('echo rejects malformed and empty JSON', async (t) => {
  const { baseUrl } = await startServer(t);
  for (const body of ['{broken', '']) {
    const response = await fetch(`${baseUrl}/echo`, { method: 'POST', body });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: 'Body must be valid JSON',
    });
  }
});

test('echo accepts 64 KiB and rejects a body one byte larger', async (t) => {
  const { baseUrl } = await startServer(t);
  for (const size of [65_536, 65_537]) {
    const body = JSON.stringify('a'.repeat(size - 2));
    const response = await fetch(`${baseUrl}/echo`, { method: 'POST', body });
    assert.equal(response.status, size === 65_536 ? 200 : 413);
    await response.arrayBuffer();
  }
});

test(
  'a delayed response does not block health requests',
  { timeout: 5000 },
  async (t) => {
    const { server, baseUrl } = await startServer(t);
    let completed = false;
    const received = once(server, 'request');
    const started = performance.now();
    const delayed = fetch(`${baseUrl}/delay?ms=500`).then(async (response) => {
      const body: unknown = await response.json();
      completed = true;
      assert.equal(response.status, 200);
      assert.deepEqual(body, { delayMs: 500 });
      assert.ok(performance.now() - started >= 450);
    });
    await received;
    const health = await fetch(`${baseUrl}/health`);
    assert.deepEqual(await health.json(), { status: 'ok' });
    assert.equal(completed, false);
    await delayed;
  },
);

test('delay validates its input and allows zero', async (t) => {
  const { baseUrl } = await startServer(t);
  for (const value of ['', '-1', '1.5', 'hello', '10001']) {
    const response = await fetch(`${baseUrl}/delay?ms=${value}`);
    assert.equal(response.status, 400);
    await response.arrayBuffer();
  }
  const response = await fetch(`${baseUrl}/delay?ms=0`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { delayMs: 0 });
});

test('unknown routes and unsupported methods return 404', async (t) => {
  const { baseUrl } = await startServer(t);
  for (const [path, method] of [
    ['/missing', 'GET'],
    ['/echo', 'GET'],
    ['/health', 'POST'],
  ]) {
    const response = await fetch(`${baseUrl}${path}`, { method });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'Route not found' });
  }
});

async function postOrder(baseUrl: string, payload: unknown, key?: string) {
  return fetch(`${baseUrl}/orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(key === undefined ? {} : { 'Idempotency-Key': key }),
    },
    body: JSON.stringify(payload),
  });
}

test('orders receive unique IDs and can be filtered by test ID', async (t) => {
  const { baseUrl } = await startServer(t);
  const firstResponse = await postOrder(baseUrl, {
    testId: 'run-a',
    item: 'book',
    quantity: 2,
  });
  assert.equal(firstResponse.status, 201);
  const first: unknown = await firstResponse.json();
  assert.ok(first && typeof first === 'object' && 'id' in first);
  assert.equal(typeof first.id, 'string');
  assert.deepEqual(first, {
    id: first.id,
    testId: 'run-a',
    item: 'book',
    quantity: 2,
  });

  const secondResponse = await postOrder(baseUrl, {
    testId: 'run-b',
    item: 'pen',
    quantity: 1,
  });
  assert.equal(secondResponse.status, 201);
  const second: unknown = await secondResponse.json();
  assert.ok(second && typeof second === 'object' && 'id' in second);
  assert.notEqual(first.id, second.id);

  const all = await fetch(`${baseUrl}/orders`);
  assert.equal(all.status, 200);
  assert.deepEqual(await all.json(), [first, second]);
  const filtered = await fetch(`${baseUrl}/orders?testId=run-a`);
  assert.deepEqual(await filtered.json(), [first]);
  const missing = await fetch(`${baseUrl}/orders?testId=missing`);
  assert.deepEqual(await missing.json(), []);
});

test('invalid order payloads create nothing and do not reserve a key', async (t) => {
  const { baseUrl } = await startServer(t);
  const valid = { testId: 'validation', item: 'book', quantity: 1 };
  for (const payload of [
    null,
    [],
    {},
    { ...valid, testId: '' },
    { ...valid, testId: ' '.repeat(3) },
    { ...valid, testId: 'a'.repeat(129) },
    { ...valid, item: '' },
    { ...valid, item: 'a'.repeat(129) },
    { ...valid, quantity: 0 },
    { ...valid, quantity: -1 },
    { ...valid, quantity: 1.5 },
    { ...valid, quantity: '1' },
    { ...valid, quantity: Number.MAX_SAFE_INTEGER + 1 },
    { ...valid, unexpected: true },
  ]) {
    const response = await postOrder(baseUrl, payload, 'validation-key');
    assert.equal(response.status, 400);
    await response.arrayBuffer();
  }
  const orders = await fetch(`${baseUrl}/orders`);
  assert.deepEqual(await orders.json(), []);
  const response = await postOrder(baseUrl, valid, 'validation-key');
  assert.equal(response.status, 201);
  await response.arrayBuffer();
});

test('malformed and oversized order bodies create nothing', async (t) => {
  const { baseUrl } = await startServer(t);
  for (const [body, status] of [
    ['{broken', 400],
    ['x'.repeat(65_537), 413],
  ] as const) {
    const response = await fetch(`${baseUrl}/orders`, { method: 'POST', body });
    assert.equal(response.status, status);
    await response.arrayBuffer();
  }
  const orders = await fetch(`${baseUrl}/orders`);
  assert.deepEqual(await orders.json(), []);
});

test('matching keys replay the original result regardless of JSON field order', async (t) => {
  const { baseUrl } = await startServer(t);
  const first = await postOrder(
    baseUrl,
    { testId: 'replay', item: 'book', quantity: 2 },
    'key-1',
  );
  assert.equal(first.status, 201);
  const original: unknown = await first.json();
  const replay = await postOrder(
    baseUrl,
    { quantity: 2, item: 'book', testId: 'replay' },
    'key-1',
  );
  assert.equal(replay.status, 201);
  assert.deepEqual(await replay.json(), original);
  const orders = await fetch(`${baseUrl}/orders?testId=replay`);
  assert.deepEqual(await orders.json(), [original]);
});

test('conflicting key reuse rejects every changed payload field without changing the order', async (t) => {
  const { baseUrl } = await startServer(t);
  const payload = { testId: 'conflict', item: 'book', quantity: 1 };
  const first = await postOrder(baseUrl, payload, 'key-1');
  const original: unknown = await first.json();
  for (const changed of [
    { ...payload, testId: 'another-run' },
    { ...payload, item: 'pen' },
    { ...payload, quantity: 2 },
  ]) {
    const response = await postOrder(baseUrl, changed, 'key-1');
    assert.equal(response.status, 409);
    await response.arrayBuffer();
  }
  const replay = await postOrder(baseUrl, payload, 'key-1');
  assert.equal(replay.status, 201);
  assert.deepEqual(await replay.json(), original);
  const orders = await fetch(`${baseUrl}/orders`);
  assert.deepEqual(await orders.json(), [original]);
});

test('keyless requests and different keys each create separate orders', async (t) => {
  const { baseUrl } = await startServer(t);
  const created: unknown[] = [];
  for (const key of [undefined, undefined, 'key-1', 'key-2']) {
    const response = await postOrder(
      baseUrl,
      { testId: 'duplicates', item: 'book', quantity: 1 },
      key,
    );
    assert.equal(response.status, 201);
    const order: unknown = await response.json();
    assert.ok(order && typeof order === 'object' && 'id' in order);
    for (const previous of created) assert.notDeepEqual(order, previous);
    created.push(order);
  }
  const orders = await fetch(`${baseUrl}/orders`);
  assert.deepEqual(await orders.json(), created);
});

test('empty and oversized idempotency keys are rejected without creating orders', async (t) => {
  const { baseUrl } = await startServer(t);
  for (const key of ['', 'a'.repeat(129)]) {
    const response = await postOrder(
      baseUrl,
      { testId: 'keys', item: 'book', quantity: 1 },
      key,
    );
    assert.equal(response.status, 400);
    await response.arrayBuffer();
  }
  const orders = await fetch(`${baseUrl}/orders`);
  assert.deepEqual(await orders.json(), []);
});

test('server instances isolate both orders and idempotency records', async (t) => {
  const first = await startServer(t);
  const second = await startServer(t);
  const response = await postOrder(
    first.baseUrl,
    { testId: 'first', item: 'book', quantity: 1 },
    'shared-key',
  );
  assert.equal(response.status, 201);
  await response.arrayBuffer();
  const empty = await fetch(`${second.baseUrl}/orders`);
  assert.deepEqual(await empty.json(), []);
  const independent = await postOrder(
    second.baseUrl,
    { testId: 'second', item: 'pen', quantity: 2 },
    'shared-key',
  );
  assert.equal(independent.status, 201);
  await independent.arrayBuffer();
});
