import { lockEnvironment } from './lock.ts';
import { spawn } from 'node:child_process';
import { cp, mkdir, readlink, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RuntimeConfig } from '@korekaite/runtime-config';
import { claimArtifactDirectory } from '@korekaite/runtime-config/artifacts';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
export type DatabaseCommand = ['generate'] | ['migrate'] | ['reset-seed'] | ['execute', string];

async function linkDirectory(source: string, target: string): Promise<void> {
  try {
    await symlink(source, target, 'dir');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    if ((await readlink(target)) !== source) throw new Error('DB管理用の参照先が一致しません。');
  }
}

async function executeDatabaseCommand(config: RuntimeConfig, args: DatabaseCommand): Promise<void> {
  if (config.environment === 'production' || !config.stateDirectory)
    throw new Error('ローカルDBだけを操作できます。');
  if (
    !(
      (args.length === 1 &&
        (args[0] === 'generate' || args[0] === 'migrate' || args[0] === 'reset-seed')) ||
      (args.length === 2 && args[0] === 'execute' && !args[1].startsWith('--'))
    )
  ) {
    throw new Error('未対応のDB操作です。');
  }
  await claimArtifactDirectory(config);
  const project = join(config.artifactDirectory, 'database');
  await mkdir(project, { recursive: true });
  await cp(join(repositoryRoot, 'packages/database/package.json'), join(project, 'package.json'));
  await linkDirectory(
    join(repositoryRoot, 'packages/database/node_modules'),
    join(project, 'node_modules'),
  );
  await linkDirectory(join(repositoryRoot, 'packages/database/db'), join(project, 'db'));
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
    ...process.env,
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
    const child = spawn(process.execPath, command, {
      cwd: project,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    await writeFile(join(config.artifactDirectory, `db-${args[0]}.log`), output);
    if (code !== 0)
      throw new Error(
        `DB ${args[0]}失敗（${code}）。${join(config.artifactDirectory, `db-${args[0]}.log`)}を確認してください。`,
      );
  }
}

export async function runDatabaseCommand(
  config: RuntimeConfig,
  args: DatabaseCommand,
): Promise<void> {
  if (args[0] !== 'reset-seed') return executeDatabaseCommand(config, args);
  const release = await lockEnvironment(config);
  try {
    await executeDatabaseCommand(config, args);
  } finally {
    release();
  }
}
