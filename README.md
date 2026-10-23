# API Resilience Runner

A TypeScript/Node.js project for testing retry and recovery behaviour under deterministic HTTP failures. It routes a local demo application's API calls through a fault-injection proxy and checks explicit business assertions.

## Project scope

- Lost response after order creation: compare retries with and without a stable idempotency key, then assert the service's order count.
- Rate limiting: inject `429` and `Retry-After` responses and check retry spacing and attempt limits.
- Truncated response: interrupt a known response and check incomplete-body rejection and deadline compliance.

Each scenario pairs deliberately flawed and corrected client modes. The runner owns service/proxy setup, scenario execution, assertions, JSON reporting and shutdown. Assertion failures and runner/configuration failures have distinct exit codes.

## Intended stack

TypeScript in strict mode with ESM, Node.js 24 LTS, built-in `node:http`, Zod for scenario validation, and `node:test` for integration tests over local sockets. Scenario files and JSON reports provide the initial persistence layer.

## Architecture

```text
CLI -> validated scenario -> fault-injection proxy -> local demo service
 |                                  ^
 +-> demo client -------------------+
 +-> business assertions -> JSON and terminal report
```

Fault rules identify method, path, logical request ID and attempt number. Logical request IDs are distinct from application idempotency keys. Reports will capture bounded metadata and monotonic timings rather than request bodies or credentials.

## Boundaries

HTTP/1.1, sequential scenarios, a fixed loopback upstream and JSON demo endpoints. No HTTPS interception, arbitrary public targets, WebSockets, gRPC or production traffic. The demo's initial idempotency store is in memory; it will not survive restarts or coordinate across processes.

## Implementation milestones

1. Local order service with bounded input validation and idempotency-key conflict detection.
2. Streaming reverse proxy with backpressure, deadlines and disconnect cleanup.
3. Deterministic lost-response, rate-limit and truncation faults.
4. Flawed and corrected clients with explicit retry and business assertions.
5. Scenario CLI, bounded reports and isolated socket integration tests.
6. Reproducible measurements with documented methodology.

The in-memory order service, streaming proxy, three fault scenarios, retry clients, CLI, and JSON reports are implemented and verified. Repeated local performance measurements are recorded below; they are not production-scale or adoption claims.

## Run resilience scenarios

```sh
npm ci
npm run build
npm run run -- scenarios/lost-response.json --output /tmp/lost-response.json
npm run run -- scenarios/lost-response.json --client flawed --output /tmp/lost-response-flawed.json
npm run run -- scenarios/rate-limit.json --output /tmp/rate-limit.json
npm run run -- scenarios/truncated-response.json --output /tmp/truncated-response.json
```

Each command starts its own service and proxy on fresh loopback ports, runs one scenario, then shuts both down. You do not need to start the demo server separately. `--client flawed` works with all three scenario files. The flawed modes deliberately produce assertion failures and exit with code `1`.

- Lost response: the first attempt creates an order but loses its response. The corrected retry reuses an idempotency key and leaves one order; the flawed retry creates two.
- Rate limit: the proxy returns `429` before forwarding attempt one. The corrected client respects `Retry-After`; the flawed client retries immediately. Set the rule's `format` to `http-date` to exercise HTTP-date handling instead of seconds.
- Truncation: the proxy sends a prefix of `/payload` while preserving the original `Content-Length`, then disconnects. The corrected client rejects the incomplete body; the flawed client reports success as soon as it receives successful headers. A **client failure is the expected passing outcome** for this scenario.

Exit codes are `0` for passing assertions, `1` for failed assertions, and `2` for invalid configuration, cancellation, or runner/reporting failures. Without `--output`, JSON is printed after the terminal summary. Ctrl+C cancels the run and cleans up sockets and timers.

## Demonstration walkthrough

Run both client modes against each scenario. Each corrected run should exit `0`; each flawed run should exit `1` deliberately. These are separate commands, so do not chain them with `&&` expecting a flawed run to succeed.

```sh
npm run run -- scenarios/lost-response.json --client flawed
npm run run -- scenarios/lost-response.json --client corrected
npm run run -- scenarios/rate-limit.json --client flawed
npm run run -- scenarios/rate-limit.json --client corrected
npm run run -- scenarios/truncated-response.json --client flawed
npm run run -- scenarios/truncated-response.json --client corrected
```

Recorded on Node.js 24.22.1: the flawed lost-response run created two orders and the corrected run created one, both after two attempts. Rate-limit retries were about 1.09 ms apart for the flawed client versus 1004.97 ms for the corrected client, against a 1000 ms instruction. The corrected truncation client rejected the incomplete response; the flawed client incorrectly reported success from headers alone. Full reports are in [`benchmarks/demo-results.json`](benchmarks/demo-results.json).

