import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { resolveRuntime } from '@korekaite/runtime-config';
import { validateCheckAccepted } from '@korekaite/api-contracts/http/diagnostics-validators';
import { startRuntime, runDatabaseCommand } from '../src/runtime.ts';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));

test('同じ冪等キーの同時要求は実D1のジョブと初期化outbox各1件へ集約する', async () => {
  const config = resolveRuntime({
    repositoryRoot,
    appEnv: 'test',
    runId: randomUUID(),
    parallelIndex: 0,
  });
  const runtime = await startRuntime(config);
  let succeeded = false;
  try {
    const key = randomUUID();
    const responses = await Promise.all(
      Array.from({ length: 4 }, () =>
        fetch(`${runtime.baseUrl}/api/diagnostics/check-jobs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
          body: JSON.stringify({ scenario: 'success' }),
        }),
      ),
    );
    const bodies = await Promise.all(
      responses.map(async (response) => {
        expect(response.status).toBe(202);
        expect(response.headers.get('Cache-Control')).toBe('no-store');
        const body = await response.json();
        expect(validateCheckAccepted(body)).toBe(true);
        expect(response.headers.get('Location')).toBe(`/api/diagnostics/check-jobs/${body.jobId}`);
        return body;
      }),
    );
    for (const body of bodies) expect(body).toEqual(bodies[0]);
    // 不成立時はCLIが失敗するCHECK制約で、HTTP応答だけでなく保存件数も検証する。
    await runDatabaseCommand(config, [
      'execute',
      `
      CREATE TEMP TABLE acceptance_assertion (count INTEGER CHECK (count = 1));
      INSERT INTO acceptance_assertion SELECT COUNT(*) FROM jobs;
      INSERT INTO acceptance_assertion SELECT COUNT(*) FROM job_outbox WHERE operation = 'initialize_do';
      INSERT INTO acceptance_assertion SELECT COUNT(*) FROM diagnostic_requests;
    `,
    ]);
    succeeded = true;
  } finally {
    await runtime.stop();
    if (succeeded) await rm(dirname(config.artifactDirectory), { recursive: true, force: true });
  }
}, 60_000);

test('不正入力は契約どおりの詳細を返し、修正後に同じキーで受付できる', async () => {
  const { diagnosticRequests, unsupportedMediaTypeRequest } =
    await import('../../../packages/api-contracts/tests/fixtures/diagnostic-requests.ts');
  const { validateCheckValidationError, validateCheckUnsupportedMediaType } =
    await import('@korekaite/api-contracts/http/diagnostics-validators');
  const config = resolveRuntime({
    repositoryRoot,
    appEnv: 'test',
    runId: randomUUID(),
    parallelIndex: 0,
  });
  const runtime = await startRuntime(config);
  let succeeded = false;
  try {
    for (const fixture of diagnosticRequests.filter((entry) => entry.method === 'POST')) {
      const response = await fetch(`${runtime.baseUrl}${fixture.path}`, {
        method: fixture.method,
        headers: fixture.headers,
        body: fixture.body,
      });
      expect(response.status, fixture.name).toBe(fixture.status);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      const body = await response.json();
      expect(validateCheckValidationError(body), fixture.name).toBe(true);
      expect(body.error.details, fixture.name).toContainEqual(
        expect.objectContaining({
          location: fixture.location,
          path: fixture.pointer,
          code: fixture.code,
        }),
      );
    }
    const media = await fetch(
      `${runtime.baseUrl}${unsupportedMediaTypeRequest.path}`,
      unsupportedMediaTypeRequest,
    );
    expect(media.status).toBe(415);
    expect(validateCheckUnsupportedMediaType(await media.json())).toBe(true);
    const corrected = await fetch(`${runtime.baseUrl}/api/diagnostics/check-jobs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': '7e318b72-f255-4f17-845b-714d487ae621',
      },
      body: '{"scenario":"success"}',
    });
    expect(corrected.status).toBe(202);
    succeeded = true;
  } finally {
    await runtime.stop();
    if (succeeded) await rm(dirname(config.artifactDirectory), { recursive: true, force: true });
  }
}, 60_000);

