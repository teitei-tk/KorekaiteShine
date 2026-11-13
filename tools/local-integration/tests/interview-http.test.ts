import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rm, readFile, readdir } from 'node:fs/promises';
import { expect, test, vi } from 'vitest';
import { resolveRuntime } from '@korekaite/runtime-config';
import { buildRuntime, startRuntime, runDatabaseCommand } from '../src/runtime.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
test('正式HTTPでローカル認可から面接作成・履歴・詳細を実D1へ接続する', async () => {
  const config = resolveRuntime({
    repositoryRoot: root,
    appEnv: 'test',
    runId: randomUUID(),
    parallelIndex: 0,
  });
  const runtime = await startRuntime(config, 'dev', { materialAnalysisMock: true });

  try {
    expect((await fetch(`${runtime.baseUrl}/api/interview-history`)).status).toBe(403);
    const bootstrap = await fetch(`${runtime.baseUrl}/api/local-session`);
    expect(bootstrap.status).toBe(200);
    const { operationToken } = await bootstrap.json();
    const cookie = bootstrap.headers.get('Set-Cookie')!.split(';')[0];
    const headers = {
      Cookie: cookie,
      Origin: runtime.baseUrl,
      'Content-Type': 'application/json',
      'X-Interview-Token': operationToken,
    };
    const analysisRequest = () =>
      fetch(`${runtime.baseUrl}/api/materials/analyze`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ confirmed: true, markdown: '架空の経験' }),
      });
    const analyzed = await analysisRequest();
    expect(analyzed.status).toBe(200);
    const { analysisId } = await analyzed.json();
    const results = await Promise.all(Array.from({ length: 11 }, analysisRequest));
    expect(results.filter((response) => response.status === 200)).toHaveLength(9);
    expect(results.filter((response) => response.status === 429)).toHaveLength(2);
    await runDatabaseCommand(config, [
      'execute',
      `CREATE TEMP TABLE assertion (value INTEGER CHECK (value = 10)); INSERT INTO assertion SELECT COUNT(*) FROM usage_reservations WHERE kind='analysis';`,
    ]);
    const body = JSON.stringify({
      interviewId: 'formal-one',
      analysisId,
      themeIndex: 0,
      background: '',
    });
    const created = await fetch(`${runtime.baseUrl}/api/interviews`, {
      method: 'POST',
      headers,
      body,
    });
    expect(created.status).toBe(200);
    expect(await created.json()).toMatchObject({ interviewId: 'formal-one', status: 'ready' });
    const history = await fetch(`${runtime.baseUrl}/api/interview-history`, {
      headers: { Cookie: cookie },
    });
    expect(history.status).toBe(200);
    expect(await history.json()).toMatchObject({
      items: [{ interviewId: 'formal-one' }],
      next: null,
    });
    const detail = await fetch(`${runtime.baseUrl}/api/interviews/formal-one`, {
      headers: { Cookie: cookie },
    });
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      session: { interviewId: 'formal-one' },
      material: { excerpt: '架空の経験' },
      transcripts: [],
      evaluation: null,
    });
    const denied = await fetch(`${runtime.baseUrl}/api/interviews`, {
      method: 'POST',
      headers: { ...headers, Origin: 'https://external.example' },
      body,
    });
    expect(denied.status).toBe(403);
    expect(
      (
        await fetch(`${runtime.baseUrl}/api/interviews/formal-one/live`, {
          headers: { Cookie: cookie },
        })
      ).status,
    ).toBe(403);
  } finally {
    await runtime.stop();
  }

  await rm(dirname(config.stateDirectory!), { recursive: true, force: true });
}, 90000);

test('架空のAIキーは3 Workersに届き、生成設定・キャッシュ・ログ・状態に保存されない', async () => {
  const config = resolveRuntime({
    repositoryRoot: root,
    appEnv: 'test',
    runId: randomUUID(),
    parallelIndex: 0,
  });
  const key = `fixture-${randomUUID()}`;
  const runtime = await startRuntime(config, 'dev', {
    testAiBindings: {
      OPENAI_API_KEY: key,
      MATERIAL_MODEL: 'fixture-model',
      RESPONSES_MODEL: 'fixture-reasoning',
      EVALUATION_MODEL: 'fixture-evaluation',
      LIVE_VOICE: 'marin',
    },
  });
  try {
    const digest = createHash('sha256').update(key).digest('hex');
    const response = await fetch(`${runtime.baseUrl}/api/ai-binding-test?digest=${digest}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      web: { matches: true, models: ['MATERIAL_MODEL'] },
      interview: { matches: true, models: ['RESPONSES_MODEL', 'EVALUATION_MODEL', 'LIVE_VOICE'] },
      evaluation: { matches: true, models: [] },
    });
  } finally {
    await runtime.stop();
  }
  const directory = dirname(config.stateDirectory!);
  async function scan(path: string): Promise<void> {
    for (const file of await readdir(path, { withFileTypes: true })) {
      const name = join(path, file.name);
      if (file.isDirectory()) {
        await scan(name);
      } else if (file.isFile()) {
        expect(
          (await readFile(name)).includes(key),
          `架空キーがファイルに残っています: ${name}`,
        ).toBe(false);
      }
    }
  }
  await scan(directory);
  vi.stubEnv('OPENAI_API_KEY', key);
  try {
    await buildRuntime(config);
  } finally {
    vi.unstubAllEnvs();
  }
  await scan(directory);
  await rm(directory, { recursive: true, force: true });
}, 90000);
