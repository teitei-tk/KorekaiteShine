import { expect, test } from 'vitest';
import { createTestDatabase } from '../../../packages/database/testing/sqlite';
import { jobs } from '@korekaite/database';
import { acceptCheck } from '../src/diagnostics/accept';
import { getCheck } from '../src/diagnostics/get';

test('診断受付の冪等性・本人確認・入力不備とDB障害をHTTP境界で扱う', async () => {
  const data = createTestDatabase();
  const deps = {
    db: data.db,
    environment: 'test' as const,
    actorId: 'developer',
    newId: () => crypto.randomUUID(),
    now: () => 1000,
  };
  const key = crypto.randomUUID();
  const url = 'http://localhost/api/diagnostics/check-jobs';
  const read = (job: string, actorId = deps.actorId) =>
    getCheck(new Request(url), job, { ...deps, actorId });
  const post = (scenario: string, requestKey: string | null = key, type = 'application/json') =>
    acceptCheck(
      new Request(url, {
        method: 'POST',
        headers: {
          'Content-Type': type,
          ...(requestKey === null ? {} : { 'Idempotency-Key': requestKey }),
        },
        body: JSON.stringify({ scenario }),
      }),
      deps,
    );
  try {
    expect((await post('success', null)).status).toBe(400);
    expect((await post('success', 'invalid')).status).toBe(400);
    expect((await post('success', key, 'text/plain')).status).toBe(415);
    expect((await post('unknown')).status).toBe(400);
    const accepted = await post('success');
    expect(accepted.status).toBe(202);
    const original = await accepted.json();
    expect(await (await post('success')).json()).toEqual(original);
    expect((await post('exhaust_retries')).status).toBe(409);
    expect((await post('exhaust_retries', crypto.randomUUID())).status).toBe(202);
    expect((await read('invalid')).status).toBe(400);
    expect((await read(original.jobId, 'other')).status).toBe(404);
    expect(await (await read(original.jobId)).json()).toMatchObject({
      status: 'pending',
      nextAttemptAt: null,
      finishedAt: null,
    });
    await data.db.update(jobs).set({ finishedAt: 1001, nextAttemptAt: 1002 });
    expect(await (await read(original.jobId)).json()).toMatchObject({
      nextAttemptAt: '1970-01-01T00:00:01.002Z',
      finishedAt: '1970-01-01T00:00:01.001Z',
    });
    data.sqlite.exec(
      "CREATE TRIGGER reject_job BEFORE INSERT ON jobs BEGIN SELECT RAISE(ABORT, 'fixture'); END",
    );
    expect((await post('success', crypto.randomUUID())).status).toBe(503);
    data.sqlite.exec('DROP TABLE diagnostic_checks');
    expect((await read(original.jobId)).status).toBe(503);
  } finally {
    data.close();
  }
});
