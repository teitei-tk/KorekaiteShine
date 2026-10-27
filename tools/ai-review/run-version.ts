import { execFileSync } from 'node:child_process';
import { REPOSITORY } from './policy.ts';
interface RunInput {
  id?: number;
  run_attempt?: number;
  event?: string;
  path?: string;
  head_sha?: string;
  display_title?: string;
  pull_requests?: { number?: number; head?: { sha?: string }; base?: { sha?: string } }[];
}
const sha = (value: string | undefined): value is string =>
  typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
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
  if (!/^[1-9]\d{0,17}$/.test(id) || (expected !== undefined && !sha(expected)))
    throw new Error('Invalid input');
  const prefix = `repos/${REPOSITORY}`;
  const run: RunInput | null = JSON.parse(read(`${prefix}/actions/runs/${id}`));
  if (!run || String(run.id) !== id || !sha(run.head_sha)) throw new Error('Invalid run');
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
    /^AI review \/ source run ([1-9]\d{0,17}) attempt ([1-9]\d{0,5}) \/ (review|claims)$/.exec(
      run.display_title ?? '',
    );
  if (!source) throw new Error('Invalid source');
  const original: RunInput | null = JSON.parse(
    read(`${prefix}/actions/runs/${source[1]}/attempts/${source[2]}`),
  );
  if (
    !original ||
    String(original.id) !== source[1] ||
    String(original.run_attempt) !== source[2] ||
    original.event !== 'pull_request' ||
    original.path !== '.github/workflows/docs.yml'
  )
    throw new Error('Invalid source');
  const pr =
    Array.isArray(original.pull_requests) && original.pull_requests.length === 1
      ? original.pull_requests[0]
      : undefined;
  let targetKnown = false;
  if (
    pr &&
    Number.isSafeInteger(pr.number) &&
    pr.number! > 0 &&
    sha(pr.head?.sha) &&
    sha(pr.base?.sha)
  ) {
    targetKnown = true;
    lines.push(
      `レビュー対象PR: #${pr.number}`,
      `レビュー対象head SHA: ${pr.head.sha}`,
      `レビュー対象base SHA: ${pr.base.sha}`,
    );
  } else {
    lines.push('レビュー対象SHA: 元CIの記録から特定できません');
    if (sha(original.head_sha))
      lines.push(`元CIのhead SHA（レビュー対象とは未照合）: ${original.head_sha}`);
  }
  if (!expected)
    return {
      output: lines.concat('期待コミット未指定: 修正版の包含は未確認').join('\n'),
      eligible: true,
    };
  lines.push(`期待コミットSHA: ${expected}`);
  const comparison: { status?: string } | null = JSON.parse(
    read(`${prefix}/compare/${expected}...${run.head_sha}?per_page=1`),
  );
  if (
    !comparison ||
    !['ahead', 'identical', 'behind', 'diverged'].includes(comparison.status ?? '')
  )
    throw new Error('Invalid comparison');
  const eligible = comparison.status === 'ahead' || comparison.status === 'identical';
  lines.push(
    eligible
      ? '期待コミットを含む実行です（動作の成功は実行結果で確認してください）'
      : '修正版の検証対象外: 実行コードは期待コミットを含みません',
  );
  if (!targetKnown) lines.push('修正版の検証対象外: レビュー対象を特定できません');
  return { output: lines.join('\n'), eligible: eligible && targetKnown };
}
