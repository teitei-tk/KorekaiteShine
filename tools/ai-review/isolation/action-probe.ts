#!/usr/bin/env node
// 検証専用のcodex代替。公式Actionのsudo境界を観測後、実CLIのsandboxを検査する。
// 本番Workflowの実行ラッパーとして使用してはならない。
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { probeIsolation, requireIsolationReport, type IsolationInput } from '../isolation-probe.js';

const args = process.argv.slice(2);
const outputIndex = args.indexOf('--output-last-message');
if (
  args[0] !== 'exec' ||
  outputIndex < 0 ||
  args.at(-2) !== '--sandbox' ||
  args.at(-1) !== 'read-only'
) {
  throw new Error('official Action did not select read-only exec');
}
const input: IsolationInput = JSON.parse(readFileSync('/opt/ai-review-probe/input.json', 'utf8'));
input.env = process.env;
const outside = await probeIsolation(input);
if (!input.parentPidNamespace || outside.pidNamespace !== input.parentPidNamespace)
  throw new Error('Action boundary must share the live parent PID namespace');
// 外側では読取り・ネットワークはOS権限に従う。資格情報・UID・昇格だけをAction境界で検査。
const boundaryChecks = outside.checks.filter((check) =>
  ['uid', 'credential-environment', 'sudo', 'parent-environ', 'parent-mem'].includes(check.name),
);
console.log(
  JSON.stringify({
    stage: 'action-boundary',
    pidNamespace: outside.pidNamespace,
    checks: boundaryChecks,
  }),
);
if (boundaryChecks.some((check) => !check.passed)) {
  process.exit(1);
}
const result = spawnSync(
  '/usr/local/bin/codex',
  [
    'sandbox',
    '--permission-profile',
    ':read-only',
    '--cd',
    '/opt/ai-review-probe/pr',
    '--',
    '/bin/sh',
    '-c',
    'exec /usr/local/bin/node /opt/ai-review-probe/pr/probe-child.js',
  ],
  { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] },
);
process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');
if (result.error || result.status !== 0) process.exit(1);
requireIsolationReport(
  result.stdout,
  outside.checks.map((check) => check.name),
);
writeFileSync(args[outputIndex + 1], 'isolation fixture passed');
