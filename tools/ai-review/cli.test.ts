import { expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cliFixture, unprivilegedLinux } from './tests/helpers/cli.ts';
import { apiFixture } from './tests/helpers/api.ts';
import { artifactFixture } from './tests/helpers/artifact.ts';
import { saveArtifact } from './artifact.ts';
import { MARKER } from './policy.ts';
import { historyMarker } from './history.ts';
import { wifCliBootstrap } from './tests/helpers/wif-cli.ts';

it.each([
  ['非特権ユーザー', unprivilegedLinux],
  ['OIDCトークン欠落', wifCliBootstrap],
])('隔離WIF CLIは%sで通信せず固定理由を返す', (_reason, bootstrap) => {
  const fixture = cliFixture();
  const result = fixture.run('isolation/wif.ts', {
    bootstrap,
    env: { ACTIONS_ID_TOKEN_REQUEST_TOKEN: undefined },
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('WIF authentication-only verification failed');
  expect(fixture.requests()).toEqual([]);
});

it('隔離WIF CLIはクレーム・初期交換・隔離・公式終了を順に完了する', () => {
  const fixture = cliFixture();
  const input = wifInput(fixture.directory);
  const result = fixture.run('isolation/wif.ts', {
    ...input,
    env: {
      ...input.env,
      OPENAI_IDENTITY_PROVIDER_ID: 'idp_fixture',
      OPENAI_SERVICE_ACCOUNT_ID: 'account-fixture',
    },
    bootstrap: wifCliBootstrap,
  });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('WIF exact claims: passed');
  expect(result.stdout).toContain(
    'WIF initial exchange, credential isolation and official shutdown: passed',
  );
  expect(result.stderr).not.toContain('failed');
});

it('runtimeのCLIは準備成功時に正常終了する', () => {
  const fixture = cliFixture();
  const metadata = JSON.stringify(artifactFixture().metadata);
  const result = fixture.run('runtime.ts', {
    args: ['setup', '/fixture', '/workspace'],
    bootstrap: `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
Object.defineProperty(process, 'platform', { value: 'linux' });
process.getuid = () => 0;
const managed = (path) => typeof path === 'string' && (path.startsWith('/opt/ai-review') || path.startsWith('/home/ai-review'));
const read = fs.readFileSync;
fs.readFileSync = (path, ...args) => path === '/fixture/metadata.json' ? ${JSON.stringify(metadata)} : read(path, ...args);
for (const name of ['mkdirSync', 'chmodSync', 'chownSync', 'writeFileSync']) {
  const original = fs[name]; fs[name] = (path, ...args) => managed(path) ? undefined : original(path, ...args);
}
const copy = fs.cpSync; fs.cpSync = (from, to, ...args) => managed(to) ? undefined : copy(from, to, ...args);
const stat = fs.lstatSync; fs.lstatSync = (path, ...args) => managed(path) ? { uid: 0, mode: 0o644, isSymbolicLink: () => false, isDirectory: () => false } : stat(path, ...args);
syncBuiltinESMExports();
`,
  });
  expect(result.status).toBe(0);
  expect(result.stderr).not.toContain('公式レビュー未完了');
  expect(fixture.requests()).toEqual([]);
});

it('runtimeの元ソースCLIは不正操作を固定診断で拒否する', () => {
  const fixture = cliFixture();
  const result = fixture.run('runtime.ts', { args: ['invalid'] });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('公式レビュー未完了: runtime/preflight。');
  expect(result.stderr).not.toContain('ERR_MODULE_NOT_FOUND');
});

it('監視CLIは未知の操作とArtifact取得失敗を成功扱いしない', () => {
  const fixture = cliFixture();
  const { api, env } = monitorFixture(fixture.directory);
  const invalid = fixture.run('wait-review.ts', { args: ['invalid'], env, replies: api });
  expect(invalid.status).toBe(1);
  expect(invalid.stderr).toContain('EXECUTION_FAILED (monitor)');
  const missing = fixture.run('wait-review.ts', {
    args: ['finish'],
    env: { ...env, REVIEW_REPORT_DOWNLOAD: 'failure' },
    replies: api,
  });
  expect(missing.status).toBe(1);
  expect(missing.stderr).toContain('REPORT_MISSING (artifact)');
});
it('監視CLIは認証や対象が欠けていても固定理由で終了する', () => {
  const fixture = cliFixture();
  for (const args of [[], ['wait']]) {
    const result = fixture.run('wait-review.ts', {
      args,
      env: {
        GH_TOKEN: args.length ? 'fixture-token' : undefined,
        REVIEW_HEAD: undefined,
        REVIEW_BASE: undefined,
        REVIEW_SINCE: undefined,
        GITHUB_STEP_SUMMARY: undefined,
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('EXECUTION_FAILED (monitor)');
  }
  expect(fixture.requests()).toEqual([]);
});
it('監視CLIは出力先がなければ完了IDを黙って捨てない', () => {
  const fixture = cliFixture();
  const { api, env } = monitorFixture(fixture.directory);
  const result = fixture.run('wait-review.ts', {
    args: ['wait'],
    env: { ...env, GITHUB_OUTPUT: undefined },
    replies: api,
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('EXECUTION_FAILED (monitor)');
});
it('監視CLIは予算通知済みをレビュー完了と区別して表示する', () => {
  const fixture = cliFixture();
  const { api, env } = monitorFixture(fixture.directory);
  writeFileSync(
    join(fixture.directory, 'status.json'),
    JSON.stringify({
      version: 1,
      run: '20',
      attempt: '1',
      job: 'publish',
      status: 'success',
      target: 'publish',
      reason: 'BUDGET_NOTIFIED',
      commentId: 99,
    }),
  );
  const result = fixture.run('wait-review.ts', { args: ['finish'], env, replies: api });
  expect(result.status).toBe(0);
  expect(readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8')).toContain(
    '予算不足・レビュー未完了・[PR通知済み]',
  );
});
it('監視CLIは診断付きの失敗理由を概要と終了コードへ反映する', () => {
  const fixture = cliFixture();
  const { api, env } = monitorFixture(fixture.directory);
  writeFileSync(
    join(fixture.directory, 'status.json'),
    JSON.stringify({
      version: 1,
      run: '20',
      attempt: '1',
      job: 'generate',
      status: 'failure',
      target: 'generate',
      reason: 'OUTPUT_INVALID',
      diagnostic: { subcode: 'CHECK_TARGET_MISMATCH', missing: [] },
    }),
  );
  const result = fixture.run('wait-review.ts', { args: ['finish'], env, replies: api });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('OUTPUT_INVALID/CHECK_TARGET_MISMATCH');
  expect(readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8')).toContain('CHECK_TARGET_MISMATCH');
});
it('監視CLIは完了Artifactを検証してレビュー完了を表示する', () => {
  const fixture = cliFixture();
  const { api, env } = monitorFixture(fixture.directory);
  writeFileSync(
    join(fixture.directory, 'status.json'),
    JSON.stringify({
      version: 1,
      run: '20',
      attempt: '1',
      job: 'publish',
      status: 'success',
      target: 'publish',
      reason: 'REVIEW_COMPLETE',
    }),
  );
  const result = fixture.run('wait-review.ts', { args: ['finish'], env, replies: api });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('REVIEW_COMPLETE');
  expect(readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8')).toContain('/actions/runs/20/attempts/1');
});
it('監視CLIは対象変更を失敗として概要へ残す', () => {
  const fixture = cliFixture();
  const { api, env } = monitorFixture(fixture.directory);
  api.pr.state = 'closed';
  const result = fixture.run('wait-review.ts', { args: ['wait'], env, replies: api });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('TARGET_CHANGED');
  expect(readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8')).toContain('TARGET_CHANGED');
});

function monitorFixture(directory: string) {
  const { api, env } = notificationFixture(directory);
  const source = {
    ...api.run,
    id: 1,
    run_attempt: 1,
    status: 'completed',
    created_at: '2026-11-08T00:00:01Z',
  };
  const review = { ...api.http[api.prefix + 'actions/runs/20'].body, conclusion: 'success' };
  api.http[api.prefix + 'actions/runs?event=pull_request&per_page=100&page=1'] = {
    body: { workflow_runs: [source] },
  };
  api.http[
    api.prefix + 'actions/workflows/ai-review.yml/runs?event=workflow_run&per_page=100&page=1'
  ] = { body: { workflow_runs: [review] } };
  api.http[api.prefix + 'actions/runs/20/attempts/1'] = { body: review };
  return {
    api,
    env: {
      ...env,
      REVIEW_PR: '7',
      REVIEW_HEAD: api.pr.head.sha,
      REVIEW_BASE: api.pr.base.sha,
      REVIEW_SINCE: '2026-11-08T00:00:00Z',
      REVIEW_REPORT_DOWNLOAD: 'success',
      REVIEW_REPORT_DIRECTORY: directory,
    },
  };
}

it('監視CLIは一致した完了実行のIDを後続ジョブへ渡す', () => {
  const fixture = cliFixture();
  const { api, env } = monitorFixture(fixture.directory);
  expect(fixture.run('wait-review.ts', { args: ['wait'], env, replies: api }).status).toBe(0);
  expect(readFileSync(env.GITHUB_OUTPUT, 'utf8')).toBe('run=20\nattempt=1\n');
});

it('通知CLIはサマリー未設定でも終了し、認証未設定ではAPIを呼ばない', () => {
  const fixture = cliFixture();
  const { api, env } = notificationFixture(fixture.directory);
  api.pr.state = 'closed';
  expect(
    fixture.run('failure-notify.ts', {
      args: ['publish'],
      env: { ...env, GITHUB_STEP_SUMMARY: undefined },
      replies: api,
    }).status,
  ).toBe(0);
  const unauthenticated = cliFixture();
  const result = unauthenticated.run('failure-notify.ts', {
    args: ['prepare'],
    env: { ...env, GH_TOKEN: undefined },
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('FAILURE_NOTIFICATION_FAILED');
  expect(unauthenticated.requests()).toEqual([]);
});
it('失敗通知CLIは操作や出力先が不正なら固定エラーで終了する', () => {
  const fixture = cliFixture();
  const { api, env } = notificationFixture(fixture.directory);
  for (const args of [[], ['prepare']]) {
    const result = fixture.run('failure-notify.ts', {
      args,
      env: { ...env, GITHUB_OUTPUT: undefined },
      replies: api,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('FAILURE_NOTIFICATION_FAILED');
    expect(result.stderr).not.toContain('fixture-token');
  }
});
it('失敗通知CLIは対象外なら許可せず通知不要の概要を残す', () => {
  const fixture = cliFixture();
  const { api, env } = notificationFixture(fixture.directory);
  api.pr.state = 'closed';
  expect(fixture.run('failure-notify.ts', { args: ['prepare'], env, replies: api }).status).toBe(0);
  expect(readFileSync(env.GITHUB_OUTPUT, 'utf8')).toBe('allowed=false\n');
  expect(fixture.run('failure-notify.ts', { args: ['publish'], env, replies: api }).status).toBe(0);
  expect(readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8')).toContain('通知不要');
});
it('失敗通知CLIは通知IDを概要へ保存する', () => {
  const fixture = cliFixture();
  const { api, env } = notificationFixture(fixture.directory);
  const result = fixture.run('failure-notify.ts', {
    args: ['publish'],
    env: { ...env, REVIEW_REPORT_DOWNLOAD: 'success', REVIEW_REPORT_DIRECTORY: fixture.directory },
    replies: api,
  });
  expect(result.status).toBe(0);
  expect(readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8')).toContain('comment ID: 100');
  expect(fixture.requests().filter((r) => r.method === 'POST')).toHaveLength(1);
});

function notificationFixture(directory: string) {
  const api = apiFixture();
  api.http[api.prefix + 'actions/runs/1'] = { body: { ...api.run, id: 1, run_attempt: 1 } };
  api.http[api.prefix + 'actions/runs/20'] = {
    body: {
      ...api.run,
      id: 20,
      run_attempt: 1,
      event: 'workflow_run',
      path: '.github/workflows/ai-review.yml',
      head_branch: 'main',
      display_title: 'AI review / source run 1 attempt 1 / review',
      status: 'completed',
      conclusion: 'failure',
    },
  };
  api.http[api.prefix + 'actions/runs/20/attempts/1/jobs?per_page=100'] = {
    body: { jobs: [{ name: 'generate', conclusion: 'failure' }] },
  };
  api.http[api.prefix + 'issues/7/comments'] = { body: { id: 100 } };
  return {
    api,
    env: {
      GH_TOKEN: 'fixture-token',
      REVIEW_RUN_ID: '20',
      REVIEW_RUN_ATTEMPT: '1',
      GITHUB_OUTPUT: join(directory, 'output'),
      GITHUB_STEP_SUMMARY: join(directory, 'summary'),
    },
  };
}

it('失敗通知CLIの準備は検証済み対象だけを許可する', () => {
  const fixture = cliFixture();
  const { api, env } = notificationFixture(fixture.directory);
  const result = fixture.run('failure-notify.ts', { args: ['prepare'], env, replies: api });
  expect(result.status).toBe(0);
  expect(readFileSync(env.GITHUB_OUTPUT, 'utf8')).toBe('allowed=true\n');
});

it('概要と出力の保存先がなくても準備失敗の固定理由を返す', () => {
  const fixture = cliFixture();
  const env = {
    ...reviewEnvironment(fixture.directory),
    GH_TOKEN: undefined,
    GITHUB_OUTPUT: undefined,
    GITHUB_STEP_SUMMARY: undefined,
  };
  const result = fixture.run('prepare.ts', { env });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('AUTH_FAILED');
  expect(result.stderr).not.toContain('記録に失敗');
});

it('現在の対象へ行指摘が途中投稿されていれば新しい生成を許可しない', () => {
  const fixture = cliFixture();
  const api = apiFixture();
  api.http[api.prefix + 'pulls/7/comments?per_page=100&page=1'] = {
    body: [
      {
        id: 2,
        user: { login: 'github-actions[bot]', type: 'Bot' },
        path: 'a.ts',
        line: 1,
        original_line: 1,
        commit_id: api.pr.head.sha,
        original_commit_id: api.pr.head.sha,
        body: `${MARKER}\n<!-- revision:${api.pr.head.sha}:${api.pr.base.sha} -->\n${historyMarker([{ priority: 'P2', path: 'a.ts', line: 1, condition: 'condition', impact: 'impact', fix: 'fix' }])}`,
      },
    ],
  };
  api.http['https://api.github.com/graphql'] = {
    body: {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [{ id: 'T2', isResolved: false, comments: { nodes: [{ databaseId: 2 }] } }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    },
  };
  const result = fixture.run('prepare.ts', {
    args: ['collect'],
    env: reviewEnvironment(fixture.directory),
    replies: api,
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('HISTORY_FAILED');
});

it('投稿CLIはサマリー保存先を省略しても対象変更を正常に処理する', () => {
  const fixture = cliFixture();
  const { env } = publication(fixture.directory);
  const api = apiFixture();
  api.pr.state = 'closed';
  const result = fixture.run('publish.ts', {
    env: { ...env, GITHUB_STEP_SUMMARY: undefined },
    replies: api,
  });
  expect(result.status).toBe(0);
});

it('投稿CLIは認証がなければ固定の失敗通知を保存する', () => {
  const fixture = cliFixture();
  const { env } = publication(fixture.directory);
  const result = fixture.run('publish.ts', { env: { ...env, GH_TOKEN: undefined } });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('投稿未完了');
  expect(fixture.requests()).toEqual([]);
});

it('投稿CLIの対象指定が成果物と違えばAPIを呼ばず失敗する', () => {
  const fixture = cliFixture();
  const { env } = publication(fixture.directory);
  const result = fixture.run('publish.ts', { env: { ...env, PR_NUMBER: '8' } });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('投稿未完了');
  expect(fixture.requests()).toEqual([]);
});

it('投稿CLIは対象PRが変わったら投稿せずneutralの結果を保存する', () => {
  const fixture = cliFixture();
  const { env } = publication(fixture.directory);
  const api = apiFixture();
  api.pr.state = 'closed';
  const result = fixture.run('publish.ts', { env, replies: api });
  expect(result.status).toBe(0);
  expect(readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8')).toContain('投稿結果: TARGET_CHANGED');
  expect(fixture.requests().filter((request) => request.method === 'POST')).toHaveLength(0);
});

function publication(directory: string) {
  const artifact = artifactFixture().create();
  const env = {
    ...reviewEnvironment(directory),
    AI_REVIEW_JOB: 'publish',
    GENERATION_ATTEMPT: artifact.origin.attempt,
    GITHUB_SHA: artifact.origin.sha,
    PR_NUMBER: String(artifact.metadata.number),
    PR_HEAD: artifact.metadata.head,
    PR_BASE: artifact.metadata.base,
  };
  mkdirSync(env.REVIEW_DIRECTORY);
  saveArtifact(env.REVIEW_DIRECTORY, artifact);
  return { artifact, env };
}

it('投稿CLIは検証済みの固定成果物だけを模擬APIへ渡し結果を記録する', () => {
  const fixture = cliFixture();
  const { env } = publication(fixture.directory);
  const api = apiFixture();
  api.http[api.prefix + 'issues/7/comments'] = { body: { id: 99 } };
  const result = fixture.run('publish.ts', { env, replies: api });
  expect(result.status).toBe(0);
  expect(readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8')).toContain('投稿結果: REVIEW_COMPLETE');
  expect(
    fixture
      .requests()
      .filter(
        (request) => request.method === 'POST' && request.url !== 'https://api.github.com/graphql',
      ),
  ).toHaveLength(1);
});

it('同じ対象への途中投稿があれば新しい資料生成を拒否する', () => {
  const fixture = cliFixture();
  const api = apiFixture();
  api.http[api.prefix + 'issues/7/comments?per_page=100&page=1'] = {
    body: [
      {
        id: 1,
        body:
          '<!-- korekaite-ai-review -->\n<!-- generation:v2:19:1:' +
          api.pr.head.sha +
          ':' +
          api.pr.base.sha +
          ' -->',
        user: { login: 'github-actions[bot]', type: 'Bot' },
      },
    ],
  };
  const result = fixture.run('prepare.ts', {
    args: ['collect'],
    env: reviewEnvironment(fixture.directory),
    replies: api,
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('HISTORY_FAILED');
  expect(fixture.requests().some((request) => request.git)).toBe(false);
});

it('準備でGit収集が失敗したら許可せずCOLLECTION_FAILEDを返す', () => {
  const fixture = cliFixture();
  const api = apiFixture();
  const env = reviewEnvironment(fixture.directory);
  const result = fixture.run('prepare.ts', { args: ['collect'], env, replies: { http: api.http } });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('COLLECTION_FAILED');
  expect(readFileSync(env.GITHUB_OUTPUT, 'utf8')).toBe('allowed=false\n');
  expect(result.stderr).not.toContain('private fixture');
});

it('資料ディレクトリが欠けた準備はINPUT_INVALIDで止める', () => {
  const fixture = cliFixture();
  const env = { ...reviewEnvironment(fixture.directory), REVIEW_DIRECTORY: undefined };
  const result = fixture.run('prepare.ts', { args: ['collect'], env, replies: apiFixture() });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('INPUT_INVALID');
});

it('準備CLIが失敗記録も保存できない場合は外部例外を表示しない', () => {
  const fixture = cliFixture();
  const env = {
    ...reviewEnvironment(fixture.directory),
    GH_TOKEN: undefined,
    RUNNER_TEMP: join(fixture.directory, 'requests.jsonl'),
  };
  const result = fixture.run('prepare.ts', { env });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('AIレビュー準備の記録に失敗しました。');
  expect(result.stderr).not.toContain('ENOTDIR');
});

it('準備CLIの認証不足は生成へ進まず固定分類を保存する', () => {
  const fixture = cliFixture();
  const env = { ...reviewEnvironment(fixture.directory), GH_TOKEN: undefined };
  const result = fixture.run('prepare.ts', { env });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('AUTH_FAILED');
  expect(readFileSync(env.GITHUB_OUTPUT, 'utf8')).toBe('allowed=false\n');
  expect(fixture.requests()).toEqual([]);
});

function reviewEnvironment(directory: string) {
  return {
    GH_TOKEN: 'fixture-token',
    SOURCE_RUN_ID: '1',
    AI_REVIEW_MODE: 'review',
    REVIEW_DIRECTORY: join(directory, 'review'),
    GITHUB_OUTPUT: join(directory, 'output'),
    GITHUB_STEP_SUMMARY: join(directory, 'summary'),
    RUNNER_TEMP: directory,
    GITHUB_RUN_ID: '20',
    GITHUB_RUN_ATTEMPT: '1',
    AI_REVIEW_JOB: 'gate',
  };
}

it('準備CLIは固定Git資料を保存した後にだけallowedを出力する', () => {
  const fixture = cliFixture();
  const api = apiFixture();
  const env = reviewEnvironment(fixture.directory);
  const result = fixture.run('prepare.ts', { args: ['collect'], env, replies: api });
  expect(result.status).toBe(0);
  expect(readFileSync(env.GITHUB_OUTPUT, 'utf8')).toContain('allowed=true');
  expect(
    JSON.parse(readFileSync(join(env.REVIEW_DIRECTORY, 'metadata.json'), 'utf8')),
  ).toMatchObject({ head: api.pr.head.sha, lines: { 'a.ts': [1] } });
});

it('WIF CLIの通信失敗は秘密を含む外部例外を定型文に置き換える', () => {
  const fixture = cliFixture();
  const { env } = wifInput(fixture.directory);
  const result = fixture.run('wif.ts', { env });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('WIF処理に失敗しました');
  expect(result.stderr).not.toContain('private fixture');
});

function wifInput(directory: string) {
  const claims = {
    iss: 'https://token.actions.githubusercontent.com',
    aud: 'https://api.openai.com/v1',
    repository: 'teitei-tk/KorekaiteShine',
    repository_id: '1426899426',
    repository_owner_id: '1324680',
    ref: 'refs/heads/main',
    event_name: 'workflow_run',
    workflow_ref: 'teitei-tk/KorekaiteShine/.github/workflows/ai-review.yml@refs/heads/main',
  };
  const token =
    'fixture%\r\n.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.signature';
  const env = {
    AI_REVIEW_MODE: 'claims',
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.invalid/request',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'fixture-request-token',
    OPENAI_WIF_AUDIENCE: claims.aud,
    GITHUB_STEP_SUMMARY: join(directory, 'summary.md'),
  };
  return { token, env, replies: { fetch: { body: { value: token } } } };
}

it('WIF CLIはマスク命令をエスケープしクレームだけをサマリーへ保存する', () => {
  const fixture = cliFixture();
  const input = wifInput(fixture.directory);
  const result = fixture.run('wif.ts', input);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('::add-mask::fixture%25%0D%0A.');
  const summary = readFileSync(input.env.GITHUB_STEP_SUMMARY, 'utf8');
  expect(summary).toContain('OIDCクレーム');
  expect(summary).not.toContain(input.token);
  expect(fixture.requests()).toHaveLength(1);
});

it('WIF CLIはモード未指定なら外部応答を要求しない', () => {
  const fixture = cliFixture();
  const result = fixture.run('wif.ts', { env: { AI_REVIEW_MODE: undefined } });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('WIFモードが不正');
  expect(fixture.requests()).toEqual([]);
});

it('実行状態CLIはコードSHAと成功状態を確認して終了する', () => {
  const fixture = cliFixture();
  const result = fixture.run('check-run.ts', {
    args: ['7'],
    replies: {
      'repos/teitei-tk/KorekaiteShine/actions/runs/7': {
        id: 7,
        head_sha: 'a'.repeat(40),
        event: 'push',
      },
      run: { status: 'completed', conclusion: 'success', jobs: [] },
    },
  });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('実行コードSHA: ' + 'a'.repeat(40));
  expect(result.stdout).toContain('completed / success');
  expect(fixture.requests()).toHaveLength(2);
});

it('実行状態CLIは引数不正ならGitHub照会せず使い方を返す', () => {
  const fixture = cliFixture();
  const result = fixture.run('check-run.ts');
  expect(result.status).toBe(2);
  expect(result.stdout).toContain('使い方');
  expect(fixture.requests()).toEqual([]);
});

it('設定確認CLIは固定形式の値だけを検査し期待値一致で成功する', () => {
  const fixture = cliFixture();
  const result = fixture.run('check-settings.ts', {
    env: { EXPECTED_AI_REVIEW_MODE: 'off' },
    replies: {
      variables: [
        { name: 'OPENAI_WIF_AUDIENCE', value: 'https://api.openai.com/v1' },
        { name: 'OPENAI_IDENTITY_PROVIDER_ID', value: 'idp_Fixture' },
        { name: 'OPENAI_SERVICE_ACCOUNT_ID', value: 'user-Fixture' },
        { name: 'AI_REVIEW_MODE', value: 'off' },
      ],
    },
  });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('AI_REVIEW_MODE: 一致');
  expect(result.stdout).not.toContain('idp_Fixture');
});

it('設定確認CLIの取得失敗は固定文だけを出して失敗終了する', () => {
  const fixture = cliFixture();
  const result = fixture.run('check-settings.ts');
  expect(result.status).toBe(1);
  expect(result.stdout).toContain('設定を取得・解析できませんでした');
  expect(result.stdout + result.stderr).not.toContain('private fixture failure');
  expect(fixture.requests()).toHaveLength(1);
});
