import { appendFileSync } from 'node:fs';
import { REPOSITORY } from './policy.ts';

interface OidcClaims {
  iss: string;
  aud: string;
  repository: string;
  repository_id: string;
  repository_owner_id: string;
  ref: string;
  workflow_ref: string;
  event_name: string;
  sub?: string;
  iat?: number;
  exp?: number;
}
type Settings = Record<string, string | undefined>;
export async function authenticate(
  env: Settings,
  mode: string,
  request: typeof fetch = fetch,
  mask: (secret: string) => void = () => {},
): Promise<{ claims: Partial<OidcClaims> }> {
  if (mode !== 'claims') throw new Error('WIFモードが不正です');
  const required = [
    'ACTIONS_ID_TOKEN_REQUEST_URL',
    'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
    'OPENAI_WIF_AUDIENCE',
  ];
  if (required.some((key) => !env[key])) throw new Error('WIF設定が不足しています');
  const url = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL!);
  if (url.protocol !== 'https:') throw new Error('OIDC URLが不正です');
  url.searchParams.set('audience', env.OPENAI_WIF_AUDIENCE!);
  const oidc = await request(url, {
    headers: { Authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
    signal: AbortSignal.timeout(15_000),
    redirect: 'error',
  });
  if (!oidc.ok) throw new Error(`OIDC HTTP ${oidc.status}`);
  const token = ((await oidc.json()) as { value?: string }).value;
  if (typeof token !== 'string' || token.split('.').length !== 3)
    throw new Error('OIDC応答が不正です');
  mask(token);
  const claims = JSON.parse(
    Buffer.from(token.split('.')[1], 'base64url').toString('utf8'),
  ) as OidcClaims;
  const expected = {
    iss: 'https://token.actions.githubusercontent.com',
    aud: env.OPENAI_WIF_AUDIENCE,
    repository: REPOSITORY,
    repository_id: '1426899426',
    repository_owner_id: '1324680',
    ref: 'refs/heads/main',
    workflow_ref: `${REPOSITORY}/.github/workflows/ai-review.yml@refs/heads/main`,
    event_name: 'workflow_run',
  };
  for (const [key, value] of Object.entries(expected) as [keyof typeof expected, string][]) {
    if (claims[key] !== value) throw new Error(`OIDCクレーム不一致: ${key}`);
  }
  const selected = Object.fromEntries(
    ([...Object.keys(expected), 'sub', 'iat', 'exp'] as (keyof OidcClaims)[]).map((key) => [
      key,
      claims[key],
    ]),
  );
  // ローカルのdecodeは署名検証ではない。交換時にOpenAIが署名とマッピングを検証する。
  return { claims: selected };
}

if (import.meta.main) {
  try {
    const result = await authenticate(
      process.env,
      process.env.AI_REVIEW_MODE ?? '',
      fetch,
      (secret) => {
        const escaped = secret
          .replaceAll('%', '%25')
          .replaceAll('\r', '%0D')
          .replaceAll('\n', '%0A');
        console.log(`::add-mask::${escaped}`);
      },
    );
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY!,
      `### OIDCクレーム（秘密値なし）\n\n\x60\x60\x60json\n${JSON.stringify(result.claims, null, 2)}\n\x60\x60\x60\n`,
    );
  } catch (error) {
    // fetch由来の例外や外部応答本文は出さない。
    const message =
      error instanceof Error && /^(WIF|OIDC)/.test(error.message)
        ? error.message
        : 'WIF処理に失敗しました';
    console.error(message);
    process.exitCode = 1;
  }
}
