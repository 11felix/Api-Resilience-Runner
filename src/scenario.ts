import { z } from 'zod';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const milliseconds = z.number().int().min(1).max(60_000);
const faultSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('lost-response') }),
  z.strictObject({
    type: z.literal('rate-limit'),
    delaySeconds: z.number().int().min(1).max(30),
    format: z.enum(['seconds', 'http-date']),
  }),
  z.strictObject({
    type: z.literal('truncate'),
    bytes: z.number().int().min(1).max(65_536),
  }),
]);

export const ruleSchema = z.strictObject({
  id,
  method: z.enum(['GET', 'POST']),
  path: z
    .string()
    .regex(/^\/[a-zA-Z0-9/_-]*$/)
    .max(128),
  logicalRequestId: id,
  attempt: z.number().int().min(1).max(10),
  fault: faultSchema,
});
export type Rule = z.infer<typeof ruleSchema>;

export const scenarioSchema = z
  .strictObject({
    version: z.literal(1),
    name: id,
    kind: z.enum(['lost-response', 'rate-limit', 'truncated-response']),
    client: z.enum(['flawed', 'corrected']).default('corrected'),
    logicalRequestId: id,
    maxAttempts: z.number().int().min(1).max(10).default(2),
    attemptTimeoutMs: milliseconds.default(1000),
    deadlineMs: milliseconds.default(5000),
    proxyTimeoutMs: milliseconds.default(2000),
    maxEvents: z.number().int().min(1).max(1000).default(100),
    rules: z.array(ruleSchema).min(1).max(20),
    expected: z.strictObject({
      outcome: z.enum(['success', 'failure']),
      attempts: z.number().int().min(1).max(10),
      orderCount: z.number().int().min(0).max(10),
      respectRetryAfter: z.boolean().default(false),
    }),
  })
  .superRefine((scenario, context) => {
    const matches = new Set<string>();
    const ids = new Set<string>();
    for (const [index, rule] of scenario.rules.entries()) {
      const match = JSON.stringify([
        rule.method,
        rule.path,
        rule.logicalRequestId,
        rule.attempt,
      ]);
      if (matches.has(match) || ids.has(rule.id)) {
        context.addIssue({
          code: 'custom',
          path: ['rules', index],
          message: 'Duplicate rule ID or ambiguous request match',
        });
      }
      matches.add(match);
      ids.add(rule.id);
      const truncated = scenario.kind === 'truncated-response';
      if (
        rule.logicalRequestId !== scenario.logicalRequestId ||
        rule.method !== (truncated ? 'GET' : 'POST') ||
        rule.path !== (truncated ? '/payload' : '/orders') ||
        rule.attempt > scenario.maxAttempts ||
        rule.fault.type !== (truncated ? 'truncate' : scenario.kind)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['rules', index],
          message:
            'Rule must target this scenario operation and an allowed attempt',
        });
      }
    }
    if (scenario.expected.attempts > scenario.maxAttempts) {
      context.addIssue({
        code: 'custom',
        path: ['expected', 'attempts'],
        message: 'Expected attempts exceed the attempt limit',
      });
    }
  });
export type Scenario = z.infer<typeof scenarioSchema>;
