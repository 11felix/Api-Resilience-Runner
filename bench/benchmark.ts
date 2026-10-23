import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { cpus, platform, release, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { createDemoServer } from '../demo/service.js';
import { close, listen } from '../src/lifecycle.js';
import { createProxy } from '../src/proxy.js';

const config = {
  repeats: 3,
  concurrency: 8,
  warmupMs: 500,
  measurementMs: 2000,
  requestTimeoutMs: 5000,
  memorySampleMs: 20,
  responseBytes: 262155,
  method: 'GET',
  path: '/payload',
  requestBodyBytes: 0,
  connectionReuse: false,
  proxyFaults: false,
  proxyRetainedEvents: 100,
};
type Mode = 'direct' | 'proxy';

function percentile(sorted: number[], fraction: number): number | null {
  return sorted.length === 0
    ? null
    : sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

async function trial(mode: Mode) {
  const service = createDemoServer();
  let proxy: ReturnType<typeof createProxy> | undefined;
  let sampling: ReturnType<typeof setInterval> | undefined;
  try {
    const upstreamPort = await listen(service);
    let port = upstreamPort;
    if (mode === 'proxy') {
      proxy = createProxy({ upstreamPort, timeoutMs: config.requestTimeoutMs });
      port = await listen(proxy);
    }
    async function oneRequest(): Promise<string | undefined> {
      return new Promise((resolve) => {
        let settled = false;
        const finish = (error?: string) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          req.destroy();
          resolve(error);
        };
        const req = request(
          { hostname: '127.0.0.1', port, path: config.path, agent: false },
          (res) => {
            let bytes = 0;
            res.on('data', (chunk: Buffer) => {
              bytes += chunk.length;
            });
            res.on('error', () => finish('incomplete-response'));
            res.on('end', () =>
              finish(
                res.statusCode !== 200
                  ? 'status'
                  : !res.complete || bytes !== config.responseBytes
                    ? 'body-length'
                    : undefined,
              ),
            );
          },
        );
        const timer = setTimeout(
          () => finish('deadline'),
          config.requestTimeoutMs,
        );
        req.on('error', () => finish('connection'));
        req.end();
      });
    }
    async function load(durationMs: number) {
      const latencies: number[] = [];
      const errors: Record<string, number> = {};
      const started = performance.now();
      const until = started + durationMs;
      await Promise.all(
        Array.from({ length: config.concurrency }, async () => {
          while (performance.now() < until) {
            const start = performance.now();
            const error = await oneRequest();
            if (error) errors[error] = (errors[error] ?? 0) + 1;
            else latencies.push(performance.now() - start);
          }
        }),
      );
      return { latencies, errors, elapsedMs: performance.now() - started };
    }

    const warmup = await load(config.warmupMs);
    const baseline = process.memoryUsage();
    const peak = { ...baseline };
    let samples = 0;
    const sample = () => {
      samples += 1;
      const memory = process.memoryUsage();
      for (const key of [
        'rss',
        'heapUsed',
        'heapTotal',
        'external',
        'arrayBuffers',
      ] as const) {
        peak[key] = Math.max(peak[key], memory[key]);
      }
    };
    sampling = setInterval(sample, config.memorySampleMs);
    const measured = await load(config.measurementMs);
    sample();
    clearInterval(sampling);
    const end = process.memoryUsage();
    measured.latencies.sort((a, b) => a - b);
    return {
      mode,
      warmupRequests: warmup.latencies.length,
      warmupErrors: warmup.errors,
      elapsedMs: measured.elapsedMs,
      successfulRequests: measured.latencies.length,
      errors: measured.errors,
      requestsPerSecond:
        (measured.latencies.length * 1000) / measured.elapsedMs,
      latencyMs: {
        p50: percentile(measured.latencies, 0.5),
        p95: percentile(measured.latencies, 0.95),
        p99: percentile(measured.latencies, 0.99),
        max: measured.latencies.at(-1) ?? null,
      },
      memoryBytes: { baseline, sampledPeak: peak, end, samples },
    };
  } finally {
    clearInterval(sampling);
    if (proxy) await close(proxy);
    await close(service);
  }
}

async function sourceDigest(): Promise<string> {
  const hash = createHash('sha256');
  async function add(path: string): Promise<void> {
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const filename = join(path, entry.name);
      if (entry.isDirectory()) await add(filename);
      else {
        hash.update(filename + '\0');
        hash.update(await readFile(filename));
      }
    }
  }
  for (const path of ['bench', 'demo', 'src', 'scenarios', 'test'])
    await add(path);
  for (const path of [
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    'eslint.config.mjs',
  ]) {
    hash.update(path + '\0');
    hash.update(await readFile(path));
  }
  return hash.digest('hex');
}

const { values } = parseArgs({
  options: {
    worker: { type: 'string' },
    output: { type: 'string', default: 'benchmarks/latest.json' },
  },
});

if (values.worker !== undefined) {
  const mode = z.enum(['direct', 'proxy']).parse(values.worker);
  const result = await trial(mode);
  if (!process.send) throw new Error('Benchmark worker requires an IPC parent');
  process.send(result);
  process.disconnect();
} else {
  const results: Awaited<ReturnType<typeof trial>>[] = [];
  for (let repeat = 0; repeat < config.repeats; repeat += 1) {
    const modes: Mode[] =
      repeat % 2 === 0 ? ['direct', 'proxy'] : ['proxy', 'direct'];
    for (const mode of modes) {
      const result = await new Promise<Awaited<ReturnType<typeof trial>>>(
        (resolve, reject) => {
          const child = fork(
            fileURLToPath(import.meta.url),
            ['--worker', mode],
            { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] },
          );
          let result: Awaited<ReturnType<typeof trial>> | undefined;
          const timeout = setTimeout(() => child.kill('SIGKILL'), 15_000);
          child.once('message', (message) => {
            result = message as Awaited<ReturnType<typeof trial>>;
          });
          child.once('error', (error) => {
            clearTimeout(timeout);
            reject(error);
          });
          child.once('exit', (code) => {
            clearTimeout(timeout);
            if (code === 0 && result) resolve(result);
            else
              reject(
                new Error(
                  `Benchmark ${mode} worker failed or did not exit cleanly`,
                ),
              );
          });
        },
      );
      results.push(result);
      console.log(
        `${mode} repeat ${repeat + 1}: ${result.requestsPerSecond.toFixed(1)} req/s, p95 ${result.latencyMs.p95?.toFixed(2)} ms, errors ${JSON.stringify(result.errors)}`,
      );
    }
  }
  const report = {
    version: 1,
    recordedAt: new Date().toISOString(),
    sourceSha256: await sourceDigest(),
    environment: {
      node: process.version,
      v8: process.versions.v8,
      os: platform(),
      release: release(),
      arch: process.arch,
      cpu: cpus()[0]?.model,
      logicalCpus: cpus().length,
      ramBytes: totalmem(),
    },
    config,
    method:
      'Closed-loop concurrency; each trial in a fresh process. Latencies cover successful full bodies. Throughput includes final request drain. Memory covers client + service + optional proxy and samples at 20 ms; not proxy-only or a leak test. No forced GC. Percentiles use nearest rank within each trial.',
    trials: results,
  };
  await mkdir(dirname(values.output), { recursive: true });
  await writeFile(values.output, JSON.stringify(report, null, 2) + '\n');
  if (
    results.some(
      (result) =>
        Object.keys(result.errors).length > 0 ||
        Object.keys(result.warmupErrors).length > 0,
    )
  )
    process.exitCode = 1;
  console.log(`Saved ${values.output}`);
}