test('受付済みジョブの状態を必須null項目と観測結果付きで取得する', async () => {
  const { validateCheckStatus } =
    await import('@korekaite/api-contracts/http/diagnostics-validators');
  const config = resolveRuntime({
    repositoryRoot,
    appEnv: 'test',
    runId: randomUUID(),
    parallelIndex: 0,
  });
  const runtime = await startRuntime(config);
  let succeeded = false;
  try {
    const acceptedResponse = await fetch(`${runtime.baseUrl}/api/diagnostics/check-jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
      body: '{"scenario":"success"}',
    });
    expect(acceptedResponse.status).toBe(202);
    const accepted = await acceptedResponse.json();
    const response = await fetch(`${runtime.baseUrl}/api/diagnostics/check-jobs/${accepted.jobId}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const status = await response.json();
    expect(validateCheckStatus(status)).toBe(true);
    expect(status).toEqual({
      ...accepted,
      status: 'pending',
      attemptCount: 0,
      updatedAt: accepted.acceptedAt,
      finishedAt: null,
      nextAttemptAt: null,
      lastErrorCode: null,
      checks: {
        doPersistence: 'pending',
        consumerCompletion: 'pending',
        dlqReceipt: 'not_expected',
      },
    });
    succeeded = true;
  } finally {
    await runtime.stop();
    if (succeeded) await rm(dirname(config.artifactDirectory), { recursive: true, force: true });
  }
}, 60_000);

test('状態取得は不正IDを400、参照範囲外を同じ404として返す', async () => {
  const { validateCheckValidationError, validateCheckNotFound } =
    await import('@korekaite/api-contracts/http/diagnostics-validators');
  const config = resolveRuntime({
    repositoryRoot,
    appEnv: 'test',
    runId: randomUUID(),
    parallelIndex: 0,
  });
  const runtime = await startRuntime(config);
  let succeeded = false;
  try {
    const invalid = await fetch(`${runtime.baseUrl}/api/diagnostics/check-jobs/invalid`);
    expect(invalid.status).toBe(400);
    const invalidBody = await invalid.json();
    expect(validateCheckValidationError(invalidBody)).toBe(true);
    expect(invalidBody.error.details).toContainEqual(
      expect.objectContaining({ location: 'path', path: 'jobId', code: 'INVALID_FORMAT' }),
    );
    const accepted = await fetch(`${runtime.baseUrl}/api/diagnostics/check-jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
      body: '{"scenario":"success"}',
    });
    expect(accepted.status).toBe(202);
    const body = await accepted.json();
    expect(validateCheckAccepted(body)).toBe(true);
    const requestIds = new Set<string>();
    const expectNotFound = async (id: string) => {
      const response = await fetch(`${runtime.baseUrl}/api/diagnostics/check-jobs/${id}`);
      expect(response.status).toBe(404);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      const error = await response.json();
      expect(validateCheckNotFound(error)).toBe(true);
      requestIds.add(error.error.requestId);
    };
    await expectNotFound(randomUUID());
    // 使い捨てDBに1件だけある診断ジョブの参照範囲を変える。
    await runDatabaseCommand(config, ['execute', "UPDATE jobs SET actor_id = 'another-actor'"]);
    await expectNotFound(body.jobId);
    await runDatabaseCommand(config, [
      'execute',
      "UPDATE jobs SET actor_id = 'local-developer', purpose = 'evaluation'",
    ]);
    await expectNotFound(body.jobId);
    expect(requestIds.size).toBe(3);
    succeeded = true;
  } finally {
    await runtime.stop();
    if (succeeded) await rm(dirname(config.artifactDirectory), { recursive: true, force: true });
  }
}, 60_000);

test('同じキーと入力の逐次再送はJSONの空白によらず元の受付を返す', async () => {
  const config = resolveRuntime({
    repositoryRoot,
    appEnv: 'test',
    runId: randomUUID(),
    parallelIndex: 0,
  });
  const runtime = await startRuntime(config);
  let succeeded = false;
  try {
    const key = randomUUID();
    const results = [];
    for (const body of ['{"scenario":"success"}', '{ "scenario" : "success" }']) {
      const response = await fetch(`${runtime.baseUrl}/api/diagnostics/check-jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
        body,
      });
      expect(response.status).toBe(202);
      results.push({ body: await response.json(), location: response.headers.get('Location') });
    }
    expect(results[1]).toEqual(results[0]);
    await runDatabaseCommand(config, [
      'execute',
      `CREATE TEMP TABLE replay_assertion (count INTEGER CHECK (count = 1)); INSERT INTO replay_assertion SELECT COUNT(*) FROM jobs; INSERT INTO replay_assertion SELECT COUNT(*) FROM job_outbox;`,
    ]);
    succeeded = true;
  } finally {
    await runtime.stop();
    if (succeeded) await rm(dirname(config.artifactDirectory), { recursive: true, force: true });
  }
}, 60_000);

