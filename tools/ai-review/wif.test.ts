import { afterEach, expect, it, vi } from 'vitest';
import { authenticate } from './wif.ts';
afterEach(() => vi.unstubAllGlobals());

it('HTTPのOIDC取得先へ要求トークンを送信しない', async () => {
  const request = vi.fn<typeof fetch>();
  await expect(
    authenticate(
      { ...env, ACTIONS_ID_TOKEN_REQUEST_URL: 'http://oidc.invalid' },
      'claims',
      request,
    ),
  ).rejects.toThrow('OIDC URLが不正');
  expect(request).not.toHaveBeenCalled();
});

it('OIDC設定が欠けていれば要求しない', async () => {
  const request = vi.fn<typeof fetch>();
  await expect(
    authenticate({ ...env, OPENAI_WIF_AUDIENCE: undefined }, 'claims', request),
  ).rejects.toThrow('WIF設定が不足');
  expect(request).not.toHaveBeenCalled();
});

it('既定fetchでも不正なOIDC応答をクレームとして受け付けない', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ value: 'not-a-jwt' })));
  await expect(authenticate(env, 'claims')).rejects.toThrow('OIDC応答が不正');
});
const env = {
  ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example.test/token?x=1',
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'github-secret',
  OPENAI_WIF_AUDIENCE: 'https://api.openai.com/v1',
  OPENAI_IDENTITY_PROVIDER_ID: 'idp-test',
  OPENAI_SERVICE_ACCOUNT_ID: 'sa-test',
};
function jwt(repository = 'teitei-tk/KorekaiteShine') {
  return (
    'header.' +
    Buffer.from(
      JSON.stringify({
        iss: 'https://token.actions.githubusercontent.com',
        aud: env.OPENAI_WIF_AUDIENCE,
        repository,
        repository_id: '1426899426',
        repository_owner_id: '1324680',
        ref: 'refs/heads/main',
        event_name: 'workflow_run',
        workflow_ref: 'teitei-tk/KorekaiteShine/.github/workflows/ai-review.yml@refs/heads/main',
        sub: 'test',
      }),
    ).toString('base64url') +
    '.signature'
  );
}

it('任意のマスク通知を省略しても選別したクレームだけを返す', async () => {
  const request = (async () => Response.json({ value: jwt() })) as typeof fetch;
  const result = await authenticate(env, 'claims', request);
  expect(result.claims.repository).toBe('teitei-tk/KorekaiteShine');
  expect(result).not.toHaveProperty('token');
});
it('クレーム確認だけではOpenAIへ通信しない', async () => {
  const urls: string[] = [];
  const request = (async (url: string | URL | Request) => {
    urls.push(String(url));
    return Response.json({ value: jwt() });
  }) as typeof fetch;
  const result = await authenticate(env, 'claims', request, () => {});
  expect(urls.length).toBe(1);
  expect('accessToken' in result).toBe(false);
});
it('想定外のリポジトリのトークンは交換しない', async () => {
  const callsState = { calls: 0 };
  const request = (async () => {
    callsState.calls++;
    return Response.json({ value: jwt('other/repo') });
  }) as typeof fetch;
  await expect(authenticate(env, 'claims', request, () => {})).rejects.toThrow();
  expect(callsState.calls).toBe(1);
});
it('エラー本文の秘密値を例外に含めない', async () => {
  const request = (async () => new Response('secret-value', { status: 403 })) as typeof fetch;
  await expect(authenticate(env, 'claims', request, () => {})).rejects.toThrow('HTTP 403');
});
it('廃止した独自交換モードでは通信を始めない', async () => {
  const callsState = { calls: 0 };
  const request = (async () => {
    callsState.calls++;
    return Response.json({ value: jwt() });
  }) as typeof fetch;
  await expect(authenticate(env, 'review', request)).rejects.toThrow('WIFモードが不正');
  expect(callsState.calls).toBe(0);
});
