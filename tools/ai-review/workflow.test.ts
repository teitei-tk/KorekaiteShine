import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const workflow = (name: string) =>
  readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), 'utf8');
it('AIレビュー表示を通常CIから独立したPR Workflowにする', () => {
  const monitor = workflow('ai-review-check');
  expect(monitor).toMatch(/^name: AI review\n/);
  expect(monitor).toContain('pull_request:');
  expect(monitor).not.toContain('workflow_run:');
  expect(monitor).toContain('node tools/ai-review/wait-review.ts wait');
  expect(monitor).toContain('node tools/ai-review/wait-review.ts finish');
  expect(workflow('docs')).toMatch(/^name: Documentation checks\n/);
});
it('監視は信頼済みbaseのコードを使い、書き込み・OIDC権限を持たない', () => {
  const monitor = workflow('ai-review-check');
  expect(monitor).toContain('ref: ${{ github.event.pull_request.base.sha }}');
  expect(monitor).toContain('persist-credentials: false');
  expect(monitor).toContain('REVIEW_SINCE: ${{ github.event.pull_request.updated_at }}');
  expect(monitor).toContain('actions: read');
  expect(monitor).toContain('contents: read');
  expect(monitor).toContain('pull-requests: read');
  expect(monitor).not.toMatch(/:\s*write\b|secrets\.|id-token:/);
  expect(monitor).not.toContain('pnpm install');
});
it('モデルと投稿をmainの後続Workflowに残す', () => {
  const backend = workflow('ai-review');
  expect(backend).toContain('workflow_run:');
  expect(backend).toContain('workflows: [Documentation checks]');
  const generate = backend.split('\n  generate:')[1].split('\n  publish:')[0];
  const publish = backend.split('\n  publish:')[1];
  expect(generate).toContain('id-token: write');
  expect(generate).not.toContain('pull-requests: write');
  expect(publish).toContain('pull-requests: write');
  expect(publish).not.toContain('id-token: write');
  expect(backend).not.toContain('checks: write');
});
it('Artifactの取得を監視した実行・試行に固定する', () => {
  const monitor = workflow('ai-review-check');
  expect(monitor).toContain('run-id: ${{ steps.wait.outputs.run }}');
  expect(monitor).toContain(
    'pattern: ai-review-status-${{ steps.wait.outputs.run }}-${{ steps.wait.outputs.attempt }}-*',
  );
  expect(monitor).toContain('REVIEW_REPORT_DOWNLOAD: ${{ steps.reports.outcome }}');
});
it('Draft解除時にも通常CIと監視を同時に起動する', () => {
  for (const name of ['docs', 'ai-review-check'])
    expect(workflow(name)).toContain('types: [opened, synchronize, reopened, ready_for_review]');
});
it('予算結果を投稿ジョブへ渡し、失敗時にも費用記録を保存する', () => {
  const backend = workflow('ai-review');
  expect(backend).toContain('/ai-review-material/budget-result.json');
  expect(backend).toMatch(/name: Preserve review cost record\n\s+if: always\(\)/);
  expect(backend).toContain('name: ai-review-cost-${{ github.run_id }}-${{ github.run_attempt }}');
});
