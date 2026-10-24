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
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function state(value: unknown): string {
  if (value === '' || value === null) return '未確定';
  if (typeof value !== 'string' || !states.has(value)) throw new Error('Invalid state');
  return value;
}
export function runSnapshot(raw: string): { output: string; done: boolean; ok: boolean } {
  const data: unknown = JSON.parse(raw);
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
if (import.meta.main) {
  const [id, option, extra] = process.argv.slice(2);
  if (!id || extra || (option !== undefined && option !== '--watch')) {
    console.error('使い方: pnpm check:ai-run <実行ID> [--watch]');
    process.exitCode = 2;
  } else process.exitCode = await checkRun(id, option === '--watch');
}
