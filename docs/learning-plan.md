# Learning plan and completion checklist

[Documentation index](README.md)

## Project choice and goal

This guide assumes you chose the API failure simulator, expanded into an API resilience test runner. It is not a guide for the localhost tunnel or form builder.

**One-sentence description:** Route a local application's API calls through a fault-injection proxy, run repeatable failure scenarios, and report whether its retry and recovery behaviour meets explicit assertions.

Your goal is a finished project you can implement, debug, and explain independently in interviews. You already know TypeScript; use this project to learn Node.js networking and backend correctness. Do not treat it as a startup launch or a replacement for DSA practice.

The concept is established: [Toxiproxy](https://github.com/Shopify/toxiproxy) simulates network faults, and [MockServer](https://www.mock-server.com/mock_server/chaos_testing.html) supports HTTP fault injection. There is also an existing [TypeScript chaos proxy](https://github.com/codes4vinay/chaos-proxy). Do not claim novelty. Your value is a clear implementation, repeatable demonstrations, and measured results.

## Learning method

For each stage: read the relevant concepts, build a small exercise, implement the milestone, then explain it aloud without looking at the code. Spend more time writing and debugging than watching tutorials.

Use AI for questions, review, and hints. Attempt the core code first; ask for an explanation or debugging clue before asking for a complete implementation. After accepting a suggestion, explain why it works and reproduce the behaviour yourself.

Keep a short learning log: prediction, observed behaviour, explanation, and remaining uncertainty. Move on when the verification checks pass and you can explain the decisions.

## Suggested schedule alongside interview preparation

Plan for roughly 74–106 focused hours, not a weekend. These are estimates; streaming and lifecycle debugging may take longer.

| Week        | Project work                                           | Hours |
| ----------- | ------------------------------------------------------ | ----: |
| 1           | Foundations, demo service, basic proxy                 | 18–22 |
| 2           | Streaming baseline, cleanup, initial faults            | 18–22 |
| 3           | Remaining faults, flawed/corrected clients, assertions | 18–22 |
| 4           | Runner, reports, integration tests                     | 14–20 |
| 5 if needed | Measurements, README, short demo                       |  6–20 |

At 50–60 study hours/week, reserve about 20 for this project, 15 for DSA, 10 for system design/SQL, and 5 for applications/mocks. Use remaining time for weak areas or revision. Do not postpone applications until the project is finished.

If behind schedule, cut the React viewer and optional extensions. Keep the three reproducible scenarios and reports.

## Completion and resume checklist

- [x] Implemented the three scenarios and their explicit assertions.
- [x] Demonstrated failing and corrected client behaviour.
- [x] Verified streaming, disconnect cleanup, bounded logs, and isolation.
- [x] CLI returns meaningful exit codes and produces reports.
- [x] Relevant integration tests, `tsc --noEmit`, and lint pass.
- [x] README includes setup, limitations, architecture, and reproducible demo commands.
- [x] Benchmark results include methodology and actual measured values.
- [ ] Can explain the request lifecycle and debug it without generated replacement code.
- [ ] Can explain when retrying is unsafe and why an upstream success can become a client failure.

Verified resume wording:

> Built an HTTP fault-injection proxy and CLI for response loss, rate limits and truncated responses; verified idempotency, deadlines and cleanup with 37 socket tests and repeatable local benchmarks.

Add a second bullet with measured overhead or demonstrated correctness only when you have evidence. Do not claim production adoption, revenue, or unique technology.

**Start here:** Build the [Stage 1 echo service](implementation.md#stage-1--nodejs-foundations-and-a-small-http-service) independently. Explain how its request body arrives and how concurrent requests behave. Then build the small order service before touching the proxy.
