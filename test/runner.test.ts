import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { retryAfterMs } from '../demo/client.js';
import { runScenario } from '../src/runner.js';
import { scenarioSchema } from '../src/scenario.js';

async function load(name: string) {
  const input: unknown = JSON.parse(
    await readFile(`scenarios/${name}.json`, 'utf8'),
  );
  return scenarioSchema.parse(input);
}

for (const name of ['lost-response', 'rate-limit', 'truncated-response']) {
  test(
    `${name}: corrected client passes and flawed client fails meaningful assertions`,
    { timeout: 10_000 },
    async () => {
      const scenario = await load(name);
      const corrected = await runScenario(scenario);
      assert.equal(
        corrected.status,
        'passed',
        JSON.stringify(corrected.assertions),
      );
      const flawed = await runScenario({ ...scenario, client: 'flawed' });
      assert.equal(flawed.status, 'assertion-failed');
      assert.equal(flawed.client.outcome, 'success');
      if (name === 'lost-response') {
        assert.equal(corrected.orderCount, 1);
        assert.equal(flawed.orderCount, 2);
        assert.equal(corrected.events[0].upstreamComplete, true);
        assert.equal(corrected.events[0].outcome, 'response-lost');
        assert.equal(corrected.events[1].matchedRule, undefined);
        assert.equal(corrected.client.attempts.length, 2);
      } else if (name === 'rate-limit') {
        assert.equal(corrected.events[0].forwarded, false);
        assert.ok(
          flawed.assertions.some(
            (entry) => entry.name.startsWith('retry spacing') && !entry.passed,
          ),
        );
      } else {
        assert.equal(corrected.client.outcome, 'failure');
        assert.equal(corrected.events[0].outcome, 'response-truncated');
        assert.ok(corrected.client.durationMs < scenario.deadlineMs);
      }
    },
  );
}

test('Retry-After parser accepts seconds and HTTP dates but rejects invalid values', () => {
  const now = Date.UTC(2026, 0, 1);
  assert.equal(retryAfterMs('2', now), 2000);
  assert.equal(retryAfterMs(new Date(now + 3000).toUTCString(), now), 3000);
  assert.equal(retryAfterMs(new Date(now - 3000).toUTCString(), now), 0);
  for (const value of [
    undefined,
    '-1',
    '1.5',
    'tomorrow',
    '999999999999999999999',
  ]) {
    assert.equal(retryAfterMs(value, now), undefined);
  }
});

test(
  'HTTP-date rate limiting passes the same spacing assertion',
  { timeout: 6000 },
  async () => {
    const scenario = await load('rate-limit');
    assert.equal(scenario.rules[0].fault.type, 'rate-limit');
    scenario.rules[0].fault = {
      type: 'rate-limit',
      delaySeconds: 1,
      format: 'http-date',
    };
    const report = await runScenario(scenario);
    assert.equal(report.status, 'passed', JSON.stringify(report.assertions));
    assert.ok(
      report.events[0].retryAfterMs !== undefined &&
        report.events[0].retryAfterMs >= 1000,
    );
  },
);

test(
  'continuous rate limiting stops at the attempt limit and creates no orders',
  { timeout: 5000 },
  async () => {
    const scenario = await load('rate-limit');
    scenario.rules.push({
      ...scenario.rules[0],
      id: 'limit-second',
      attempt: 2,
    });
    scenario.expected = {
      outcome: 'failure',
      attempts: 2,
      orderCount: 0,
      respectRetryAfter: true,
    };
    const report = await runScenario(scenario);
    assert.equal(report.status, 'passed', JSON.stringify(report.assertions));
    assert.equal(report.client.reason, 'attempt-limit');
    assert.ok(report.events.every((event) => !event.forwarded));
  },
);

test('a retry delay that exceeds the operation budget stops without another attempt', async () => {
  const scenario = await load('rate-limit');
  scenario.deadlineMs = 100;
  scenario.expected = {
    outcome: 'failure',
    attempts: 1,
    orderCount: 0,
    respectRetryAfter: true,
  };
  const report = await runScenario(scenario);
  assert.equal(report.status, 'passed', JSON.stringify(report.assertions));
  assert.equal(report.client.reason, 'operation-deadline');
});

