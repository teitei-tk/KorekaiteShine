import { readFixtureObject } from './json';
import { Temporal } from '@js-temporal/polyfill';
import type { D1Database, MessageBatch } from '@cloudflare/workers-types';
import type { JobNotification } from '@korekaite/api-contracts/messages';
import { validateJobNotification } from '@korekaite/api-contracts/messages/validators';
import { connectionChecks, jobs } from '@korekaite/database';
import { createPrimaryDb } from '@korekaite/database/connection';
import { eq } from 'void/db';

type TestEnvironment = {
  APP_ENV: string;
  DB: D1Database;
};

export async function stopAfterResultBeforeAckForTest(
  batch: MessageBatch<JobNotification>,
  env: TestEnvironment,
  consume: (batch: MessageBatch<JobNotification>) => Promise<void>,
): Promise<void> {
  if (env.APP_ENV !== 'test') {
    throw new Error('ack前の停止はtest環境専用です。');
  }
  const acknowledgements = new Set<(typeof batch.messages)[number]>();
  await consume({
    queue: batch.queue,
    metadata: batch.metadata,
    messages: batch.messages.map((message) => ({
      id: message.id,
      timestamp: message.timestamp,
      body: message.body,
      attempts: message.attempts,
      retry: message.retry.bind(message),
      ack: () => {
        acknowledgements.add(message);
      },
    })),
    retryAll: batch.retryAll.bind(batch),
    ackAll: () => {
      for (const message of batch.messages) {
        acknowledgements.add(message);
      }
    },
  });
  const primary = createPrimaryDb(env.DB);
  for (const message of acknowledgements) {
    if (validateJobNotification(message.body)) {
      const { jobId } = message.body;
      const [job] = await primary.select().from(jobs).where(eq(jobs.jobId, jobId));
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- noUncheckedIndexedAccess=falseでは空配列を型で表現できないため、DB検索や配列先頭の欠損ガードを維持する。
      if (job?.purpose === 'diagnostics' && job.status === 'completed') {
        const claimed = await primary
          .insert(connectionChecks)
          .values({
            writer: `fault-before-ack:${jobId}`,
            value: JSON.stringify({
              kind: 'exception',
              queue: batch.queue,
              messageId: message.id,
              occurredAt: Temporal.Now.instant().epochMilliseconds,
            }),
          })
          .onConflictDoNothing()
          .returning({ writer: connectionChecks.writer });
        if (claimed.length > 0) {
          throw new Error('simulated_consumer_stop_before_ack');
        }
        message.ack();
        await primary
          .insert(connectionChecks)
          .values({
            writer: `ack-after-stop:${jobId}:${message.id}`,
            value: 'ack_called',
          })
          .onConflictDoNothing();
        continue;
      }
    }
    message.ack();
  }
}

export async function readAckStopHistoryForTest(env: TestEnvironment, jobId: string) {
  if (env.APP_ENV !== 'test' || !validateJobNotification({ schemaVersion: 1, jobId })) {
    throw new Error('テスト要求が不正です。');
  }
  const rows = await createPrimaryDb(env.DB).select().from(connectionChecks);
  const stopped = rows.find((row) => row.writer === `fault-before-ack:${jobId}`);
  if (!stopped) {
    return { stop: null, acknowledgedMessageId: null, deliveries: [] };
  }
  const stop = readFixtureObject(stopped.value);
  if (
    stop.kind !== 'exception' ||
    typeof stop.queue !== 'string' ||
    typeof stop.messageId !== 'string' ||
    typeof stop.occurredAt !== 'number'
  ) {
    throw new Error('停止履歴の形式が不正です。');
  }
  const { queue, messageId } = stop;
  const deliveries = rows
    .filter((row) => row.writer.startsWith(`queue-attempt:${queue}:${messageId}:`))
    .map((row) => {
      const value = readFixtureObject(row.value);
      if (
        typeof value.messageId !== 'string' ||
        typeof value.attempt !== 'number' ||
        typeof value.receivedAt !== 'number'
      ) {
        throw new TypeError('配送履歴の形式が不正です。');
      }
      return { messageId: value.messageId, attempt: value.attempt, receivedAt: value.receivedAt };
    })
    .toSorted((left, right) => left.attempt - right.attempt);
  return {
    stop,
    acknowledgedMessageId: rows.some((row) => row.writer === `ack-after-stop:${jobId}:${messageId}`)
      ? messageId
      : null,
    deliveries,
  };
}
