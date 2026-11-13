import { afterEach, expect, test, vi } from 'vitest';
import { createTestDatabase } from '../../../packages/database/testing/sqlite';
import { jobs } from '@korekaite/database/jobs';
import { interviews, evaluationInputs } from '@korekaite/database/interviews';
import { Route as session } from '../src/routes/api.local-session';
import { Route as listing } from '../src/routes/api.interviews';
import { Route as history } from '../src/routes/api.interview-history';
import { Route as detail } from '../src/routes/api.interviews.$interviewId';
import { Route as retry } from '../src/routes/api.interviews.$interviewId.retry';
import { Route as live } from '../src/routes/api.interviews.$interviewId.live';
import { Route as materials } from '../src/routes/api.materials.analyze';
import type { Bindings } from '../src/server/interview-runtime';

const { env } = vi.hoisted(() => ({ env: {} as Bindings }));
vi.mock('cloudflare:workers', () => ({ env }));
afterEach(() => vi.unstubAllGlobals());

interface ApiRoute {
  options: object;
}
function requestRoute(route: ApiRoute, method: string, path: string, options?: RequestInit) {
  const request = new Request('https://localhost' + path, { ...options, method });
  type Handler = (input: {
    request: Request;
    params: { interviewId: string };
  }) => Response | Promise<Response>;
  const { server } = route.options as { server: { handlers: Record<string, Handler> } };
  return server.handlers[method]({ request, params: { interviewId: 'one' } });
}

test('登録したHTTP入口で本人を認証し、DBと面接DOへ接続する', async () => {
  const data = createTestDatabase();
  const forward = vi.fn<Bindings['INTERVIEW_SESSION']['getByName']>();
  const deliver = vi.fn<typeof fetch>();
  forward.mockReturnValue({ fetch: deliver });
  env.APP_ENV = 'test';
  env.DB = data.binding;
  env.INTERVIEW_SESSION = { getByName: forward };
  const bootstrap = await requestRoute(session, 'GET', '/api/local-session');
  const { operationToken } = await bootstrap.json();
  const headers = {
    Cookie: bootstrap.headers.get('Set-Cookie')!.split(';')[0],
    Origin: 'https://localhost',
    'X-Interview-Token': operationToken,
    'Content-Type': 'application/json',
  };
  try {
    expect((await requestRoute(listing, 'GET', '/api/interviews')).status).toBe(200);
    expect((await requestRoute(history, 'GET', '/api/interview-history', { headers })).status).toBe(
      200,
    );
    expect((await requestRoute(detail, 'GET', '/api/interviews/one', { headers })).status).toBe(
      404,
    );
    expect((await requestRoute(listing, 'POST', '/api/interviews', { headers })).status).toBe(400);
    expect(
      (await requestRoute(retry, 'POST', '/api/interviews/one/retry', { headers })).status,
    ).toBe(400);
    const analyze = () =>
      requestRoute(materials, 'POST', '/api/materials/analyze', {
        headers,
        body: JSON.stringify({ confirmed: true, markdown: '架空の経験' }),
      });
    expect((await analyze()).status).toBe(503);
    env.OPENAI_API_KEY = 'fixture';
    env.MATERIAL_MODEL = 'fixture';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          status: 'completed',
          output: [
            {
              type: 'message',
              role: 'assistant',
              status: 'completed',
              content: [
                {
                  type: 'output_text',
                  text: JSON.stringify({
                    themes: [{ title: 'テーマ', heading: '本文', excerpt: '架空の経験' }],
                  }),
                },
              ],
            },
          ],
        }),
      ),
    );
    expect((await analyze()).status).toBe(200);
    deliver.mockResolvedValueOnce(new Response('connected'));
    const connection = await requestRoute(live, 'GET', '/api/interviews/one/live', {
      headers: { ...headers, Upgrade: 'websocket' },
    });
    expect(await connection.text()).toBe('connected');
    await data.db.insert(interviews).values({
      interviewId: 'one',
      actorId: 'local-developer',
      themeTitle: '判断',
      themeHeading: '本文',
      themeExcerpt: '経験',
      background: '',
      materialHash: 'hash',
      status: 'ended',
      createdAt: 1,
      updatedAt: 1,
    });
    const parent = crypto.randomUUID();
    await data.db.insert(jobs).values({
      jobId: parent,
      actorId: 'local-developer',
      purpose: 'evaluation',
      status: 'failed',
      acceptedAt: 1,
      updatedAt: 1,
    });
    await data.db.insert(evaluationInputs).values({
      jobId: parent,
      interviewId: 'one',
      kind: 'initial',
      lastSequence: 0,
      model: 'fixture',
      promptVersion: 'v1',
      rubricVersion: 'v1',
      createdAt: 1,
      inputJson: {
        schemaVersion: 1,
        interview: {
          interviewId: 'one',
          materialHash: 'hash',
          themeTitle: '判断',
          themeHeading: '本文',
          themeExcerpt: '経験',
          background: '',
          activeMs: 0,
        },
        evaluation: {
          model: 'fixture',
          promptVersion: 'v1',
          rubricVersion: 'v1',
          instructions: '指示',
          rubric: '基準',
        },
        fragments: [],
        playback: [],
        transcriptIncomplete: false,
      },
    });
    const accepted = await requestRoute(retry, 'POST', '/api/interviews/one/retry', {
      headers,
      body: JSON.stringify({ failedJobId: parent }),
    });
    expect(accepted.status).toBe(202);
    expect((await requestRoute(retry, 'POST', '/api/interviews/one/retry')).status).toBe(403);
    expect((await requestRoute(detail, 'DELETE', '/api/interviews/one')).status).toBe(403);
    deliver
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const remove = () => requestRoute(detail, 'DELETE', '/api/interviews/one', { headers });
    expect((await remove()).status).toBe(503);
    expect((await remove()).status).toBe(204);
    expect(forward.mock.lastCall).toEqual(['test:interview:one']);
    const removed = deliver.mock.lastCall![0] as Request;
    expect(removed.method).toBe('DELETE');
    expect(removed.headers.get('X-Interview-Actor')).toBe('local-developer');
    expect(removed.headers.get('X-Interview-ID')).toBe('one');
  } finally {
    data.close();
  }
});
