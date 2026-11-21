import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { localProcessEnvironment } from '../../local-integration/src/local-environment.ts';
import type { ExplorationTarget } from './types.ts';

export const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const execute = promisify(execFile);
export const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

export type ExplorationIdentity = {
  gitSha: string;
  sourceHash: string;
  specHash: string;
  bombadil: { version: string; sha256: string };
  browser: { version: string; sha256: string };
};

export async function describeEnvironment(
  target: ExplorationTarget,
  signal: AbortSignal,
  excludedDirectories: string[],
) {
  const platform = `${process.platform}-${process.arch}`;
  if (!['darwin-arm64', 'linux-arm64', 'linux-x64'].includes(platform)) {
    throw new Error('固定版Bombadilの対応外です。');
  }
  const binary = fileURLToPath(
    new URL(
      `../node_modules/@antithesishq/bombadil/binaries/bombadil-${platform}`,
      import.meta.url,
    ),
  );
  const chrome = resolve(
    process.env.E2E_CHROME_PATH === ''
      ? chromium.executablePath()
      : (process.env.E2E_CHROME_PATH ?? chromium.executablePath()),
  );
  const specPath = fileURLToPath(new URL(`${target}.spec.ts`, import.meta.url));
  const command = async (file: string, args: string[]) =>
    (
      await execute(file, args, {
        cwd: repositoryRoot,
        env: localProcessEnvironment(),
        signal,
        timeout: 10_000,
        maxBuffer: 8 * 1024 * 1024,
      })
    ).stdout.trim();
  const gitSha = await command('git', ['rev-parse', 'HEAD']);
  const paths = (
    await command('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
  )
    .split('\0')
    .filter(Boolean)
    .toSorted();
  const source = createHash('sha256');
  for (const path of new Set(paths)) {
    const absolute = join(repositoryRoot, path);
    if (
      excludedDirectories.some((directory) => {
        const child = relative(directory, absolute);
        return child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
      })
    ) {
      continue;
    }
    signal.throwIfAborted();
    source.update(`${path}\0`);
    try {
      source.update(await readFile(absolute));
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
        throw error;
      }
      source.update('<deleted>');
    }
    source.update('\0');
  }
  const identity: ExplorationIdentity = {
    gitSha,
    sourceHash: source.digest('hex'),
    specHash: digest(await readFile(specPath)),
    bombadil: {
      version: await command(binary, ['--version']),
      sha256: digest(await readFile(binary)),
    },
    browser: {
      version: await command(chrome, ['--version']),
      sha256: digest(await readFile(chrome)),
    },
  };
  if (identity.bombadil.version !== 'bombadil 0.7.10') {
    throw new Error('Bombadilの版が固定版と一致しません。');
  }
  return { identity, binary, chrome, specPath };
}