test('同じキーで異なるscenarioを送ると409となり元のジョブを変更しない', async () => {
  const { validateCheckConflict } =
    await import('@korekaite/api-contracts/http/diagnostics-validators');
  const config = resolveRuntime({
    repositoryRoot,
    appEnv: 'test',
    runId: randomUUID(),
    parallelIndex: 0,
  });
  const runtime = await startRuntime(config);
  let succeeded = false;
  try {
    const key = randomUUID();
    const post = (scenario: string) =>
      fetch(`${runtime.baseUrl}/api/diagnostics/check-jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
        body: JSON.stringify({ scenario }),
      });
    const first = await post('success');
    expect(first.status).toBe(202);
    const accepted = await first.json();
    const conflict = await post('exhaust_retries');
    expect(conflict.status).toBe(409);
    expect(conflict.headers.get('Cache-Control')).toBe('no-store');
    expect(validateCheckConflict(await conflict.json())).toBe(true);
    const replay = await post('success');
    expect(replay.status).toBe(202);
    expect(await replay.json()).toEqual(accepted);
    const status = await fetch(`${runtime.baseUrl}/api/diagnostics/check-jobs/${accepted.jobId}`);
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({
      scenario: 'success',
      status: 'pending',
      attemptCount: 0,
    });
    await runDatabaseCommand(config, [
      'execute',
      `CREATE TEMP TABLE conflict_assertion (count INTEGER CHECK (count = 1)); INSERT INTO conflict_assertion SELECT COUNT(*) FROM jobs; INSERT INTO conflict_assertion SELECT COUNT(*) FROM diagnostic_requests WHERE scenario = 'success'; INSERT INTO conflict_assertion SELECT COUNT(*) FROM job_outbox;`,
    ]);
    succeeded = true;
  } finally {
    await runtime.stop();
    if (succeeded) await rm(dirname(config.artifactDirectory), { recursive: true, force: true });
  }
}, 60_000);

test('終端ジョブへの同じキーの再送は再実行せず、新しいキーだけが新規受付となる', async () => {
  const config = resolveRuntime({
    repositoryRoot,
    appEnv: 'test',
    runId: randomUUID(),
    parallelIndex: 0,
  });
  const runtime = await startRuntime(config);
  let succeeded = false;
  try {
    const key = randomUUID();
    const post = (idempotencyKey: string) =>
      fetch(`${runtime.baseUrl}/api/diagnostics/check-jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
        body: '{"scenario":"success"}',
      });
    const first = await post(key);
    expect(first.status).toBe(202);
    const accepted = await first.json();
    for (const state of ['completed', 'failed', 'cancelled']) {
      // Consumerは後続タスク。ここでは実D1上の終端状態に対する受付の保証を検証する。
      await runDatabaseCommand(config, [
        'execute',
        `UPDATE jobs SET status = '${state}', attempt_count = 1, finished_at = 1793577600000;`,
      ]);
      const replay = await post(key);
      expect(replay.status).toBe(202);
      expect(await replay.json()).toEqual(accepted);
      const response = await fetch(
        `${runtime.baseUrl}/api/diagnostics/check-jobs/${accepted.jobId}`,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        status: state,
        attemptCount: 1,
        finishedAt: '2026-11-02T00:00:00.000Z',
      });
    }
    await runDatabaseCommand(config, [
      'execute',
      `CREATE TEMP TABLE terminal_assertion (count INTEGER CHECK (count = 1)); INSERT INTO terminal_assertion SELECT COUNT(*) FROM jobs; INSERT INTO terminal_assertion SELECT COUNT(*) FROM job_outbox;`,
    ]);
    const fresh = await post(randomUUID());
    expect(fresh.status).toBe(202);
    expect((await fresh.json()).jobId).not.toBe(accepted.jobId);
    await runDatabaseCommand(config, [
      'execute',
      `CREATE TEMP TABLE new_key_assertion (count INTEGER CHECK (count = 2)); INSERT INTO new_key_assertion SELECT COUNT(*) FROM jobs; INSERT INTO new_key_assertion SELECT COUNT(*) FROM job_outbox;`,
    ]);
    succeeded = true;
  } finally {
    await runtime.stop();
    if (succeeded) await rm(dirname(config.artifactDirectory), { recursive: true, force: true });
  }
}, 60_000);