test('lost response leaves a committed order even when no retry is allowed', async () => {
  const scenario = await load('lost-response');
  scenario.maxAttempts = 1;
  scenario.expected = {
    outcome: 'failure',
    attempts: 1,
    orderCount: 1,
    respectRetryAfter: false,
  };
  const report = await runScenario(scenario);
  assert.equal(report.status, 'passed', JSON.stringify(report.assertions));
  assert.equal(report.events[0].outcome, 'response-lost');
});

test('repeated runs reset state and preserve deterministic fault selection', async () => {
  const scenario = await load('lost-response');
  const first = await runScenario(scenario);
  const second = await runScenario(scenario);
  assert.notEqual(first.runId, second.runId);
  assert.equal(first.orderCount, 1);
  assert.equal(second.orderCount, 1);
  assert.deepEqual(
    first.events.map((event) => event.matchedRule),
    second.events.map((event) => event.matchedRule),
  );
});

test('event overflow is explicit and cannot produce a passing report', async () => {
  const scenario = await load('lost-response');
  scenario.maxEvents = 1;
  const report = await runScenario(scenario);
  assert.equal(report.events.length, 1);
  assert.equal(report.droppedEvents, 1);
  assert.equal(report.status, 'assertion-failed');
  assert.ok(
    report.assertions.some(
      (entry) => entry.name === 'complete event evidence' && !entry.passed,
    ),
  );
  assert.equal(JSON.stringify(report).includes('Idempotency-Key'), false);
});

test('ambiguous rules and invalid scenarios are rejected before execution', async () => {
  const scenario = await load('lost-response');
  scenario.rules.push({ ...scenario.rules[0], id: 'same-match' });
  await assert.rejects(runScenario(scenario), /ambiguous/);
  await assert.rejects(runScenario({ version: 99 }), /Invalid/);
});

test(
  'cancellation interrupts retry sleep and allows a fresh run',
  { timeout: 5000 },
  async () => {
    const scenario = await load('rate-limit');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 100);
    try {
      await assert.rejects(runScenario(scenario, controller.signal), /abort/i);
    } finally {
      clearTimeout(timer);
    }
    const next = await runScenario(await load('lost-response'));
    assert.equal(next.status, 'passed');
  },
);

test(
  'CLI emits JSON reports and distinct exit codes',
  { timeout: 10_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'resilience-cli-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const output = join(directory, 'report.json');
    const cli = [
      'dist/src/cli.js',
      'scenarios/lost-response.json',
      '--output',
      output,
    ];
    const execute = promisify(execFile);
    const passing = await execute(process.execPath, cli);
    assert.match(passing.stdout, /PASSED/);
    const passed: unknown = JSON.parse(await readFile(output, 'utf8'));
    assert.ok(
      passed &&
        typeof passed === 'object' &&
        'status' in passed &&
        passed.status === 'passed',
    );
    await assert.rejects(
      execute(process.execPath, [...cli, '--client', 'flawed']),
      { code: 1 },
    );
    await assert.rejects(
      execute(process.execPath, [
        'dist/src/cli.js',
        'missing.json',
        '--output',
        output,
      ]),
      { code: 2 },
    );
    const failed: unknown = JSON.parse(await readFile(output, 'utf8'));
    assert.ok(
      failed &&
        typeof failed === 'object' &&
        'status' in failed &&
        failed.status === 'runner-error',
    );
  },
);

test(
  'CLI cancellation exits without hanging sockets or timers',
  { timeout: 5000 },
  async () => {
    const child = spawn(process.execPath, [
      'dist/src/cli.js',
      'scenarios/rate-limit.json',
    ]);
    const exited = once(child, 'exit');
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const timer = setTimeout(() => child.kill('SIGTERM'), 500);
    const watchdog = setTimeout(() => child.kill('SIGKILL'), 3000);
    try {
      const [code, signal] = await exited;
      assert.equal(signal, null);
      assert.equal(code, 2);
      assert.match(stderr, /Run cancelled/);
    } finally {
      clearTimeout(timer);
      clearTimeout(watchdog);
      if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGKILL');
    }
  },
);
