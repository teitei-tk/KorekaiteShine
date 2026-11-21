import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assert, expect, it } from 'vitest';

// prepare.shのコンパイル呼び出しをそのまま実行し、通常の型検査とは別の出力経路を検査する。
it('隔離用コードをコンパイルし、setup.shで配置したJSから依存を解決して待機処理を実行できる', () => {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const source = readFileSync(new URL('isolation/prepare.sh', import.meta.url), 'utf8');
  const compile = source
    .replaceAll('\\\n', ' ')
    .split('\n')
    .find((line) => line.startsWith('pnpm --dir tools/ai-review '));
  expect(compile).toBeDefined();
  const directory = mkdtempSync(join(tmpdir(), 'ai-isolation-build-'));
  try {
    execFileSync('bash', ['-eu', '-c', compile ?? assert.fail('必須のテスト値がありません。')], {
      cwd: root,
      env: { ...process.env, RUNNER_TEMP: directory },
      stdio: 'pipe',
    });
    // 特権操作を含まない実際の配置コマンドを、一時ディレクトリで実行する。
    const opt = join(directory, 'opt');
    mkdirSync(join(opt, 'ai-review-probe/pr'), { recursive: true });
    const setup = readFileSync(new URL('isolation/setup.sh', import.meta.url), 'utf8');
    const copies = setup
      .split('\n')
      .filter((line) => line.startsWith('cp '))
      .join('\n');
    execFileSync('bash', [
      '-eu',
      '-c',
      copies.replaceAll('/opt/', `${opt}/`),
      'setup',
      'unused',
      join(directory, 'isolation-compiled'),
    ]);
    writeFileSync(join(opt, 'package.json'), '{"type":"module"}');
    // 配置先のroot・Action・PR子プロセスで必要な依存と、Temporalの期限処理を確認する。
    writeFileSync(join(directory, 'info.json'), JSON.stringify({ pid: 123, port: 4567 }));
    const output = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import { readInfo } from ${JSON.stringify(pathToFileURL(join(opt, 'ai-review-probe/lifecycle.js')).href)};
      import ${JSON.stringify(pathToFileURL(join(opt, 'ai-review-probe/model.js')).href)};
      import ${JSON.stringify(pathToFileURL(join(opt, 'ai-review-probe/wif.js')).href)};
      import ${JSON.stringify(pathToFileURL(join(opt, 'ai-review-probe/pr/input.js')).href)};
      import ${JSON.stringify(pathToFileURL(join(opt, 'ai-review-probe/isolation-probe.js')).href)};
      console.log(JSON.stringify(await readInfo(${JSON.stringify(join(directory, 'info.json'))})));
    `,
      ],
      { encoding: 'utf8' },
    );
    expect(JSON.parse(output)).toEqual({ pid: 123, port: 4567 });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);
