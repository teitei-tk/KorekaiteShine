import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../db/', import.meta.url));
const testRoot = fileURLToPath(new URL('../../../.local/tests/', import.meta.url));

/** 正式履歴を変更せず、独立テスト環境に任意時点までの履歴を複製する。 */
export async function prepareMigrationFixture(directory: string, through?: string): Promise<void> {
  const path = relative(testRoot, resolve(directory));
  if (!path || path.startsWith('..')) {
    throw new Error('独立テスト環境内だけに履歴を準備できます。');
  }
  const journal = JSON.parse(await readFile(join(source, 'migrations/meta/_journal.json'), 'utf8'));
  const entries: { tag: string }[] = journal.entries;
  const index =
    through === undefined
      ? entries.length - 1
      : entries.findIndex((entry) => entry.tag === through);
  if (index < 0) {
    throw new Error('指定したmigrationがありません。');
  }
  await mkdir(directory, { recursive: true });
  await cp(source, directory, { recursive: true });
  for (const entry of entries.slice(index + 1)) {
    await rm(join(directory, 'migrations', `${entry.tag}.sql`));
  }
  journal.entries = journal.entries.slice(0, index + 1);
  await writeFile(join(directory, 'migrations/meta/_journal.json'), JSON.stringify(journal));
}
