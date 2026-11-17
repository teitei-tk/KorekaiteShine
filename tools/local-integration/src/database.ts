import { localProcessEnvironment } from './local-environment.ts';
import { lockEnvironment } from './lock.ts';
import { runNodeCommand } from './process.ts';
import { cp, mkdir, readlink, symlink, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RuntimeConfig } from '@korekaite/runtime-config';
import { claimArtifactDirectory } from '@korekaite/runtime-config/artifacts';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
export type DatabaseCommand = ['generate'] | ['migrate'] | ['reset-seed'] | ['execute', string];

async function linkDirectory(source: string, target: string): Promise<void> {
  try {
    await symlink(source, target, 'dir');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) {
      throw error;
    }
    if ((await readlink(target)) !== source) {
      throw new Error('DB管理用の参照先が一致しません。', { cause: error });
    }
  }
}

type DatabaseOptions = {
  schemaDirectory?: string;
  signal?: AbortSignal;
};

async function executeDatabaseCommand(
  config: RuntimeConfig,
  args: DatabaseCommand,
  options: DatabaseOptions,
): Promise<void> {
  options.signal?.throwIfAborted();
  if (config.environment === 'production' || !config.stateDirectory) {
    throw new Error('ローカルDBだけを操作できます。');
  }
  if (!validDatabaseCommand(args)) {
    throw new Error('未対応のDB操作です。');
  }
  if (options.schemaDirectory) {
    const path = relative(config.artifactDirectory, resolve(options.schemaDirectory));
    if (
      config.environment !== 'test' ||
      !path ||
      path.startsWith('..') ||
      args[0] === 'generate' ||
      args[0] === 'reset-seed'
    ) {
      throw new Error('履歴の差し替えは独立テスト環境のmigration検証だけで利用できます。');
    }
  }
  await claimArtifactDirectory(config);
  const project = join(
    config.artifactDirectory,
    options.schemaDirectory ? 'database-fixture' : 'database',
  );
  await mkdir(project, { recursive: true });
  await cp(join(repositoryRoot, 'packages/database/package.json'), join(project, 'package.json'));
  await linkDirectory(
    join(repositoryRoot, 'packages/database/node_modules'),
    join(project, 'node_modules'),
  );
  await linkDirectory(
    options.schemaDirectory ?? join(repositoryRoot, 'packages/database/db'),
    join(project, 'db'),
  );
  await linkDirectory(
    join(repositoryRoot, 'packages/database/fixtures'),
    join(project, 'fixtures'),
  );
  const configuration = {
    worker: { compatibility_date: '2026-10-19' },
    cloudflare: {
      d1_databases: [{ binding: 'DB', database_name: config.d1.name, database_id: config.d1.id }],
    },
  };
  await writeFile(
    join(project, 'void.config.ts'),
    `export default ${JSON.stringify(configuration)};\n`,
  );
  // 公開Plugin APIでCLIが参照する保存先情報を生成する。内部JSON形式を手書きしない。
  await writeFile(
    join(project, 'prepare.ts'),
    `import { voidPlugin } from 'void';\nvoidPlugin({ persistTo: ${JSON.stringify(config.stateDirectory)} });\n`,
  );
  const env = {
    ...localProcessEnvironment(),
    APP_ENV: config.environment,
    NO_COLOR: '1',
    WRANGLER_LOG_PATH: join(config.artifactDirectory, 'db-wrangler.log'),
  };
  for (const command of [
    [join(project, 'prepare.ts')],
    [
      join(repositoryRoot, 'packages/database/node_modules/void/dist/cli/cli.mjs'),
      'db',
      ...(args[0] === 'reset-seed' ? ['seed', '--yes'] : args),
    ],
  ]) {
    await runNodeCommand({
      args: command,
      cwd: project,
      env,
      logPath: join(config.artifactDirectory, `db-${args[0]}.log`),
      label: `DB ${args[0]}`,
      timeoutMs: 30_000,
      signal: options.signal,
    });
  }
}

export async function runDatabaseCommand(
  config: RuntimeConfig,
  args: DatabaseCommand,
  options: DatabaseOptions = {},
): Promise<void> {
  if (args[0] !== 'reset-seed') {
    return executeDatabaseCommand(config, args, options);
  }
  const release = await lockEnvironment(config);
  try {
    await executeDatabaseCommand(config, args, options);
  } finally {
    release();
  }
}

// eslint-disable-next-line typescript/no-restricted-types -- CLI/テスト境界の配列を実行時検証する。
function validDatabaseCommand(value: readonly unknown[]): value is DatabaseCommand {
  return (
    (value.length === 1 &&
      (value[0] === 'generate' || value[0] === 'migrate' || value[0] === 'reset-seed')) ||
    (value.length === 2 &&
      value[0] === 'execute' &&
      typeof value[1] === 'string' &&
      !value[1].startsWith('--'))
  );
}