For a short interview demo, show the order count first, explain why losing a response does not roll back a side effect, then show the rate-limit spacing and truncation assertions. End by pointing to the cleanup tests and explaining the in-memory limitation.

One real testing bug: the initial hop-by-hop header test used `fetch` and observed `x-remove-me` at the upstream when it expected that header to be stripped. Switching the test request to `node:http.request` gave the fixture explicit control over its `Connection` header, and the same proxy passed. The fix was in the test harness, not a demonstrated proxy defect. This is why the current header test controls the wire-level request instead of relying on a higher-level client.

## Reproducibility and local measurements

From a fresh checkout with Node.js 24 selected:

```sh
npm ci
npm run typecheck
npm run lint
npm test
npm run benchmark -- --output /tmp/resilience-benchmark.json
```

Then run the six demonstration commands above. No external service, credentials, or pre-running demo server is required. On 23 October 2026, a clean source copy with no `node_modules` or `dist` passed a fresh `npm ci` from the local package cache, all 37 tests, type-checking, lint, and all six CLI demonstrations on Node.js 24.22.1. The current changes were uncommitted, so this verification used a source copy rather than claiming a Git clone of these changes. The tests cover isolated state, fresh loopback ports, successful and failed cleanup, cancellation, and subprocess exit without hanging resources.

The [benchmark harness](bench/benchmark.ts) uses three fresh-process repeats per mode, alternates direct/proxy ordering, and applies the same 500 ms warm-up, 2 s measurement window, concurrency of 8, and `GET /payload` response of 262,155 bytes (256 KiB of text plus JSON framing). Request bodies are empty. HTTP connection reuse is disabled on both client paths and on the proxy-to-service hop. Faults are disabled; the proxy retains at most 100 event records. Each successful response must have status `200`, complete framing, and the expected byte length.

Recorded environment: Apple M3, 8 logical CPUs, 16 GiB RAM, macOS/Darwin 27.0.0 arm64, Node.js 24.22.1. [Per-trial results and source SHA-256](benchmarks/node24-local.json) contain the runtime, configuration, counts, errors, latency percentiles, and memory samples summarized as baseline/peak/end.

- **Direct:** median trial throughput 2,780.4 requests/s; median trial p50/p95/p99 latency 2.59/4.83/5.94 ms. Sampled process peak RSS ranged from 256.8 to 291.9 MiB; peak JS heap used ranged from 101.9 to 109.0 MiB.
- **Proxied:** median trial throughput 1,884.2 requests/s; median trial p50/p95/p99 latency 3.79/6.64/8.78 ms. Sampled process peak RSS ranged from 358.8 to 391.7 MiB; peak JS heap used ranged from 95.5 to 112.9 MiB.
- **Errors:** zero during warm-up and measurement in all six trials; 16,678 direct and 11,201 proxied measured requests completed successfully.

These are medians of individual trial statistics, not pooled percentiles. Latency measures a full successful response; throughput includes draining requests started before the window ends. Memory is sampled every 20 ms and covers the combined client, service, and optional proxy process, including benchmark bookkeeping. It is not isolated proxy memory, a leak test, or proof of constant memory. This closed-loop generator shares the event loop with the servers, does not maintain an independent arrival rate, and does not compensate for coordinated omission. Connection setup, JSON generation, garbage collection, and other laptop activity affect the results. Do not present these numbers as maximum capacity or production overhead.

The updated resume describes the implemented proxy/CLI, verified idempotency and deadlines, 37 socket tests, and repeatable local benchmarks. It deliberately omits laptop throughput as a production-scale claim. React reporting and PostgreSQL persistence remain deferred.

Scenario files validate exact rule matches on method, path, logical request ID, and attempt. Duplicate IDs and ambiguous matches are rejected. `x-logical-request-id` stays stable across attempts, and `x-attempt` increments; these test headers are separate from the application `Idempotency-Key`. The proxy never retries upstream requests itself.

Reports include the run ID, versioned configuration, bounded attempt metadata, monotonic durations, client outcome, service-confirmed order count, and explicit assertions. They exclude bodies, credentials, and idempotency keys. Event overflow fails the evidence check. A response marked `response-written` means the proxy finished writing it, not that the client processed it.

## Run the demo server

Use Node.js 24 or newer (`nvm use` selects Node.js 24 if you use nvm).

```sh
npm ci
npm run build
npm start
```

The server listens on `127.0.0.1:3000`. Stop it with Ctrl+C. Run these requests in another terminal:

```sh
curl http://127.0.0.1:3000/health
curl -X POST http://127.0.0.1:3000/echo \
  -H 'Content-Type: application/json' \
  -d '{"message":"hello"}'
curl 'http://127.0.0.1:3000/delay?ms=1000'
```

