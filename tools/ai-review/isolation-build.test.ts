import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';

// prepare.shのコンパイル呼び出しをそのまま実行し、通常の型検査とは別の出力経路を検査する。
it('隔離用コードをTemporalの型を含めてコンパイルし、出力したJSから待機処理を実行できる', () => {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const source = readFileSync(new URL('./isolation/prepare.sh', import.meta.url), 'utf8');
  const compile = source
    .replace(/\\\n/g, ' ')
    .split('\n')
    .find((line) => line.startsWith('pnpm --dir tools/ai-review '));
  expect(compile).toBeDefined();
  const directory = mkdtempSync(join(tmpdir(), 'ai-isolation-build-'));
  try {
    execFileSync('bash', ['-eu', '-c', compile!], {
      cwd: root,
      env: { ...process.env, RUNNER_TEMP: directory },
      stdio: 'pipe',
    });
    // root側で直接実行する成果物のimportと、Temporalを使う期限処理を確認する。
    writeFileSync(join(directory, 'info.json'), JSON.stringify({ pid: 123, port: 4567 }));
    const output = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import { readInfo } from ${JSON.stringify(pathToFileURL(join(directory, 'isolation-compiled/isolation/lifecycle.js')).href)};
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
