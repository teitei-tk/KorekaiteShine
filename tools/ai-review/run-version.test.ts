import { expect, it } from 'vitest';
import { runVersion } from './run-version.ts';
const code = 'a'.repeat(40),
  head = 'b'.repeat(40),
  base = 'c'.repeat(40),
  expected = 'd'.repeat(40);
function fixture(status = 'ahead') {
  const paths: string[] = [];
  const read = (path: string) => {
    paths.push(path);
    if (path.includes('/compare/')) return JSON.stringify({ status });
    if (path.endsWith('/10/attempts/2'))
      return JSON.stringify({
        id: 10,
        run_attempt: 2,
        event: 'pull_request',
        path: '.github/workflows/docs.yml',
        pull_requests: [{ number: 26, head: { sha: head }, base: { sha: base } }],
      });
    return JSON.stringify({
      id: 20,
      event: 'workflow_run',
      path: '.github/workflows/ai-review.yml',
      head_sha: code,
      display_title: 'AI review / source run 10 attempt 2 / review',
    });
  };
  return { read, paths };
}
it.each(['ahead', 'identical'])('実行コードが期待コミットを含む: %s', (status) => {
  const f = fixture(status);
  const result = runVersion('20', expected, f.read);
  expect(result.eligible).toBe(true);
  expect(result.output).toContain(`実行コードSHA: ${code}`);
  expect(result.output).toContain(`レビュー対象head SHA: ${head}`);
  expect(result.output).toContain(`レビュー対象base SHA: ${base}`);
  expect(f.paths.at(-1)).toContain(`${expected}...${code}`);
});
it.each(['behind', 'diverged'])('旧版または別系統は検証対象外: %s', (status) => {
  const result = runVersion('20', expected, fixture(status).read);
  expect(result.eligible).toBe(false);
  expect(result.output).toContain('修正版の検証対象外');
});
it('期待SHA省略時は包含確認済みと表示せずcompareしない', () => {
  const f = fixture();
  expect(runVersion('20', undefined, f.read).output).toContain('期待コミット未指定');
  expect(f.paths.some((p) => p.includes('/compare/'))).toBe(false);
});
it('不正な入力や外部応答は信用しない', () => {
  expect(() => runVersion('20', 'SECRET', fixture().read)).toThrow();
  expect(() => runVersion('20', expected, () => '{}')).toThrow();
  expect(() => runVersion('20', expected, fixture('SECRET').read)).toThrow();
});
it('元CIのPR情報が消えても実行版の包含判定を表示し、対象SHAは捏造しない', () => {
  const f = fixture();
  const result = runVersion('20', expected, (path) => {
    const body = f.read(path);
    if (!path.endsWith('/10/attempts/2')) return body;
    return JSON.stringify({
      id: 10,
      run_attempt: 2,
      event: 'pull_request',
      path: '.github/workflows/docs.yml',
      head_sha: head,
      pull_requests: [],
    });
  });
  expect(result.output).toContain('期待コミットを含む実行');
  expect(result.output).toContain('レビュー対象SHA: 元CIの記録から特定できません');
  expect(result.output).not.toContain('レビュー対象head SHA:');
  expect(result.eligible).toBe(false);
});
it('別Workflowでは期待版の確認を拒否し、期待版未指定の状態監視は維持する', () => {
  const read = () =>
    JSON.stringify({
      id: 20,
      head_sha: code,
      event: 'pull_request',
      path: '.github/workflows/docs.yml',
    });
  expect(runVersion('20', expected, read).eligible).toBe(false);
  expect(runVersion('20', undefined, read).eligible).toBe(true);
});