- `GET /health` returns `{"status":"ok"}`.
- `POST /echo` returns the parsed JSON value. Invalid or empty JSON returns `400`; bodies over 64 KiB return `413`.
- `GET /delay?ms=1000` returns `{"delayMs":1000}` after the delay. The default is 1000 ms; valid values are integers from 0 through 10000. Invalid values return `400`.
- `GET /payload` returns a known JSON body containing 256 KiB of text with an explicit `Content-Length`, for streaming and truncation demonstrations.
- Unknown routes and unsupported methods return `404`.

To observe concurrency, start a delayed request in the background, then request health:

```sh
curl 'http://127.0.0.1:3000/delay?ms=3000' &
curl http://127.0.0.1:3000/health
wait
```

The health response can finish while the delay is pending. A disconnected delay client cancels its timer.

## Orders and idempotency

`POST /orders` accepts exactly three fields: `testId` and `item` are nonblank strings of at most 128 characters; `quantity` is a positive safe integer. Invalid payloads or keys return `400` without changing state. The same JSON parsing and 64 KiB body limit used by `/echo` apply.

```sh
curl -i -X POST http://127.0.0.1:3000/orders \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: demo-order-1' \
  -d '{"testId":"demo-run","item":"book","quantity":2}'
curl 'http://127.0.0.1:3000/orders?testId=demo-run'
```

Creation returns `201` with `{ "id": "<generated UUID>", "testId": "demo-run", "item": "book", "quantity": 2 }`. `GET /orders` returns all orders as an array; the optional `testId` query filters by exact match.

- Repeat the POST with the same key and payload: the original status and order are returned, and the order count stays at one. JSON property order does not matter.
- Change any payload field while retaining the key: the service returns `409` and leaves the original order unchanged.
- Omit the key or use a new key: every valid request creates another order.

Keys are optional nonblank strings of at most 128 characters, scoped to the server instance. Failed validation does not reserve a key. Each new server instance starts with empty orders and keys; restarting loses both stores. This is an in-memory demonstration, not durable or multi-process deduplication.

To follow the implementation, read the Zod schema, then the `POST /orders` handler in `demo/service.ts`. Body reading is asynchronous, but validation, key lookup, and state updates run synchronously once the complete JSON body is available. The order is stored **before** its response is sent: a client failing to receive that response does not undo the order. The lost-response scenario demonstrates this distinction.

## Development checks

```sh
npm run format:check
npm run typecheck
npm run lint
npm test
```

Run `npm run format` to format source, tests, configuration, and documentation with Prettier. Generated build output, dependencies, PDF artifacts, and the generated package lock are excluded.

`npm test` builds the project and runs local-socket integration tests with `node:test` and `node:assert/strict`.

Start reading at [`demo/service.ts`](demo/service.ts) for request handling, [`demo/main.ts`](demo/main.ts) for startup and shutdown, and [`test/service.test.ts`](test/service.test.ts) for executable examples.

Then follow [`src/proxy.ts`](src/proxy.ts) for streaming and faults, [`demo/client.ts`](demo/client.ts) for recovery, [`src/scenario.ts`](src/scenario.ts) for configuration validation, and [`src/runner.ts`](src/runner.ts) for assertions and lifecycle ownership. [`test/proxy.test.ts`](test/proxy.test.ts) exercises forwarding and failures; [`test/runner.test.ts`](test/runner.test.ts) demonstrates the complete scenarios and CLI.

The proxy pipes streams with backpressure. Before downstream headers are sent, upstream connection failures return `502` and proxy deadlines return `504`. After headers, the proxy interrupts the response rather than attempting to send a second status. Client disconnects cancel upstream work. The demo clients bound attempts, per-attempt time, and total operation time; a retry delay that cannot fit stops the operation. Timings allow a documented 50 ms scheduling tolerance. Jitter is intentionally disabled for these deterministic demonstrations.

- **Compilation:** `npm run build` checks TypeScript and emits JavaScript into `dist/`; it does not start the server.
- **Execution:** `npm start` runs the compiled JavaScript with Node.js. Rebuild after editing TypeScript.
- **Runtime validation:** TypeScript types do not validate incoming HTTP data. The shared JSON reader checks syntax and byte size; the delay handler checks the query value. Orders additionally use a Zod schema to validate payload fields at runtime, while `/echo` accepts any JSON value.

## Documentation

See the [documentation index](docs/README.md) for [requirements](docs/requirements.md), [architecture](docs/architecture.md), the [implementation guide](docs/implementation.md), and the [learning plan](docs/learning-plan.md).
