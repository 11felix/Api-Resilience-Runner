import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, request } from 'node:http';
import type { Server } from 'node:http';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { createDemoServer } from '../demo/service.js';
import { createProxy } from '../src/proxy.js';
import { close, listen } from '../src/lifecycle.js';
import { createCollector } from '../src/report.js';

async function setup(t: TestContext, service: Server, timeoutMs = 1000) {
  const upstreamPort = await listen(service);
  const collector = createCollector(100);
  const proxy = createProxy({ upstreamPort, timeoutMs, collector });
  const port = await listen(proxy);
  t.after(async () => {
    await close(proxy);
    await close(service);
  });
  return {
    service,
    proxy,
    collector,
    url: `http://127.0.0.1:${port}`,
    direct: `http://127.0.0.1:${upstreamPort}`,
  };
}

test('proxy preserves JSON, query strings, error statuses and large responses', async (t) => {
  const { url, direct } = await setup(t, createDemoServer());
  for (const path of [
    '/health',
    '/delay?ms=0',
    '/delay?ms=invalid',
    '/missing',
    '/payload',
  ]) {
    const proxied = await fetch(url + path);
    const original = await fetch(direct + path);
    assert.equal(proxied.status, original.status);
    assert.equal(
      proxied.headers.get('content-type'),
      original.headers.get('content-type'),
    );
    assert.equal(await proxied.text(), await original.text());
  }
  const response = await fetch(url + '/echo', {
    method: 'POST',
    body: JSON.stringify({ hello: 'world' }),
  });
  assert.deepEqual(await response.json(), { hello: 'world' });
});

test('proxy rewrites Host and removes hop-by-hop headers in both directions', async (t) => {
  const service = createServer((req, res) => {
    assert.equal(req.headers['x-remove-me'], undefined);
    res.writeHead(418, {
      Connection: 'x-response-remove',
      'x-response-remove': 'secret',
      'x-keep': 'yes',
      'Set-Cookie': ['a=1', 'b=2'],
    });
    res.end(JSON.stringify({ host: req.headers.host, path: req.url }));
  });
  const { url, direct } = await setup(t, service);
  await new Promise<void>((resolve, reject) => {
    const req = request(
      url + '/headers?q=yes',
      {
        headers: {
          Connection: 'x-remove-me',
          'x-remove-me': 'secret',
          Host: 'wrong.example',
        },
      },
      (res) => {
        assert.equal(res.statusCode, 418);
        assert.equal(res.headers['x-response-remove'], undefined);
        assert.equal(res.headers['x-keep'], 'yes');
        assert.deepEqual(res.headers['set-cookie'], ['a=1', 'b=2']);
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('error', reject);
        res.on('end', () => {
          assert.deepEqual(JSON.parse(body), {
            host: new URL(direct).host,
            path: '/headers?q=yes',
          });
          resolve();
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
});

test(
  'proxy streams a large body to a slow consumer',
  { timeout: 5000 },
  async (t) => {
    let sawBackpressure = false;
    const service = createServer((_req, res) => {
      let remaining = 8 * 1024 * 1024;
      const chunk = Buffer.alloc(64 * 1024, 'x');
      const write = () => {
        while (remaining > 0) {
          remaining -= chunk.length;
          if (!res.write(chunk)) {
            sawBackpressure = true;
            res.once('drain', write);
            return;
          }
        }
        res.end();
      };
      write();
    });
    const { url } = await setup(t, service, 4000);
    const bytes = await new Promise<number>((resolve, reject) => {
      const req = request(url, (res) => {
        let received = 0;
        res.on('data', (chunk: Buffer) => {
          received += chunk.length;
          res.pause();
          setTimeout(() => res.resume(), 1);
        });
        res.on('end', () => resolve(received));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(bytes, 8 * 1024 * 1024);
    assert.ok(sawBackpressure);
  },
);

test('unavailable upstream produces 502 before response headers', async (t) => {
  const { url, service } = await setup(t, createDemoServer());
  await close(service);
  const response = await fetch(url + '/health');
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: 'upstream-unavailable' });
});

test(
  'proxy deadline produces 504 and closes slow upstream work',
  { timeout: 2000 },
  async (t) => {
    let didClose: () => void = () => {};
    const closed = new Promise<void>((resolve) => {
      didClose = resolve;
    });
    const service = createServer((_req, res) => {
      res.once('close', didClose);
    });
    const { url } = await setup(t, service, 50);
    const response = await fetch(url);
    assert.equal(response.status, 504);
    await response.text();
    await closed;
  },
);

test(
  'client disconnect cancels the upstream request',
  { timeout: 2000 },
  async (t) => {
    let didClose: () => void = () => {};
    const closed = new Promise<void>((resolve) => {
      didClose = resolve;
    });
    const service = createServer((_req, res) => {
      res.once('close', didClose);
    });
    const { url } = await setup(t, service);
    const received = once(service, 'request');
    const req = request(url);
    req.on('error', () => {});
    req.end();
    await received;
    req.destroy();
    await closed;
  },
);

test('interrupted upstream body is rejected instead of replaced with a second response', async (t) => {
  const service = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Length': 1000 });
    res.write('partial', () => res.destroy());
  });
  const { url } = await setup(t, service);
  await assert.rejects(async () => {
    const response = await fetch(url);
    await response.text();
  });
});

test('deadline after headers interrupts an unfinished response', async (t) => {
  const service = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Length': 1000 });
    res.write('partial');
  });
  const { url } = await setup(t, service, 50);
  const response = await fetch(url);
  assert.equal(response.status, 200);
  await assert.rejects(response.text());
});
