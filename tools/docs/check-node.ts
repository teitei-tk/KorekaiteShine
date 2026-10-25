import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import semver from 'semver';
import { parse } from 'yaml';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

type Manifest = {
  engines?: { node?: string };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
type Workflow = {
  jobs?: Record<
    string,
    {
      steps?: { uses?: string; with?: { 'node-version-file'?: string; 'node-version'?: string } }[];
    }
  >;
};

export async function checkNodeSettings(root: string, files: string[]): Promise<string[]> {
  const errors: string[] = [];
  const version = (await readFile(path.join(root, '.node-version'), 'utf8')).trim();
  if (!/^\d+\.\d+\.\d+$/.test(version) || !semver.valid(version)) {
    return ['.node-version: 正式なバージョンを x.y.z 形式で指定してください'];
  }
  const nodeMajor = semver.major(version);
  for (const file of files) {
    if (path.basename(file) === 'package.json') {
      const manifest: Manifest = JSON.parse(await readFile(path.join(root, file), 'utf8'));
      const engine = manifest.engines?.node;
      if (file === 'package.json' && !engine) errors.push(`${file}: engines.nodeが必要です`);
      if (
        engine !== undefined &&
        (!semver.validRange(engine) || !semver.satisfies(version, engine))
      ) {
        errors.push(`${file}: engines.node (${engine}) がNode.js ${version}を許容していません`);
      }
      for (const section of ['dependencies', 'devDependencies'] as const) {
        const types = manifest[section]?.['@types/node'];
        if (
          types !== undefined &&
          (!semver.validRange(types) || !semver.subset(types, `${nodeMajor}.x`))
        ) {
          errors.push(
            `${file}: ${section}の@types/node (${types}) をNode.js ${nodeMajor}系に合わせてください`,
          );
        }
      }
    }
    if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(file)) {
      const workflow: Workflow = parse(await readFile(path.join(root, file), 'utf8'));
      for (const [job, config] of Object.entries(workflow.jobs ?? {})) {
        for (const step of config.steps ?? []) {
          if (!step.uses?.startsWith('actions/setup-node@')) continue;
          if (
            step.with?.['node-version-file'] !== '.node-version' ||
            'node-version' in (step.with ?? {})
          ) {
            errors.push(
              `${file} (${job}): setup-nodeはnode-versionを併記せずnode-version-file: .node-versionを参照してください`,
            );
          }
        }
      }
    }
  }
  return errors;
}

async function main() {
  const files = [
    ...new Set(
      execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
        cwd: repository,
        encoding: 'utf8',
      })
        .split('\0')
        .filter(Boolean),
    ),
  ];
  const errors = await checkNodeSettings(repository, files);
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
  } else {
    console.log('Node.js設定の整合性検査成功');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: Error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
