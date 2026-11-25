import { execFileSync } from 'node:child_process';
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const script = fileURLToPath(new URL('../../containers/prepare-input.py', import.meta.url));

test('依存入力にはマニフェストを含め、環境変数・ソース・外部リンクを渡さない', () => {
  const root = mkdtempSync(join(tmpdir(), 'container-input-'));
  try {
    const repo = join(root, 'repo');
    mkdirSync(join(repo, 'apps/web'), { recursive: true });
    execFileSync('git', ['init', '-q', repo]);
    writeFileSync(join(repo, 'apps/web/package.json'), '{}');
    writeFileSync(join(repo, '.env'), 'fixture');
    writeFileSync(join(repo, 'apps/web/index.ts'), 'export {};');
    mkdirSync(join(repo, 'tools/fixture'), { recursive: true });
    symlinkSync(join(repo, '.env'), join(repo, 'tools/fixture/package.json'));
    const output = join(root, 'deps');
    execFileSync('python3', [script, 'deps', repo, output]);
    expect(readFileSync(join(output, 'apps/web/package.json'), 'utf8')).toBe('{}');
    for (const path of ['.env', 'apps/web/index.ts', 'tools/fixture/package.json', '.git']) {
      expect(existsSync(join(output, path))).toBe(false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('開発入力は未追跡のソースを含み、無視対象と開発用の秘密値を除く', () => {
  const root = mkdtempSync(join(tmpdir(), 'container-source-'));
  try {
    const repo = join(root, 'repo');
    mkdirSync(join(repo, 'apps/web'), { recursive: true });
    execFileSync('git', ['init', '-q', repo]);
    writeFileSync(join(repo, '.gitignore'), 'ignored.ts\n');
    for (const path of ['draft.ts', '.dev.vars', '.npmrc', 'ignored.ts']) {
      writeFileSync(join(repo, 'apps/web', path), 'fixture');
    }
    chmodSync(join(repo, 'apps/web/draft.ts'), 0o755);
    const output = join(root, 'source');
    execFileSync('python3', [script, 'source', repo, output]);
    expect(readFileSync(join(output, 'apps/web/draft.ts'), 'utf8')).toBe('fixture');
    accessSync(join(output, 'apps/web/draft.ts'), constants.X_OK);
    for (const path of ['.dev.vars', '.npmrc', 'ignored.ts']) {
      expect(existsSync(join(output, 'apps/web', path))).toBe(false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
