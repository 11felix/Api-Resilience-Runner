# Requirements and scope

[Documentation index](README.md)

## What the finished first version does

1. Starts a proxy targeting one configured local HTTP service.
2. Loads a validated scenario file.
3. Executes a local demo client against the proxy.
4. Applies specified faults to matching attempts.
5. Captures bounded request metadata and timings.
6. Checks explicit assertions supplied by the scenario/demo harness.
7. Writes a JSON report, prints a readable summary, and returns a failing exit code when appropriate.

Three required scenarios:

| Scenario                                      | Injected behaviour                                                                                                  | Assertion                                                         | Deliberately flawed client                         |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------- |
| Response lost after successful order creation | Forward the request; consume the upstream response; destroy the downstream connection without sending that response | Exactly one order exists after retries                            | Retries without an idempotency key                 |
| Rate limiting                                 | Return `429` and `Retry-After` before forwarding selected attempts                                                  | Client waits appropriately and respects its attempt limit         | Retries immediately or indefinitely                |
| Truncated response                            | Forward a bounded prefix of a known response and close the connection before completion                             | Client rejects incomplete data and terminates within its deadline | Treats partial content as success or never settles |

Each scenario has a corrected client that passes. The order service must explicitly confirm the side effect; a proxy observing a response does not prove arbitrary business transactions committed.

## Scope and boundaries

First-version boundaries: HTTP/1.1, explicit local target, JSON demo endpoints, sequential scenarios, no production traffic. Exclude HTTPS interception, arbitrary public targets, WebSockets, gRPC, GraphQL, Kubernetes, billing, and multi-user accounts.

A local build needs no paid API or cloud subscription. If you later deploy a demo, expose a fixed demo target rather than an unrestricted public proxy. Your ₹5,000/month budget is a ceiling, not a spending goal.
