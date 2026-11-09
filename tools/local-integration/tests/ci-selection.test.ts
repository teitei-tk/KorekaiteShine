import { expect, test } from 'vitest';
import { requiresRealtimeTests } from '../src/ci-selection.ts';

test('文書以外の変更と変更一覧の取得不能では長時間検査を実行する', () => {
  expect(requiresRealtimeTests(null)).toBe(true);
  expect(requiresRealtimeTests([])).toBe(false);
  expect(requiresRealtimeTests(['docs/spec/mvp.md', 'README.md'])).toBe(false);
  for (const path of [
    'apps/web/src/api.ts',
    'packages/database/migrations/001.sql',
    'tools/local-integration/tests/a.test.ts',
    '.github/workflows/ci.yml',
    'package.json',
    'tools/docs/package.json',
    'pnpm-lock.yaml',
    '.node-version',
    'pnpm-workspace.yaml',
    'new-tool/file.ts',
  ]) {
    expect(requiresRealtimeTests([path])).toBe(true);
  }
  expect(
    requiresRealtimeTests([
      ...Array.from({ length: 301 }, (_, i) => `docs/${i}.md`),
      'apps/deleted.ts',
    ]),
  ).toBe(true);
  expect(requiresRealtimeTests(['packages/old.ts', 'docs/new.md'])).toBe(true);
  expect(requiresRealtimeTests(['tools/local-integration/README.md'])).toBe(false);
});

test('長時間検査の対象外と成功だけを正常終了にし、失敗・中断・判定不能を残す', async () => {
  const { realtimeExitCode } = await import('../src/ci-selection.ts');
  expect(realtimeExitCode(false, 'skipped')).toBe(0);
  expect(realtimeExitCode(true, 'success')).toBe(0);
  for (const result of ['failure', 'cancelled', 'skipped', '']) {
    expect(realtimeExitCode(true, result)).toBe(1);
  }
  expect(realtimeExitCode(null, 'skipped')).toBe(1);
});

test('実git差分で文書だけを省略し、削除と移動・比較不能では検査する', async () => {
  const { mkdtempSync, writeFileSync, rmSync, renameSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { execFileSync } = await import('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'ci-selection-'));
  // Gitフックが設定するGIT_DIR等を、一時リポジトリへ持ち込まない。
  const fixtureEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: dir,
      env: fixtureEnv,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  const commit = () => {
    git('add', '.');
    git(
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      'fixture',
    );
    return git('rev-parse', 'HEAD');
  };
  try {
    git('init', '-q');
    writeFileSync(join(dir, 'code.ts'), 'export {};');
    const base = commit();
    writeFileSync(join(dir, 'README.md'), '# test');
    const docs = commit();
    const detect = (baseSha: string, headSha: string, event = 'pull_request') =>
      execFileSync(
        process.execPath,
        [fileURLToPath(new URL('../src/ci-selection.ts', import.meta.url))],
        {
          cwd: dir,
          env: { ...fixtureEnv, EVENT_NAME: event, BASE_SHA: baseSha, HEAD_SHA: headSha },
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      ).trim();
    expect(detect(base, docs)).toBe('required=false');
    renameSync(join(dir, 'code.ts'), join(dir, 'code.md'));
    const moved = commit();
    expect(detect(docs, moved)).toBe('required=true');
    expect(detect('0'.repeat(40), moved)).toBe('required=true');
    expect(detect(base, docs, 'schedule')).toBe('required=true');
    expect(detect(base, docs, 'workflow_dispatch')).toBe('required=true');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // Worker境界テストと並列に複数の実Git・Nodeプロセスを起動するため、I/O待ちを許容する。
}, 30_000);

test('長時間検査SummaryはPR headと実行commitを区別する', async () => {
  const { execFileSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const output = execFileSync(
    process.execPath,
    [fileURLToPath(new URL('../src/ci-selection.ts', import.meta.url)), 'result'],
    {
      env: {
        ...process.env,
        DETECTION_RESULT: 'success',
        REQUIRED: 'true',
        TEST_RESULT: 'success',
        HEAD_SHA: 'a'.repeat(40),
        GITHUB_SHA: 'b'.repeat(40),
        GITHUB_STEP_SUMMARY: '',
      },
      encoding: 'utf8',
    },
  );
  expect(output).toContain(`PR head: ${'a'.repeat(40)}`);
  expect(output).toContain(`実行commit: ${'b'.repeat(40)}`);
});

test('PR比較のSHAが欠落・不正なら長時間検査を省略しない', async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('../src/ci-selection.ts', import.meta.url))],
    {
      encoding: 'utf8',
      env: { ...process.env, EVENT_NAME: 'pull_request', BASE_SHA: undefined, HEAD_SHA: undefined },
    },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('required=true');
});

test('対象外・判定失敗・不正な判定結果を終了コードとSummaryへ反映する', async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'ci-summary-'));
  try {
    for (const [detection, required, result, code] of [
      ['success', 'false', 'skipped', 0],
      ['failure', undefined, undefined, 1],
      ['success', 'invalid', undefined, 1],
    ] as const) {
      const summary = join(root, 'summary.md');
      const child = spawnSync(
        process.execPath,
        [fileURLToPath(new URL('../src/ci-selection.ts', import.meta.url)), 'result'],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            DETECTION_RESULT: detection,
            REQUIRED: required,
            TEST_RESULT: result,
            HEAD_SHA: undefined,
            GITHUB_SHA: undefined,
            GITHUB_STEP_SUMMARY: summary,
          },
        },
      );
      expect(child.status, child.stderr).toBe(code);
      expect(child.stdout).toContain(code === 0 ? '対象外（文書のみ' : '結果なし');
      expect(readFileSync(summary, 'utf8')).toContain(child.stdout.trim());
      expect(child.stdout).toContain('実行commit: 不明');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('変更判定CLIの未知の引数を正常終了にしない', async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const child = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('../src/ci-selection.ts', import.meta.url)), 'invalid'],
    { encoding: 'utf8' },
  );
  expect(child.status).toBe(1);
  expect(child.stderr).toContain('引数が不明');
});
