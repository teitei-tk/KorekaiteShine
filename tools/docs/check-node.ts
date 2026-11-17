import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import semver from 'semver';
import { parse } from 'yaml';
import { inputRecord, optionalText } from './input.ts';
import type { DocumentInput } from './input.ts';

const repository = path.resolve(import.meta.dirname, '../..');

export async function checkNodeSettings(root: string, files: string[]): Promise<string[]> {
  const errors: string[] = [];
  const version = (await readFile(path.join(root, '.node-version'), 'utf8')).trim();
  if (!/^\d+\.\d+\.\d+$/u.test(version) || !semver.valid(version)) {
    return ['.node-version: 正式なバージョンを x.y.z 形式で指定してください'];
  }
  const nodeMajor = semver.major(version);
  for (const file of files) {
    if (path.basename(file) === 'package.json') {
      const input: DocumentInput = JSON.parse(await readFile(path.join(root, file), 'utf8'));
      const manifest = inputRecord(input, file);
      const engines =
        manifest.engines === undefined ? {} : inputRecord(manifest.engines, `${file}: engines`);
      const engine = optionalText(engines.node, `${file}: engines.node`);
      if (file === 'package.json' && !engine) {
        errors.push(`${file}: engines.nodeが必要です`);
      }
      if (
        engine !== undefined &&
        (!semver.validRange(engine) || !semver.satisfies(version, engine))
      ) {
        errors.push(`${file}: engines.node (${engine}) がNode.js ${version}を許容していません`);
      }
      for (const section of ['dependencies', 'devDependencies'] as const) {
        const dependencies =
          manifest[section] === undefined
            ? {}
            : inputRecord(manifest[section], `${file}: ${section}`);
        const types = optionalText(dependencies['@types/node'], `${file}: ${section}.@types/node`);
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
    if (/^\.github\/workflows\/[^/]+\.ya?ml$/u.test(file)) {
      const input: DocumentInput = parse(await readFile(path.join(root, file), 'utf8'));
      const workflow = inputRecord(input, file);
      const jobs = workflow.jobs === undefined ? {} : inputRecord(workflow.jobs, `${file}: jobs`);
      for (const [job, jobInput] of Object.entries(jobs)) {
        const config = inputRecord(jobInput, `${file}: ${job}`);
        const steps = config.steps ?? [];
        if (!Array.isArray(steps)) {
          throw new TypeError(`${file}: stepsは配列が必要です`);
        }
        for (const stepInput of steps as DocumentInput[]) {
          const step = inputRecord(stepInput, `${file}: step`);
          const uses = optionalText(step.uses, `${file}: uses`);
          if (!uses?.startsWith('actions/setup-node@')) {
            continue;
          }
          const settings = step.with === undefined ? {} : inputRecord(step.with, `${file}: with`);
          if (settings['node-version-file'] !== '.node-version' || 'node-version' in settings) {
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

export async function main(root = repository) {
  const files = [
    ...new Set(
      execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
        cwd: root,
        encoding: 'utf8',
      })
        .split('\0')
        .filter(Boolean),
    ),
  ];
  const errors = await checkNodeSettings(root, files);
  if (errors.length > 0) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
  } else {
    console.log('Node.js設定の整合性検査成功');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
