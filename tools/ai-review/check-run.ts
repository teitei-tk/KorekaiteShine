import { runVersion } from './run-version.ts';
import { execFileSync } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { REPOSITORY } from './policy.ts';

const states = new Set([
  'queued',
  'in_progress',
  'completed',
  'waiting',
  'pending',
  'requested',
  'success',
  'failure',
  'cancelled',
  'skipped',
  'timed_out',
  'action_required',
  'neutral',
  'stale',
  'startup_failure',
]);
const labels = new Map([
  ['gate', '本人PR判定'],
  ['generate', 'レビュー生成'],
  ['publish', 'コメント投稿'],
  ['Diagnose claims or exchange a short-lived token', 'WIF認証'],
  ['Review using GPT-6 Luna', 'Luna呼び出し'],
  ['Validate output before handing it to the posting job', '出力検証'],
  ['Recheck PR author and revision, then update the review comment', '投稿前確認・投稿'],
  ['Repository lint, format and AI review checks', 'Lint・整形・テスト'],
  ['Check formatting, links, and heading anchors', '文書検査'],
  ['Verify Actions lockfile', 'Actionsロック検証'],
]);
interface StepInput {
  name?: string;
  status: string | null;
  conclusion: string | null;
}
interface JobInput extends StepInput {
  steps: StepInput[];
}
interface RunInput {
  status: string | null;
  conclusion: string | null;
  jobs: JobInput[];
}
function record(value: object | null | undefined): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function state(value: string | null | undefined): string {
  if (value === '' || value === null) return '未確定';
  if (typeof value !== 'string' || !states.has(value)) throw new Error('Invalid state');
  return value;
}
export function runSnapshot(raw: string): { output: string; done: boolean; ok: boolean } {
  const data: RunInput = JSON.parse(raw);
  if (!record(data) || !Array.isArray(data.jobs)) throw new Error('Invalid response');
  const status = state(data.status),
    conclusion = state(data.conclusion);
  const lines = [`実行: ${status} / ${conclusion}`];
  for (const [i, job] of data.jobs.entries()) {
    if (!record(job) || !Array.isArray(job.steps)) throw new Error('Invalid job');
    const name = typeof job.name === 'string' ? labels.get(job.name) : undefined;
    lines.push(`${name ?? `job ${i + 1}`}: ${state(job.status)} / ${state(job.conclusion)}`);
    for (const [j, step] of job.steps.entries()) {
      if (!record(step)) throw new Error('Invalid step');
      const result = state(step.conclusion);
      const label = typeof step.name === 'string' ? labels.get(step.name) : undefined;
      if (label || (result !== '未確定' && !['success', 'skipped'].includes(result)))
        lines.push(`  ${label ?? `step ${j + 1}`}: ${state(step.status)} / ${result}`);
    }
  }
  return { output: lines.join('\n'), done: status === 'completed', ok: conclusion === 'success' };
}
function readRun(id: string): string {
  return execFileSync(
    'gh',
    ['run', 'view', id, '--repo', REPOSITORY, '--json', 'status,conclusion,jobs'],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
      maxBuffer: 2_000_000,
      env: { ...process.env, GH_DEBUG: '', GH_PROMPT_DISABLED: '1' },
    },
  );
}
export async function checkRun(
  id: string,
  watch: boolean,
  read = readRun,
  emit: (text: string) => void = console.log,
  pause: () => Promise<void> = async () => {
    await setTimeout(15_000);
  },
): Promise<number> {
  if (!/^[1-9][0-9]{0,17}$/.test(id)) {
    emit('正の実行IDを指定してください。');
    return 2;
  }
  let previous = '';
  try {
    emit(`https://github.com/${REPOSITORY}/actions/runs/${id}`);
    for (let attempt = 0; attempt < (watch ? 40 : 1); attempt++) {
      const snapshot = runSnapshot(read(id));
      if (snapshot.output !== previous) {
        emit(snapshot.output);
        previous = snapshot.output;
      }
      if (snapshot.done) return snapshot.ok ? 0 : 1;
      if (!watch) return 0;
      if (attempt < 39) await pause();
    }
    emit('監視の上限に達しました。実行は停止していません。');
    return 2;
  } catch {
    emit('実行状態を取得・解析できませんでした。権限・接続・実行IDを確認してください。');
    return 2;
  }
}
export function parseRunArgs(args: string[]): { id: string; watch: boolean; expected?: string } {
  const [id, ...options] = args;
  if (!id || !/^[1-9][0-9]{0,17}$/.test(id)) throw new Error('Invalid arguments');
  let watch = false;
  let expected: string | undefined;
  for (let i = 0; i < options.length; i++) {
    if (options[i] === '--watch' && !watch) watch = true;
    else if (options[i] === '--expect-commit' && expected === undefined) {
      expected = options[++i];
      if (!expected || !/^[a-f0-9]{40}$/.test(expected)) throw new Error('Invalid arguments');
    } else throw new Error('Invalid arguments');
  }
  return { id, watch, expected };
}
export async function checkRunCommand(
  args: string[],
  version = runVersion,
  check = checkRun,
  emit: (text: string) => void = console.log,
): Promise<number> {
  let options: ReturnType<typeof parseRunArgs>;
  try {
    options = parseRunArgs(args);
  } catch {
    emit('使い方: pnpm check:ai-run <実行ID> [--watch] [--expect-commit <40桁SHA>]');
    return 2;
  }
  try {
    const result = version(options.id, options.expected);
    emit(result.output);
    if (!result.eligible) return 3;
  } catch {
    emit(
      '実行状態を取得・解析できませんでした。実行版・期待コミット・権限・接続を確認してください。',
    );
    return 2;
  }
  return check(options.id, options.watch, undefined, emit);
}
if (import.meta.main) process.exitCode = await checkRunCommand(process.argv.slice(2));
