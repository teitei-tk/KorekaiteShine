import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const [directory, cause, ...extra] = process.argv.slice(2);
if (!directory || extra.length) {
  throw new Error('使い方: node snapshot.mjs <対象Git作業ツリー> [原因名]');
}
const source = realpathSync(directory);
const git = (...args) => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8' });
if (realpathSync(git('rev-parse', '--show-toplevel').trim()) !== source) {
  throw new Error('対象Git作業ツリーのルートを指定してください。');
}
const digest = createHash('sha256');
const files = git('ls-files', '--cached', '--others', '--exclude-standard', '-z').split('\0');
// Gitの除外設定に加え、ローカルの認証・環境設定をコピー対象から外す。
const privatePath =
  /(?:^|\/)(?:\.env(?:\.[^/]*)?|\.dev\.vars(?:\.[^/]*)?|\.npmrc|\.aws|\.ssh|\.wrangler|\.cloudflare|[^/]+\.(?:pem|key|p12|pfx))(?:\/|$)/u;
const snapshot = mkdtempSync(join(tmpdir(), 'voice-e2e-source-'));

function linkDependencies(folder) {
  const original = join(source, folder, 'node_modules');
  if (!existsSync(original)) {
    return;
  }
  const target = join(snapshot, folder, 'node_modules');
  mkdirSync(target);
  for (const name of readdirSync(original)) {
    if (name !== '@korekaite') {
      symlinkSync(join(original, name), join(target, name));
      continue;
    }
    mkdirSync(join(target, name));
    for (const pkg of readdirSync(join(original, name))) {
      const path = relative(source, realpathSync(join(original, name, pkg)));
      if (!path.startsWith('packages' + sep) || !existsSync(join(snapshot, path, 'package.json'))) {
        throw new Error('ワークスペース依存の原本を特定できません。');
      }
      symlinkSync(join(snapshot, path), join(target, name, pkg));
    }
  }
}

try {
  const workspaces = new Set(['.']);
  for (const name of [...new Set(files.filter(Boolean))].sort()) {
    const original = join(source, name);
    if (privatePath.test(name) || !existsSync(original)) {
      continue;
    }
    if (!lstatSync(original).isFile()) {
      throw new Error('ソースの通常ファイルだけをコピーできます。');
    }
    const target = join(snapshot, name);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(original, target);
    digest
      .update(name)
      .update('\0')
      .update(createHash('sha256').update(readFileSync(target)).digest());
    if (/^(?:apps|packages|tools)\/[^/]+\/package\.json$/u.test(name)) {
      workspaces.add(dirname(name));
    }
  }
  for (const workspace of workspaces) {
    linkDependencies(workspace);
  }
  const contracts = 'packages/api-contracts';
  cpSync(join(source, contracts, 'generated'), join(snapshot, contracts, 'generated'), {
    recursive: true,
  });
  if (cause) {
    const apply = fileURLToPath(new URL('./apply.mjs', import.meta.url));
    execFileSync(process.execPath, [apply, snapshot, cause], { stdio: ['ignore', 2, 2] });
    if (cause === 'audio-event') {
      const cwd = join(snapshot, contracts);
      const options = { cwd, stdio: ['ignore', 2, 2] };
      execFileSync(
        join(cwd, 'node_modules/.bin/tsp'),
        ['compile', 'events/live.tsp', '--config', 'tspconfig.events.yaml'],
        options,
      );
      execFileSync(process.execPath, ['scripts/generate-events.ts'], options);
    }
  }
  console.error('修正後ソース SHA-256:', digest.digest('hex'));
  console.log(snapshot);
} catch (error) {
  rmSync(snapshot, { recursive: true, force: true });
  throw error;
}
