# API Resilience Runner

A TypeScript/Node.js project for testing retry and recovery behaviour under deterministic HTTP failures. The design routes a local application's API calls through a fault-injection proxy and checks explicit business assertions.

## Project scope

- Lost response after order creation: compare retries with and without a stable idempotency key, then assert the service's order count.
- Rate limiting: inject `429` and `Retry-After` responses and check retry spacing and attempt limits.
- Truncated response: interrupt a known response and check incomplete-body rejection and deadline compliance.

Each scenario pairs a deliberately flawed client with a corrected client. The runner will own service/proxy setup, scenario execution, assertions, JSON reporting and shutdown. Assertion failures and runner/configuration failures will have distinct exit codes.

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

This repository starts with the project design. Setup and demo commands will be documented alongside their implementation. No benchmark or production-adoption claims are made.
