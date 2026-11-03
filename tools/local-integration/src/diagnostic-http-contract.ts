import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { resolveRuntime } from '@korekaite/runtime-config';
import {
  validateCheckAccepted,
  validateCheckStatus,
  validateCheckValidationError,
  validateCheckUnsupportedMediaType,
  validateCheckConflict,
  validateCheckNotFound,
  validateCheckInternalError,
  validateCheckUnavailable,
} from '@korekaite/api-contracts/http/diagnostics-validators';
import {
  diagnosticRequests,
  unsupportedMediaTypeRequest,
} from '../../../packages/api-contracts/tests/fixtures/diagnostic-requests.ts';
import { runWithEvidence } from './evidence.ts';
import { runtimeVersions } from './versions.ts';
import { buildRuntime, startRuntime, runDatabaseCommand } from './runtime.ts';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const endpoint = '/api/diagnostics/check-jobs';

export async function runDiagnosticHttpContractIntegration(): Promise<
  { mode: 'dev' | 'preview'; resultPath: string }[]
> {
  const runId = randomUUID();
  const results: { mode: 'dev' | 'preview'; resultPath: string }[] = [];
  for (const [parallelIndex, mode] of (['dev', 'preview'] as const).entries()) {
    const config = resolveRuntime({ repositoryRoot, appEnv: 'test', runId, parallelIndex });
    const resultPath = join(dirname(config.artifactDirectory), 'results.json');
    await runWithEvidence(
      {
        resultPath,
        metadata: {
          environment: 'test',
          runId,
          parallelIndex,
          mode,
          clock: 'real',
          case: 'diagnostics-http-contract',
          versions: await runtimeVersions(),
          expected: {
            statuses: [
              400, 400, 400, 400, 400, 400, 400, 400, 415, 202, 202, 409, 200, 404, 404, 404, 500,
              500, 503, 503,
            ],
          },
        },
      },
      async (evidence) => {
        evidence.cleanup(async (passed) => {
          if (!passed) {
            return;
          }
          await rm(config.stateDirectory!, { recursive: true, force: true });
          await rm(config.artifactDirectory, { recursive: true, force: true });
        });
        if (mode === 'preview') {
          await buildRuntime(config);
        }
        const runtime = await startRuntime(config, mode);
        evidence.cleanup(() => runtime.stop());
        const cases: { name: string; status: number; noStore: boolean; contractValid: boolean }[] =
          [];
        evidence.observe({ cases });
        const request = (path: string, init: RequestInit = {}) =>
          fetch(`${runtime.baseUrl}${path}`, {
            ...init,
            signal: AbortSignal.timeout(10_000),
          });
        async function record(response: Response, name: string, status: number) {
          const row = {
            name,
            status: response.status,
            noStore: response.headers.get('Cache-Control') === 'no-store',
            contractValid: false,
          };
          cases.push(row);
          assert.equal(response.status, status, name);
          assert.equal(row.noStore, true, name);
          assert.match(response.headers.get('Content-Type') ?? '', /^application\/json\b/u);
          return { row, body: await response.json() };
        }
        for (const fixture of diagnosticRequests) {
          const result = await record(
            await request(fixture.path, fixture),
            fixture.name,
            fixture.status,
          );
          assert.ok(validateCheckValidationError(result.body));
          assert.ok(
            result.body.error.details.some(
              (detail) =>
                detail.location === fixture.location &&
                detail.path === fixture.pointer &&
                detail.code === fixture.code,
            ),
          );
          result.row.contractValid = true;
        }
        const media = await record(
          await request(unsupportedMediaTypeRequest.path, unsupportedMediaTypeRequest),
          'unsupported-media-type',
          415,
        );
        assert.ok(validateCheckUnsupportedMediaType(media.body));
        media.row.contractValid = true;
        const key = randomUUID();
        const post = (scenario = 'success', idempotencyKey = key) =>
          request(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
            body: JSON.stringify({ scenario }),
          });
        const response = await post();
        const accepted = await record(response, 'accepted', 202);
        assert.ok(validateCheckAccepted(accepted.body));
        const jobId = accepted.body.jobId;
        assert.equal(response.headers.get('Location'), `${endpoint}/${jobId}`);
        accepted.row.contractValid = true;
        const replay = await record(await post(), 'replay', 202);
        assert.ok(validateCheckAccepted(replay.body));
        assert.deepEqual(replay.body, accepted.body);
        replay.row.contractValid = true;
        const conflict = await record(await post('exhaust_retries'), 'conflict', 409);
        assert.ok(validateCheckConflict(conflict.body));
        conflict.row.contractValid = true;
        const deadline = performance.now() + 30_000;
        for (;;) {
          const statusResponse = await request(`${endpoint}/${jobId}`);
          const body = await statusResponse.clone().json();
          assert.ok(validateCheckStatus(body));
          assert.equal(body.jobId, jobId);
          if (body.status === 'completed') {
            const status = await record(statusResponse, 'completed', 200);
            assert.equal(body.attemptCount, 1);
            assert.deepEqual(body.checks, {
              doPersistence: 'passed',
              consumerCompletion: 'passed',
              dlqReceipt: 'not_expected',
            });
            evidence.observe({
              completedJob: {
                status: body.status,
                attemptCount: body.attemptCount,
                checks: body.checks,
              },
            });
            status.row.contractValid = true;
            break;
          }
          await statusResponse.body?.cancel();
          assert.notEqual(body.status, 'failed');
          assert.ok(performance.now() < deadline, '診断ジョブが期限内に完了しませんでした。');
          await delay(100);
        }
        const missing = await record(await request(`${endpoint}/${randomUUID()}`), 'missing', 404);
        assert.ok(validateCheckNotFound(missing.body));
        missing.row.contractValid = true;
        for (const [name, update] of [
          ['other-actor', "actor_id = 'another-actor'"],
          ['other-purpose', "actor_id = 'local-developer', purpose = 'evaluation'"],
        ]) {
          await runDatabaseCommand(config, [
            'execute',
            `UPDATE jobs SET ${update} WHERE job_id = '${jobId}';`,
          ]);
          const notFound = await record(await request(`${endpoint}/${jobId}`), name!, 404);
          assert.ok(validateCheckNotFound(notFound.body));
          notFound.row.contractValid = true;
        }
        // 日時変換で発生する非DB例外を、テストDBの不正値だけで再現する。
        await runDatabaseCommand(config, [
          'execute',
          `
        UPDATE jobs SET actor_id = 'local-developer', purpose = 'diagnostics', accepted_at = 9007199254740991 WHERE job_id = '${jobId}';
        UPDATE diagnostic_requests SET accepted_at = 9007199254740991 WHERE job_id = '${jobId}';
      `,
        ]);
        for (const [name, response] of [
          ['internal-start', await post()],
          ['internal-get', await request(`${endpoint}/${jobId}`)],
        ] as const) {
          const failure = await record(response, name, 500);
          assert.ok(validateCheckInternalError(failure.body));
          assert.ok(!JSON.stringify(failure.body).includes('Invalid time value'));
          failure.row.contractValid = true;
        }
        const acceptedAt = Temporal.Instant.from(accepted.body.acceptedAt).epochMilliseconds;
        assert.ok(Number.isFinite(acceptedAt));
        await runDatabaseCommand(config, [
          'execute',
          `
        UPDATE jobs SET accepted_at = ${acceptedAt} WHERE job_id = '${jobId}';
        UPDATE diagnostic_requests SET accepted_at = ${acceptedAt} WHERE job_id = '${jobId}';
        CREATE TRIGGER fail_accept BEFORE INSERT ON jobs BEGIN SELECT RAISE(FAIL, 'private_database_failure'); END;
      `,
        ]);
        const unavailable = await record(
          await post('success', randomUUID()),
          'unavailable-start',
          503,
        );
        assert.ok(validateCheckUnavailable(unavailable.body));
        assert.ok(!JSON.stringify(unavailable.body).includes('private_database_failure'));
        unavailable.row.contractValid = true;
        await runDatabaseCommand(config, [
          'execute',
          'DROP TRIGGER fail_accept; DROP TABLE diagnostic_checks;',
        ]);
        const readFailure = await record(
          await request(`${endpoint}/${jobId}`),
          'unavailable-get',
          503,
        );
        assert.ok(validateCheckUnavailable(readFailure.body));
        assert.ok(!JSON.stringify(readFailure.body).includes('diagnostic_checks'));
        assert.notEqual(readFailure.body.error.requestId, unavailable.body.error.requestId);
        readFailure.row.contractValid = true;
      },
    );
    results.push({ mode, resultPath });
  }
  return results;
}
