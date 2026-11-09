import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rm } from 'node:fs/promises';
import { expect, test } from 'vitest';
import { resolveRuntime } from '@korekaite/runtime-config';
import type { InterviewServerEvent } from '@korekaite/api-contracts/events/interview-server';
import { validateInterviewServerEvent } from '@korekaite/api-contracts/events/validators';
import { startRuntime, runDatabaseCommand } from '../src/runtime.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
test('実DOの音声面接をモックAIで開始・終了し、実Queueの評価結果まで保存する', async () => {
  const config = resolveRuntime({
    repositoryRoot: root,
    appEnv: 'test',
    runId: randomUUID(),
    parallelIndex: 0,
  });
  const runtime = await startRuntime(config, 'dev', {
    materialAnalysisMock: true,
    interviewVoiceMock: true,
    interviewEvaluationMock: true,
  });
  let succeeded = false;
  let socket: WebSocket | undefined;
  try {
    const bootstrap = await fetch(`${runtime.baseUrl}/api/local-session`);
    expect(bootstrap.status).toBe(200);
    const cookie = bootstrap.headers.get('Set-Cookie')!.split(';')[0];
    const { operationToken } = await bootstrap.json();
    const headers = {
      Cookie: cookie,
      Origin: runtime.baseUrl,
      'Content-Type': 'application/json',
      'X-Interview-Token': operationToken,
    };
    const analysis = await fetch(`${runtime.baseUrl}/api/materials/analyze`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ confirmed: true, markdown: '架空の経験' }),
    });
    expect(analysis.status).toBe(200);
    const { analysisId } = await analysis.json();
    const creation = await fetch(`${runtime.baseUrl}/api/interviews`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        interviewId: 'voice-fixture',
        analysisId,
        themeIndex: 0,
        background: '',
      }),
    });
    expect(creation.status).toBe(200);
    const events: InterviewServerEvent[] = [];
    // NodeのWebSocketではブラウザが自動付与するCookieとOriginを明示する。
    const LocalSocket = WebSocket as typeof WebSocket & {
      new (url: string, init: { headers: Record<string, string> }): WebSocket;
    };
    async function openPeer() {
      const peer = new LocalSocket(
        `${runtime.baseUrl.replace('http:', 'ws:')}/api/interviews/voice-fixture/live`,
        { headers: { Cookie: cookie, Origin: runtime.baseUrl } },
      );
      peer.addEventListener('message', (message) => {
        if (typeof message.data === 'string') {
          const event = JSON.parse(message.data);
          if (validateInterviewServerEvent(event)) {
            events.push(event);
            if (event.type === 'deleted') {
              peer.close();
            }
          }
        }
      });
      await new Promise<void>((resolve, reject) => {
        peer.addEventListener('open', () => resolve(), { once: true });
        peer.addEventListener('error', () => reject(new Error('面接WebSocketに接続できません。')), {
          once: true,
        });
      });
      return peer;
    }
    socket = await openPeer();
    socket.send(JSON.stringify({ type: 'start', commandId: 'start', generation: 0 }));
    await expect
      .poll(() => events.some((event) => event.type === 'state' && event.status === 'active'), {
        timeout: 10000,
      })
      .toBe(true);
    const audio = new ArrayBuffer(10);
    new DataView(audio).setFloat64(0, 1);
    socket.send(audio);
    await expect
      .poll(() => events.filter((event) => event.type !== 'state'), {
        timeout: 10000,
      })
      .toContainEqual(expect.objectContaining({ type: 'transcript', speaker: 'user' }));
    const closed = new Promise<void>((resolve) =>
      socket!.addEventListener('close', () => resolve(), { once: true }),
    );
    socket.close();
    await closed;
    events.length = 0;
    socket = await openPeer();
    await expect
      .poll(() => events.some((e) => e.type === 'state' && e.status === 'reconnecting'), {
        timeout: 10000,
      })
      .toBe(true);
    socket.send(JSON.stringify({ type: 'resume', commandId: 'resume', generation: 2 }));
    await expect
      .poll(
        () => events.some((e) => e.type === 'state' && e.status === 'active' && e.generation === 3),
        { timeout: 10000 },
      )
      .toBe(true);
    new DataView(audio).setFloat64(0, 3);
    socket.send(audio);
    await expect
      .poll(() => events.some((e) => e.type === 'transcript' && e.generation === 3), {
        timeout: 10000,
      })
      .toBe(true);
    socket.send(JSON.stringify({ type: 'finish', commandId: 'end', generation: 3 }));
    await expect
      .poll(() => events.some((event) => event.type === 'state' && event.status === 'ended'), {
        timeout: 10000,
      })
      .toBe(true);
    const ended = events
      .filter((event) => event.type === 'state' && event.status === 'ended')
      .at(-1);
    if (!ended || ended.type !== 'state' || !ended.evaluationJobId) {
      throw new Error('終了受付のジョブがありません。');
    }
    await runtime.runScheduled();
    await expect
      .poll(
        async () =>
          (
            await fetch(`${runtime.baseUrl}/api/interviews/voice-fixture`, {
              headers: { Cookie: cookie },
            })
          ).json(),
        { timeout: 30000, interval: 200 },
      )
      .toMatchObject({
        session: { status: 'ended' },
        transcripts: [1, 3].map((generation) => ({
          generation,
          speaker: 'user',
          content: '架空の回答です。',
        })),
        evaluation: {
          jobId: ended.evaluationJobId,
          status: 'completed',
          attemptCount: 1,
          result: { axes: { problem: { status: 'unconfirmed' } } },
        },
      });
    await runDatabaseCommand(config, [
      'execute',
      `CREATE TEMP TABLE assertion (value INTEGER CHECK (value = 1)); INSERT INTO assertion SELECT COUNT(*) FROM transcript_fragments WHERE interview_id='voice-fixture' AND generation=3 AND speaker='user' AND content='架空の回答です。'; INSERT INTO assertion SELECT COUNT(*) FROM job_attempts WHERE job_id='${ended.evaluationJobId}' AND json_extract(result_json,'$.axes.problem.status')='unconfirmed'; INSERT INTO assertion SELECT COUNT(*) FROM usage_reservations WHERE reservation_id='evaluation:${ended.evaluationJobId}' AND kind='evaluation' AND amount=1; INSERT INTO assertion SELECT COUNT(*) FROM audio_usage_periods WHERE interview_id='voice-fixture' AND generation=1 AND ended_at>=started_at;`,
    ]);
    const deleted = await fetch(`${runtime.baseUrl}/api/interviews/voice-fixture`, {
      method: 'DELETE',
      headers,
    });
    expect(deleted.status).toBe(204);
    await expect.poll(() => events.some((e) => e.type === 'deleted'), { timeout: 5000 }).toBe(true);
    await expect.poll(() => socket?.readyState, { timeout: 5000 }).toBe(WebSocket.CLOSED);
    for (const source of ['source=web', 'source=evaluation&kind=dlq']) {
      const late = await fetch(`${runtime.baseUrl}/api/formal-queue-test?${source}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schemaVersion: 1, jobId: ended.evaluationJobId }),
      });
      expect(late.status).toBe(202);
    }
    await expect
      .poll(
        async () => {
          try {
            await runDatabaseCommand(config, [
              'execute',
              `CREATE TEMP TABLE assertion (value INTEGER CHECK(value=2)); INSERT INTO assertion SELECT COUNT(*) FROM delivery_anomalies WHERE code='JOB_DELETED' AND job_id='${ended.evaluationJobId}';`,
            ]);
            return true;
          } catch {
            return false;
          }
        },
        { timeout: 30000, interval: 500 },
      )
      .toBe(true);
    expect(
      (
        await fetch(`${runtime.baseUrl}/api/interviews/voice-fixture`, {
          headers: { Cookie: cookie },
        })
      ).status,
    ).toBe(404);
    await runDatabaseCommand(config, [
      'execute',
      `CREATE TEMP TABLE assertion (value INTEGER CHECK(value=0)); INSERT INTO assertion SELECT COUNT(*) FROM jobs WHERE job_id='${ended.evaluationJobId}'; INSERT INTO assertion SELECT COUNT(*) FROM transcript_fragments WHERE interview_id='voice-fixture'; INSERT INTO assertion SELECT COUNT(*) FROM material_analyses WHERE analysis_id='${analysisId}';`,
    ]);
    succeeded = true;
  } finally {
    socket?.close();
    await runtime.stop();
    if (succeeded) {
      await rm(dirname(config.stateDirectory!), { recursive: true, force: true });
    }
  }
}, 90000);
