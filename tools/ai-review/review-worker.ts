import { ReviewFailure, workerFailure } from './failure.ts';
import { taskSchema } from './task-schema.ts';
import { requestStructuredReview } from './review.ts';
import { validateTaskResponse } from './partition-review.ts';
import type { TaskInvocation, TaskResult, TaskResponse } from './partition-review.ts';
import type { BillingHooks } from './budget.ts';
import { validatePlan } from './partition.ts';
import type { ReviewPlan } from './partition.ts';

// IPCは信頼済み親子間のみ。モデル応答はusageと最終結果に分ける。
if (import.meta.main) {
  process.once('message', async ({ plan, input }: { plan: ReviewPlan; input: TaskInvocation }) => {
    const notify = (message: object): Promise<void> =>
      new Promise((resolve, reject) => {
        process.once('message', (reply: { approved?: boolean }) => {
          if (reply?.approved === true) resolve();
          else reject(new Error('費用承認なし'));
        });
        process.send?.(message);
      });
    const billing: BillingHooks = {
      reserve: (input, hash) => notify({ kind: 'reserve', input, hash }),
      settle: (usage) => notify({ kind: 'settle', usage }),
    };
    try {
      validatePlan(plan);
      const schema = taskSchema(input.task);
      const result = await requestStructuredReview<TaskResponse, TaskResult>(
        process.env.OPENAI_ACCESS_TOKEN ?? '',
        input.prompt,
        (value) => validateTaskResponse(value, plan, input.task),
        fetch,
        schema,
        billing,
      );
      process.send?.({ kind: 'result', result });
    } catch (error) {
      process.send?.({
        kind: 'result',
        result: workerFailure(error instanceof ReviewFailure ? error : undefined),
      });
    } finally {
      process.disconnect?.();
    }
  });
}
