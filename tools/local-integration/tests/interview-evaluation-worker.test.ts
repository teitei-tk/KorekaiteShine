import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rm } from 'node:fs/promises';
import { Temporal } from '@js-temporal/polyfill';
import { expect, test } from 'vitest';
import { resolveRuntime } from '@korekaite/runtime-config';
import { startRuntime, runDatabaseCommand } from '../src/runtime.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));

test('失敗評価を正式HTTPから再実行し、実Queue経由で無回答の五軸結果を保存する', async () => {
  const config = resolveRuntime({
    repositoryRoot: root,
    appEnv: 'test',
    runId: randomUUID(),
    parallelIndex: 0,
  });
  const runtime = await startRuntime(config, 'dev', { interviewEvaluationMock: true });
  let succeeded = false;
  try {
    const failedJobId = randomUUID();
    const now = Temporal.Now.instant().epochMilliseconds;
    const snapshot = {
      schemaVersion: 1,
      interview: {
        interviewId: 'fixture',
        materialHash: 'hash',
        themeTitle: '構成',
        themeHeading: '判断',
        themeExcerpt: '架空の経験',
        background: '',
        activeMs: 0,
      },
      fragments: [],
      playback: [],
      transcriptIncomplete: false,
      evaluation: {
        model: 'mock',
        promptVersion: 'v1',
        rubricVersion: 'v1',
        instructions: '架空の指示',
        rubric: '架空の基準',
      },
    };
    const input = JSON.stringify(snapshot).replaceAll("'", "''");
    await runDatabaseCommand(config, [
      'execute',
      `
      INSERT INTO interviews (interview_id,actor_id,material_hash,theme_title,theme_heading,theme_excerpt,background,status,created_at,updated_at,ended_at) VALUES ('fixture','local-developer','hash','構成','判断','架空の経験','','ended',${now},${now},${now});
      INSERT INTO jobs (job_id,actor_id,purpose,status,accepted_at,updated_at) VALUES ('${failedJobId}','local-developer','evaluation','failed',${now},${now});
      INSERT INTO evaluation_inputs (job_id,interview_id,kind,last_sequence,input_json,model,prompt_version,rubric_version,created_at) VALUES ('${failedJobId}','fixture','initial',0,'${input}','mock','v1','v1',${now});
    `,
    ]);
    const bootstrap = await fetch(`${runtime.baseUrl}/api/local-session`);
    const cookie = bootstrap.headers.get('Set-Cookie')!.split(';')[0];
    const { operationToken } = await bootstrap.json();
    const retry = () =>
      fetch(`${runtime.baseUrl}/api/interviews/fixture/retry`, {
        method: 'POST',
        headers: {
          Cookie: cookie,
          Origin: runtime.baseUrl,
          'X-Interview-Token': operationToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ failedJobId }),
      });
    const responses = await Promise.all([retry(), retry()]);
    expect(responses.map((response) => response.status)).toEqual([202, 202]);
    const [{ jobId }, replay] = await Promise.all(responses.map((response) => response.json()));
    expect(replay.jobId).toBe(jobId);
    expect(jobId).not.toBe(failedJobId);
    await runtime.runScheduled();
    await expect
      .poll(
        async () => {
          const response = await fetch(`${runtime.baseUrl}/api/formal-queue-test?jobId=${jobId}`);
          return response.json();
        },
        { timeout: 30000, interval: 200 },
      )
      .toMatchObject({ status: 'completed', attemptCount: 1 });
    await runDatabaseCommand(config, [
      'execute',
      `
      CREATE TEMP TABLE assertion (value INTEGER CHECK (value = 1));
      INSERT INTO assertion SELECT COUNT(*) FROM job_attempts WHERE job_id='${jobId}' AND json_extract(result_json,'$.axes.problem.status')='unconfirmed' AND json_extract(result_json,'$.axes.problem.score') IS NULL AND json_extract(result_json,'$.summary')='評価対象の回答なし';
      INSERT INTO assertion SELECT NOT EXISTS (SELECT 1 FROM usage_reservations WHERE kind='evaluation');
      INSERT INTO assertion SELECT COUNT(*) FROM job_outbox WHERE job_id='${jobId}' AND sent_at IS NOT NULL;
    `,
    ]);
    succeeded = true;
  } finally {
    await runtime.stop();
    if (succeeded) {
      await rm(dirname(config.stateDirectory!), { recursive: true, force: true });
    }
  }
}, 90000);
