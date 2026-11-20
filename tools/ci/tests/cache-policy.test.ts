import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { isRecord, parseJson } from '../src/json.ts';
import { installDependencies } from '../src/install-dependencies.ts';
import type { CommandRunner } from '../../docs/check-guard.ts';

const { join } = path;

test('同じcheckoutとstoreを再利用しても現在のregistry拒否を確認して停止する', async () => {
  const manifest = parseJson(
    readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
  );
  if (!isRecord(manifest) || typeof manifest.packageManager !== 'string') {
    throw new TypeError('packageManager設定がありません。');
  }
  expect(`pnpm@${execFileSync('pnpm', ['--version'], { encoding: 'utf8' }).trim()}`).toBe(
    manifest.packageManager,
  );
  const root = mkdtempSync(join(tmpdir(), 'ci-cache-policy-'));
  const project = join(root, 'project');
  const store = join(root, 'store');
  const packageDirectory = join(root, 'package');
  const packageName = 'ci-cache-policy-fixture';
  const contents = 'module.exports = "CACHE_FIXTURE_OK";\n';
  mkdirSync(project);
  mkdirSync(packageDirectory);
  writeFileSync(
    join(packageDirectory, 'package.json'),
    JSON.stringify({ name: packageName, version: '1.0.0', main: 'index.js' }),
  );
  writeFileSync(join(packageDirectory, 'index.js'), contents);
  const tarball = join(root, 'package.tgz');
  execFileSync('tar', ['-czf', tarball, '-C', root, 'package']);
  const mode = join(root, 'mode');
  const requests = join(root, 'requests.jsonl');
  writeFileSync(mode, 'allow');
  writeFileSync(requests, '');
  const config = join(root, 'registry.json');
  writeFileSync(
    config,
    JSON.stringify({
      name: packageName,
      tarball,
      mode,
      requests,
      published: Temporal.Now.instant().subtract({ hours: 48 }).toString(),
      integrity: `sha512-${createHash('sha512').update(readFileSync(tarball)).digest('base64')}`,
    }),
  );
  writeFileSync(
    join(project, 'package.json'),
    JSON.stringify({
      name: 'isolated-policy-fixture',
      private: true,
      dependencies: { [packageName]: '1.0.0' },
    }),
  );
  writeFileSync(
    join(project, 'pnpm-workspace.yaml'),
    'packages: []\nminimumReleaseAge: 1440\nminimumReleaseAgeStrict: true\nminimumReleaseAgeIgnoreMissingTime: false\nstrictDepBuilds: true\nblockExoticSubdeps: true\ntrustPolicy: no-downgrade\ntrustLockfile: false\n',
  );
  const server = spawn(
    process.execPath,
    [new URL('fixtures/cache-registry.ts', import.meta.url).pathname, config],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const errors: string[] = [];
  server.stderr.on('data', (data: Buffer) => {
    errors.push(data.toString());
  });
  try {
    const registry = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`registry fixture起動失敗: ${errors.join('')}`));
      }, 5000);
      server.stdout.once('data', (data: Buffer) => {
        clearTimeout(timer);
        resolve(data.toString().trim());
      });
      server.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    const common = [
      `--store-dir=${store}`,
      `--registry=${registry}`,
      '--config.update-notifier=false',
    ];
    const installed = join(project, 'node_modules', packageName, 'index.js');
    const reset = (value: string) => {
      rmSync(join(project, 'node_modules'), { recursive: true, force: true });
      writeFileSync(mode, value);
      writeFileSync(requests, '');
    };
    const entries = () =>
      readFileSync(requests, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const value = parseJson(line);
          if (!isRecord(value) || typeof value.path !== 'string') {
            throw new TypeError('request記録が不正です。');
          }
          return value.path;
        });
    const run: CommandRunner = (program, args) => {
      if (args[0] !== 'install') {
        return { status: 0, stdout: 'https://npm.flatt.tech/\n', stderr: '' };
      }
      expect(program).toBe('pnpm');
      return spawnSync(program, [...args, ...common], {
        cwd: project,
        encoding: 'utf8',
        timeout: 20_000,
      });
    };
    const seed = spawnSync(
      'pnpm',
      [
        'install',
        '--ignore-scripts',
        '--no-trust-lockfile',
        '--no-prefer-offline',
        `--config.cache-dir=${join(root, 'seed-metadata')}`,
        '--state-dir',
        join(root, 'seed-state'),
        ...common,
      ],
      { cwd: project, encoding: 'utf8', timeout: 20_000 },
    );
    expect(seed.status).toBe(0);
    expect(readFileSync(installed, 'utf8')).toBe(contents);
    expect(entries().some((entry) => entry.includes('/-/'))).toBe(true);
    reset('allow');
    installDependencies(run);
    expect(readFileSync(installed, 'utf8')).toBe(contents);
    expect(entries()).toContain(`/${packageName}`);
    expect(entries().some((entry) => entry.includes('/-/'))).toBe(false);
    reset('deny');
    expect(() => installDependencies(run)).toThrow(/依存/u);
    expect(entries()).toContain(`/${packageName}`);
    expect(existsSync(installed)).toBe(false);
  } finally {
    if (server.exitCode === null) {
      const closed = new Promise<void>((resolve) => {
        server.once('close', () => {
          resolve();
        });
      });
      server.kill('SIGTERM');
      await closed;
    }
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
