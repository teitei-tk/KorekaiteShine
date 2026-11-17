import { parseJson, isJsonObject } from './json.ts';
import type { JsonValue } from './json.ts';
import { requireValue } from './required.ts';
import { isSourceCi } from './source-ci.ts';
import { execFileSync } from 'node:child_process';
import { REPOSITORY } from './policy.ts';
const sha = (value: JsonValue | undefined): value is string =>
  typeof value === 'string' && /^[a-f0-9]{40}$/u.test(value);
function readApi(path: string): string {
  return execFileSync('gh', ['api', path], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
    maxBuffer: 2_000_000,
    env: { ...process.env, GH_DEBUG: '', GH_PROMPT_DISABLED: '1' },
  });
}
export function runVersion(
  id: string,
  expected?: string,
  read = readApi,
): { output: string; eligible: boolean } {
  if (!/^[1-9]\d{0,17}$/u.test(id) || (expected !== undefined && !sha(expected))) {
    throw new Error('Invalid input');
  }
  const prefix = `repos/${REPOSITORY}`;
  const run = parseJson(read(`${prefix}/actions/runs/${id}`));
  if (
    !isJsonObject(run) ||
    (typeof run.id !== 'number' && typeof run.id !== 'string') ||
    String(run.id) !== id ||
    !sha(run.head_sha)
  ) {
    throw new Error('Invalid run');
  }
  const lines = [`実行コードSHA: ${run.head_sha}`];
  if (run.event !== 'workflow_run' || run.path !== '.github/workflows/ai-review.yml') {
    return {
      output: lines
        .concat(
          'レビュー対象SHA: 特定できません（AIレビュー実行のIDを指定してください）',
          '修正版の検証対象外',
        )
        .join('\n'),
      eligible: expected === undefined,
    };
  }
  const source =
    /^AI review \/ source run (?<capture1>[1-9]\d{0,17}) attempt (?<capture2>[1-9]\d{0,5}) \/ (?<capture3>review|claims)$/u.exec(
      typeof run.display_title === 'string' ? run.display_title : '',
    );
  if (!source) {
    throw new Error('Invalid source');
  }
  const original = parseJson(read(`${prefix}/actions/runs/${source[1]}/attempts/${source[2]}`));
  if (
    !isJsonObject(original) ||
    (typeof original.id !== 'number' && typeof original.id !== 'string') ||
    (typeof original.run_attempt !== 'number' && typeof original.run_attempt !== 'string') ||
    String(original.id) !== source[1] ||
    String(original.run_attempt) !== source[2] ||
    original.event !== 'pull_request' ||
    typeof original.path !== 'string' ||
    !isSourceCi(original.path)
  ) {
    throw new Error('Invalid source');
  }
  const pr =
    Array.isArray(original.pull_requests) && original.pull_requests.length === 1
      ? original.pull_requests[0]
      : undefined;
  const targetKnownState = { targetKnown: false };
  if (
    pr !== undefined &&
    isJsonObject(pr) &&
    typeof pr.number === 'number' &&
    Number.isSafeInteger(pr.number) &&
    requireValue(pr.number) > 0 &&
    isJsonObject(pr.head) &&
    sha(pr.head.sha) &&
    isJsonObject(pr.base) &&
    sha(pr.base.sha)
  ) {
    targetKnownState.targetKnown = true;
    lines.push(
      `レビュー対象PR: #${pr.number}`,
      `レビュー対象head SHA: ${pr.head.sha}`,
      `レビュー対象base SHA: ${pr.base.sha}`,
    );
  } else {
    lines.push('レビュー対象SHA: 元CIの記録から特定できません');
    if (sha(original.head_sha)) {
      lines.push(`元CIのhead SHA（レビュー対象とは未照合）: ${original.head_sha}`);
    }
  }
  if (!expected) {
    return {
      output: lines.concat('期待コミット未指定: 修正版の包含は未確認').join('\n'),
      eligible: true,
    };
  }
  lines.push(`期待コミットSHA: ${expected}`);
  const comparison = parseJson(read(`${prefix}/compare/${expected}...${run.head_sha}?per_page=1`));
  if (
    !isJsonObject(comparison) ||
    typeof comparison.status !== 'string' ||
    !['ahead', 'identical', 'behind', 'diverged'].includes(comparison.status)
  ) {
    throw new Error('Invalid comparison');
  }
  const eligible = comparison.status === 'ahead' || comparison.status === 'identical';
  lines.push(
    eligible
      ? '期待コミットを含む実行です（動作の成功は実行結果で確認してください）'
      : '修正版の検証対象外: 実行コードは期待コミットを含みません',
  );
  if (!targetKnownState.targetKnown) {
    lines.push('修正版の検証対象外: レビュー対象を特定できません');
  }
  return { output: lines.join('\n'), eligible: eligible && targetKnownState.targetKnown };
}
