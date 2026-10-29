import { expect, it } from 'vitest';
import { authenticate } from './wif.ts';
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
  let calls = 0;
  const request = (async () => {
    calls++;
    return Response.json({ value: jwt('other/repo') });
  }) as typeof fetch;
  await expect(authenticate(env, 'claims', request, () => {})).rejects.toThrow();
  expect(calls).toBe(1);
});
it('エラー本文の秘密値を例外に含めない', async () => {
  const request = (async () => new Response('secret-value', { status: 403 })) as typeof fetch;
  await expect(authenticate(env, 'claims', request, () => {})).rejects.toThrow('HTTP 403');
});
it('廃止した独自交換モードでは通信を始めない', async () => {
  let calls = 0;
  const request = (async () => {
    calls++;
    return Response.json({ value: jwt() });
  }) as typeof fetch;
  await expect(authenticate(env, 'review', request)).rejects.toThrow('WIFモードが不正');
  expect(calls).toBe(0);
});
