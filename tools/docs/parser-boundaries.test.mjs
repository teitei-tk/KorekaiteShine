import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { checkLinks, checkCommands } from './check.ts';
const parsed = vi.hoisted(() => ({ tokens: [] }));
vi.mock('markdown-it', () => ({
  default: class {
    state = parsed;
    parse() {
      return this.state.tokens;
    }
  },
}));
test('parserが子トークンを持たない見出し・inline・画像を返しても検査を完了する', async () => {
  const root = await mkdtemp(join(tmpdir(), 'doc-parser-'));
  try {
    await writeFile(join(root, 'README.md'), '# fixture');
    parsed.tokens = [{ type: 'heading_open' }, { type: 'inline', children: null }];
    expect(await checkLinks(root, ['README.md'])).toEqual([]);
    expect(await checkCommands(root, ['README.md'])).toEqual([]);
    parsed.tokens = [
      { type: 'heading_open' },
      { type: 'inline', children: [{ type: 'image', children: null, attrGet: () => null }] },
    ];
    expect(await checkLinks(root, ['README.md'])).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
