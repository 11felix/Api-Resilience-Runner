import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { runScenario } from './runner.js';

const controller = new AbortController();
const cancel = () => controller.abort();
process.once('SIGINT', cancel);
process.once('SIGTERM', cancel);
let output: string | undefined;
try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      client: { type: 'string' },
      output: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  output = values.output;
  if (values.help) {
    console.log(
      'Usage: npm run run -- scenarios/lost-response.json [--client corrected|flawed] [--output report.json]',
    );
  } else {
    if (positionals.length !== 1)
      throw new Error('Provide exactly one scenario JSON file');
    if (
      values.client !== undefined &&
      values.client !== 'corrected' &&
      values.client !== 'flawed'
    ) {
      throw new Error('--client must be corrected or flawed');
    }
    const input: unknown = JSON.parse(await readFile(positionals[0], 'utf8'));
    const config =
      values.client === undefined
        ? input
        : {
            ...z.record(z.string(), z.unknown()).parse(input),
            client: values.client,
          };
    const report = await runScenario(config, controller.signal);
    if (output) await writeFile(output, JSON.stringify(report, null, 2) + '\n');
    console.log(
      `${report.status.toUpperCase()}: ${report.scenario} (${report.clientMode})`,
    );
    for (const assertion of report.assertions) {
      console.log(
        `${assertion.passed ? 'PASS' : 'FAIL'} ${assertion.name}: expected ${JSON.stringify(assertion.expected)}, observed ${JSON.stringify(assertion.actual)}`,
      );
    }
    if (!output) console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.status === 'passed' ? 0 : 1;
  }
} catch (error) {
  const message = controller.signal.aborted
    ? 'Run cancelled'
    : error instanceof Error
      ? error.message
      : 'Unknown runner failure';
  const report = { reportVersion: 1, status: 'runner-error', error: message };
  console.error(JSON.stringify(report));
  if (output) {
    try {
      await writeFile(output, JSON.stringify(report, null, 2) + '\n');
    } catch {
      console.error('Unable to write the requested report file');
    }
  }
  process.exitCode = 2;
} finally {
  process.removeListener('SIGINT', cancel);
  process.removeListener('SIGTERM', cancel);
}
