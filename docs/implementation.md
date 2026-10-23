# Implementation guide

The service, proxy, faults, clients, scenario runner, reports, and direct/proxy measurements are implemented. Use the [root README](../README.md) for commands, source links, measured results, and limitations. The optional fixed-delay benchmark variant, React viewer, and PostgreSQL extension remain deferred; the stages below remain useful as a learning and verification guide.

[Documentation index](README.md)

## Stage 1 — Node.js foundations and a small HTTP service

**Suggested time:** 8–10 hours.

Learn:

- Promises, `async`/`await`, event listeners, and asynchronous error paths.
- The event loop at a practical level: blocking work delays other requests.
- HTTP methods, paths, status codes, headers, and body framing.
- Buffers versus strings; payload size limits.
- ESM, environment configuration, process exit codes, and graceful shutdown.
- TypeScript discriminated unions and runtime validation.

Resources: [TypeScript Handbook](https://www.typescriptlang.org/docs/handbook/intro.html), [Node.js introduction](https://nodejs.org/en/learn/getting-started/introduction-to-nodejs), and [HTTP API](https://nodejs.org/api/http.html). Read the sections needed for your exercise rather than entire API references.

Exercise: Implement `/health`, an echo endpoint, and a delayed response. Send requests using `curl`. Observe concurrent requests while a delay is pending.

Build: A local demo service with `POST /orders`, `GET /orders`, and a configurable large-response endpoint. Begin with in-memory state and a strict body-size limit. Implement an idempotency key: repeated requests with the same key and payload return the same result; conflicting payloads are rejected. Keep the state operation synchronous initially so the first demonstration is easy to reason about.

Verify:

- Invalid JSON and oversized payloads receive intentional errors.
- Reusing an idempotency key creates one order.
- Requests without a key can create multiple orders, as expected.
- You can explain why an in-memory key map does not survive restart or coordinate multiple processes.

## Stage 2 — A proxy with no faults

**Suggested time:** 12–16 hours.

Learn:

- Readable and writable streams, backpressure, and bounded buffering.
- The difference between a connection closing and a message completing.
- Header forwarding: target `Host`, hop-by-hop headers, and body framing.
- Upstream connection errors, client disconnects, timeouts, and cleanup.

Resources: [Node.js streams](https://nodejs.org/api/stream.html), [backpressure guide](https://nodejs.org/en/learn/modules/backpressuring-in-streams), and [HTTP API](https://nodejs.org/api/http.html).

Exercise: Stream a large file to a deliberately slow destination. Observe memory while changing the consumer speed. Learn what happens when `write()` returns `false`.

Build: A reverse proxy with one fixed upstream. Forward method, path, query, suitable headers, status, and bodies. Avoid reading entire proxy payloads into memory. Use stream tools deliberately: their error cleanup can destroy an HTTP response before you can send a fallback error, so test that interaction rather than assuming it works.

Verify:

- Direct and proxied requests produce equivalent application results.
- Query strings, non-success statuses, and large bodies pass through.
- A stopped upstream causes a prompt, intentional failure.
- A disconnected client does not leave upstream work or timers running indefinitely.
- Memory does not grow proportionally with the entire size of a streamed response.

Do not add fault rules until this baseline works.

## Stage 3 — Deterministic fault rules

**Suggested time:** 12–16 hours.

Learn: discriminated unions, validation, explicit state machines, deadlines, and the distinction between failure before a side effect and uncertainty after it.

Build fault types incrementally:

1. Delay forwarding by a fixed duration.
2. Return a synthetic status and headers without contacting the upstream.
3. Forward the request, consume the upstream response, then drop the downstream response.
4. Terminate a response after a specified byte prefix.

For truncation, use a controlled demo response with known framing and length. Do not end a shorter response as if it were complete. Test the actual client's observed failure; destroying a socket does not guarantee a particular TCP packet pattern.

Define rules by method, path, logical request ID, and attempt number. The demo client sends a stable logical ID and an incrementing attempt header. Keep these distinct from the application's idempotency key.

This produces repeatable fault selection without relying on whichever concurrent request arrives first. Validate unique rule matches or reject ambiguous configurations. Random probability and seeded randomness can wait; a seed alone does not make concurrent arrival order deterministic.

Verify:

- A pre-forward fault creates no upstream order.
- A lost response can occur after an order was created.
- A truncated response is rejected by the client.
- Unmatched traffic passes through normally.
- Re-running a scenario selects the same logical attempts; exact wall-clock timings may vary.

## Stage 4 — Retry behaviour and business assertions

**Suggested time:** 14–18 hours.

Learn:

- Per-attempt timeouts versus a total operation deadline.
- Bounded retries and exponential backoff; why jitter helps in real deployments.
- `Retry-After` delay values and HTTP-date values.
- Idempotency and ambiguous outcomes after connection loss.
- Why retrying every error can amplify an outage.

Build a deliberately flawed client and a corrected client. Keep fault injection in the proxy and recovery logic in the client. The proxy should not silently retry upstream requests.

The corrected client should preserve the idempotency key across attempts, stop at its attempt limit/deadline, respect valid rate-limit delays, and reject incomplete responses. Disable jitter for predictable demonstrations; document how you would add it for real clients.

Add explicit assertions:

- Order count for a test-specific identifier.
- Number of observed attempts.
- Minimum spacing after a rate-limit response, with documented timing tolerance.
- Client success/failure outcome and deadline compliance.

Verify: Each flawed client fails at least one meaningful assertion, and the corrected client passes the same scenario. Repeat the lost-response test to demonstrate that a client timeout does not imply no side effect occurred.

## Stage 5 — CLI, reports, and integration tests

**Suggested time:** 10–14 hours.

Learn: CLI arguments, configuration validation, monotonic timing, structured events, lifecycle ownership, and test isolation.

Build a command that accepts a scenario file. Use `node:util` argument parsing initially. Treat any command names you write in the README as available only once implemented.

Capture run ID, scenario/configuration version, logical request ID, attempt, matched rule, request start/end, observed status or error, and upstream/downstream outcomes. Report only what you observed; do not label a response delivery as proof the client processed it.

Use monotonic elapsed time for duration calculations. Limit events per run and avoid storing full bodies or credentials. Report overflow explicitly; missing evidence must not silently produce a pass.

Return distinct outcomes for assertion failure and runner/configuration failure. An invalid scenario or unavailable demo service is not a successful resilience test.

Resource: [Node.js test runner](https://nodejs.org/api/test.html).

Integration tests should exercise real local sockets:

- Successful forwarding and connection failure.
- Lost response with and without an idempotency key.
- Rate-limit timing and exhaustion of retries.
- Truncated body and deadline termination.
- Scenario state reset and cleanup after cancellation.

Use fresh local ports and isolated state. Avoid brittle assertions on exact milliseconds; use tolerances and combine timing checks with event evidence.

Verify: A fresh checkout can run all three scenarios, write reports, fail on the flawed clients, pass on corrected clients, and exit without hanging sockets or timers. Type-check and lint the code.

## Stage 6 — Measurements and presentation

**Suggested time:** 8–12 hours, after the functional core passes.

Run three comparable experiments: direct requests, proxy with faults disabled, and proxy with a fixed delay. Keep payload, concurrency, duration, and connection reuse consistent.

Measure throughput, latency distribution, error count, and memory. Warm up, repeat runs, and describe hardware/runtime settings. Use a load generator that reports its own limitations. Do not add p95 values and claim the sum is a valid measured percentile; compare actual distributions.

Record streaming behaviour with a large response and slow consumer. Investigate memory growth and unresolved requests before optimising. A benchmark on your laptop is not a claim of production scale.

Make a short demonstration:

1. Run the lost-response scenario against the flawed client; show duplicate orders.
2. Run it against the corrected client; show one order and multiple attempts.
3. Show rate-limit compliance and truncated-response rejection.
4. Explain the report and one cleanup or streaming bug you fixed.

An optional React viewer can display saved report timelines. Start with loading JSON; live updates are unnecessary for the first useful demo.

## Optional extension: durable idempotency in PostgreSQL

Only after the first version is complete, replace the demo service's in-memory order/key store with PostgreSQL. This is a useful SQL learning extension, not a dependency of the proxy.

Learn unique constraints, transactions, concurrent requests, and restart recovery. Make the idempotency record and order creation atomic; store a payload fingerprint to reject conflicting key reuse. Define which results can be reused after failures.

Verify: Concurrent attempts with the same key produce one order, conflicting payloads fail, and replay after service restart returns the original outcome. Explain why this is scoped deduplication rather than universal exactly-once execution.
