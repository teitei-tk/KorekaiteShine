import { ReviewFailure, workerFailure } from './failure.ts';
import { readFileSync } from 'node:fs';
import { requestStructuredReview } from './review.ts';
import { validateTaskResult } from './partition-review.ts';
import type { TaskInvocation, TaskResult } from './partition-review.ts';
import { validatePlan } from './partition.ts';
import type { ReviewPlan } from './partition.ts';

if (import.meta.main) {
  try {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
      bytes += chunk.length;
      if (bytes > 8_000_000) throw new Error('入力上限');
      chunks.push(chunk);
    }
    const { plan, input } = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      plan: ReviewPlan;
      input: TaskInvocation;
    };
    validatePlan(plan);
    const schema = JSON.parse(
      readFileSync(new URL('./partition-schema.json', import.meta.url), 'utf8'),
    );
    const result = await requestStructuredReview<TaskResult>(
      process.env.OPENAI_ACCESS_TOKEN ?? '',
      input.prompt,
      (value) => validateTaskResult(value, plan, input.task),
      fetch,
      schema,
    );
    process.stdout.write(JSON.stringify(result));
  } catch (error) {
    process.stdout.write(
      JSON.stringify(workerFailure(error instanceof ReviewFailure ? error : undefined)),
    );
  }
}
