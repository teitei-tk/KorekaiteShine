import { execFileSync } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { checkSettings } from './check-settings.ts';
import { checkRun, runSnapshot } from './check-run.ts';
import { waitReview } from './wait-review.ts';
import { apiFixture } from './tests/helpers/api.ts';
import type { Api } from './github.ts';

it('レビュー監視の既定時計は15秒待機後に対象変更を検出して終了する', async () => {
  const fixture = apiFixture();
  const readsState = { reads: 0 };
  const api: Api = async <T>(path: string) => {
    if (path === 'pulls/7') {
      return { ...fixture.pr, state: ++readsState.reads === 1 ? 'open' : 'closed' } as T;
    }
    return { workflow_runs: [] } as T;
  };
  const result = await waitReview(api, {
    number: 7,
    head: fixture.pr.head.sha,
    base: fixture.pr.base.sha,
    since: '2026-11-08T00:00:00Z',
  });
  expect(result).toEqual({ status: 'failure', target: 'gate', reason: 'TARGET_CHANGED' });
  expect(setTimeout).toHaveBeenCalledExactlyOnceWith(15_000);
});

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
vi.mock('node:timers/promises', () => ({ setTimeout: vi.fn(async () => {}) }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

it('名前のないジョブは固定番号で表示し正常な未知ステップ名は省略する', async () => {
  const result = runSnapshot(
    JSON.stringify({
      status: 'completed',
      conclusion: 'success',
      jobs: [
        {
          status: 'completed',
          conclusion: 'success',
          steps: [{ status: 'completed', conclusion: 'success' }],
        },
      ],
    }),
  );
  expect(result.output).toBe('実行: completed / success\njob 1: completed / success');
});

it('ステップがオブジェクトでなければ成功状態でも応答を拒否する', async () => {
  expect(() =>
    runSnapshot(
      JSON.stringify({
        status: 'completed',
        conclusion: 'success',
        jobs: [{ status: 'completed', conclusion: 'success', steps: [null] }],
      }),
    ),
  ).toThrow('Invalid step');
});

it('ジョブ一覧の要素にsteps配列がなければ応答を拒否する', async () => {
  expect(() =>
    runSnapshot(
      JSON.stringify({ status: 'completed', conclusion: 'success', jobs: [{ steps: {} }] }),
    ),
  ).toThrow('Invalid job');
});

it('監視は既定の15秒間隔で状態を再取得し完了したら待機を終える', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const readsState = { reads: 0 };
  const read = () =>
    JSON.stringify({
      status: ++readsState.reads === 1 ? 'in_progress' : 'completed',
      conclusion: readsState.reads === 1 ? '' : 'success',
      jobs: [],
    });
  expect(await checkRun('7', true, read)).toBe(0);
  expect(setTimeout).toHaveBeenCalledExactlyOnceWith(15_000);
  expect(log).toHaveBeenCalledWith('実行: completed / success');
});

it('設定確認の既定取得先は値を表示せずghの固定引数で取得する', () => {
  vi.mocked(execFileSync).mockReturnValue('[]');
  expect(checkSettings()).toMatchObject({ ok: false });
  expect(execFileSync).toHaveBeenCalledWith(
    'gh',
    ['variable', 'list', '--repo', 'teitei-tk/KorekaiteShine', '--json', 'name,value'],
    expect.objectContaining({ timeout: 30_000 }),
  );
});
