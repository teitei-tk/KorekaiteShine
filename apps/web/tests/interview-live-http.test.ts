import { expect, test, vi } from 'vitest';
import { interviewLiveRequest } from '../src/server/interview-live';

test('認可した本人と面接IDで内部ヘッダーを上書きし、面接DOへ接続する', async () => {
  const fetch = vi.fn(
    async (request: Request) => new Response(request.headers.get('X-Interview-Actor')),
  );
  const getByName = vi.fn(() => ({ fetch }));
  const request = new Request('http://localhost/api/interviews/one/live', {
    headers: { Upgrade: 'websocket', 'X-Interview-Actor': 'forged', 'X-Interview-ID': 'other' },
  });
  const deps = { environment: 'test', actor: () => 'actor', sessions: { getByName } };
  expect((await interviewLiveRequest(request, 'one', deps)).status).toBe(200);
  expect(getByName).toHaveBeenCalledWith('test:interview:one');
  expect(fetch.mock.calls[0][0].headers.get('X-Interview-Actor')).toBe('actor');
  expect(fetch.mock.calls[0][0].headers.get('X-Interview-ID')).toBe('one');
  getByName.mockClear();
  expect((await interviewLiveRequest(request, 'one', { ...deps, actor: () => null })).status).toBe(
    403,
  );
  expect((await interviewLiveRequest(request, '../one', deps)).status).toBe(400);
  expect(getByName).not.toHaveBeenCalled();
  fetch.mockRejectedValueOnce(new Error('private failure'));
  const failure = await interviewLiveRequest(request, 'one', deps);
  expect(failure.status).toBe(503);
  expect(await failure.text()).not.toContain('private');
});
