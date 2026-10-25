import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, onTestFinished, test } from 'vitest';
import { parse } from 'yaml';

// Workflowの実際のシェルを実行し、判定ロジックをテスト側へ複製しない。
const workflow: { jobs: { docs: { steps: { id?: string; run?: string }[] } } } = parse(
  await readFile(new URL('../../.github/workflows/docs.yml', import.meta.url), 'utf8'),
);
const script = (() => {
  const run = workflow.jobs.docs.steps.find((step) => step.id === 'changes')?.run;
  if (!run) throw new Error('文書の変更判定ステップが見つかりません');
  return run;
})();

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'korekaite-docs-changes-'));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'repo');
  await mkdir(root);
  // commitフックから実行されても、親リポジトリのindexや設定を変更しない。
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = '/dev/null';
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, env, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Documentation tests');
  git('config', 'user.email', 'docs-tests@example.invalid');
  git('config', 'core.hooksPath', '/dev/null');
  const write = async (file: string, content = 'content\n') => {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  };
  const commit = () => {
    git('add', '.');
    git('commit', '-qm', 'fixture');
    return git('rev-parse', 'HEAD');
  };
  await write('source.ts');
  await write('image.png');
  const base = commit();
  const detect = async (
    event: 'pull_request' | 'push',
    before = base,
    head = git('rev-parse', 'HEAD'),
  ) => {
    const output = path.join(directory, 'output');
    await writeFile(output, '');
    execFileSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', script], {
      cwd: root,
      env: {
        ...env,
        EVENT_NAME: event,
        BASE_SHA: before,
        HEAD_SHA: head,
        RUNNER_TEMP: directory,
        GITHUB_OUTPUT: output,
      },
      stdio: 'pipe',
    });
    return (await readFile(output, 'utf8')).trim();
  };
  return { root, git, write, commit, base, detect };
}

test.each(['pull_request', 'push'] as const)(
  '%s: コードだけの変更では検査を省略する',
  async (event) => {
    const f = await fixture();
    await f.write('source.ts', 'changed\n');
    f.commit();
    expect(await f.detect(event)).toBe('required=false');
  },
);

test.each([
  'README.md',
  'docs/日本語 空白\n付き.md',
  'tools/docs/check.ts',
  '.github/workflows/docs.yml',
  'package.json',
  'apps/worker/package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  '.node-version',
  '.markdownlint.json',
  '.gitignore',
  'apps/worker/.gitignore',
  '.oxlintrc.json',
  '.oxfmtrc.json',
])('文書・検査設定の変更では検査する: %s', async (file) => {
  const f = await fixture();
  await f.write(file);
  f.commit();
  expect(await f.detect('pull_request')).toBe('required=true');
});

test.each(['削除', '移動'])('Markdown以外のファイルの%sでもリンクを検査する', async (operation) => {
  const f = await fixture();
  const image = path.join(f.root, 'image.png');
  if (operation === '削除') await rm(image);
  else await rename(image, path.join(f.root, 'renamed.png'));
  f.commit();
  expect(await f.detect('push')).toBe('required=true');
});

test('PRの比較先だけにある文書変更では検査しない', async () => {
  const f = await fixture();
  await f.write('README.md');
  const baseTip = f.commit();
  f.git('checkout', '-q', '--detach', f.base);
  await f.write('source.ts', 'PR change\n');
  const head = f.commit();
  expect(await f.detect('pull_request', baseTip, head)).toBe('required=false');
});

test('PRと比較先が同じ文書を追加していてもPRの文書変更を検査する', async () => {
  const f = await fixture();
  await f.write('README.md');
  const baseTip = f.commit();
  f.git('checkout', '-q', '--detach', f.base);
  await f.write('README.md');
  await f.write('source.ts', 'PR change\n');
  const head = f.commit();
  expect(await f.detect('pull_request', baseTip, head)).toBe('required=true');
});

test('pushは最終コミットだけでなくpush全体の文書変更を検査する', async () => {
  const f = await fixture();
  await f.write('README.md');
  f.commit();
  await f.write('source.ts', 'last commit\n');
  f.commit();
  expect(await f.detect('push')).toBe('required=true');
});

test.each(['0'.repeat(40), '1'.repeat(40)])(
  '比較元が存在しなければ検査する: %s',
  async (before) => {
    const f = await fixture();
    expect(await f.detect('push', before)).toBe('required=true');
  },
);

test('差分がなければ検査しない', async () => {
  const f = await fixture();
  expect(await f.detect('push')).toBe('required=false');
});

test('比較に失敗した場合は検査不要として成功しない', async () => {
  const f = await fixture();
  await expect(f.detect('push', f.base, '1'.repeat(40))).rejects.toThrow();
});
