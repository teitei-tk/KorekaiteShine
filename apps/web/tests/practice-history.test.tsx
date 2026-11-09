// @vitest-environment jsdom
import './helpers/dom';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import { PracticePage } from '../src/routes/practice';
import { PracticeHistory, PracticeRecord } from '../src/components/practice-record';

test('履歴から保存済みの五軸評価を開き、引用から元の発言と材料を参照できる', async () => {
  const user = userEvent.setup();
  const session = {
    interviewId: 'one',
    status: 'ended',
    theme: '構成の判断',
    createdAt: 10,
    activeMs: 2500,
  };
  const axis = { status: 'unconfirmed', score: null, reason: '質問していません。', evidence: [] };
  const evidence = { source: 'transcript', fragmentIds: ['fragment-one'], quote: '比較しました。' };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url) => {
      if (url === '/api/local-session') {
        return Response.json({ operationToken: 'a'.repeat(64) });
      }
      if (url === '/api/interview-history') {
        return Response.json({ items: [session], next: null });
      }
      expect(url).toBe('/api/interviews/one');
      return Response.json({
        session,
        material: { title: '構成の判断', heading: '構成', excerpt: '架空の経験' },
        background: '',
        transcriptIncomplete: true,
        transcripts: [
          {
            fragmentId: 'fragment-one',
            sequence: 1,
            generation: 1,
            speaker: 'user',
            content: '比較しました。',
            sourceStartMs: null,
            sourceEndMs: null,
            receivedAt: 10,
          },
        ],
        playback: [{ generation: 1, audioOffsetMs: 2500, receivedAt: 10 }],
        evaluation: {
          jobId: 'job',
          status: 'completed',
          attemptCount: 1,
          nextAttemptAt: null,
          lastErrorCode: null,
          result: {
            summary: '選択肢を比較した。',
            axes: {
              problem: {
                status: 'scored',
                score: 3,
                reason: '制約を説明した。',
                evidence: [evidence],
              },
              alternatives: { ...axis, status: 'not_applicable' },
              reasoning: axis,
              action: axis,
              learning: axis,
            },
            strengths: [
              {
                text: '判断を説明できた。',
                evidence: [{ source: 'material', fragmentIds: [], quote: '架空の経験' }],
              },
            ],
            gaps: [],
            unconfirmed: [],
            practiceQuestions: [],
            consistency: ['resolved', 'needs_confirmation'].map((status) => ({
              status,
              first: evidence,
              second: { ...evidence, fragmentIds: ['missing'] },
              explanation: '比較の根拠',
            })),
          },
        },
      });
    }),
  );
  render(<PracticePage />);
  await user.click(await screen.findByRole('button', { name: '構成の判断' }));
  await screen.findByText('選択肢を比較した。');
  expect(screen.getByText('3 / 5')).toBeTruthy();
  expect(screen.getByText('音声接続 1 で2.5秒まで再生済み')).toBeTruthy();
  expect(screen.getAllByText('未確認')).toHaveLength(3);
  expect(screen.getByText('対象外')).toBeTruthy();
  expect(screen.getByText('確認済み')).toBeTruthy();
  expect(screen.getByText('要確認')).toBeTruthy();
  const link = screen.getAllByRole('link', { name: '発言1' })[0];
  expect(document.getElementById(link.getAttribute('href')!.slice(1))?.textContent).toContain(
    '比較しました。',
  );
  expect(screen.getByRole('link', { name: '材料の抜粋' }).getAttribute('href')).toBe(
    '#interview-material',
  );
  expect(screen.getByText('文字起こしが一部欠けている可能性があります。')).toBeTruthy();
});

test('削除対象のテーマを確認し、キャンセル時は記録を保持し、削除完了後は履歴へ戻る', async () => {
  const user = userEvent.setup();
  const session = {
    interviewId: 'one',
    status: 'ended',
    theme: '架空の選択',
    createdAt: 0,
    activeMs: 1,
  };
  let removed = false;
  let deleteAttempts = 0;
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    if (url === '/api/local-session') {
      return Response.json({ operationToken: 'a'.repeat(64) });
    }
    if (url === '/api/interview-history') {
      return Response.json({ items: removed ? [] : [session], next: null });
    }
    if (init?.method === 'DELETE') {
      expect(new Headers(init.headers).get('X-Interview-Token')).toBe('a'.repeat(64));
      if (++deleteAttempts === 1) {
        return new Response(null, { status: 503 });
      }
      removed = true;
      return new Response(null, { status: 204 });
    }
    return Response.json({
      session,
      material: { title: 'テーマ', heading: '本文', excerpt: '架空' },
      background: '',
      transcriptIncomplete: false,
      transcripts: [],
      playback: [],
      evaluation: null,
    });
  });
  vi.stubGlobal('fetch', fetcher);
  render(<PracticePage />);
  await user.click(await screen.findByRole('button', { name: '架空の選択' }));
  await user.click(await screen.findByRole('button', { name: '記録の削除' }));
  expect(screen.getByText(/「架空の選択」の会話/)).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'キャンセル' }));
  expect(removed).toBe(false);
  await user.click(screen.getByRole('button', { name: '記録の削除' }));
  await user.click(screen.getByRole('button', { name: 'この面接を削除する' }));
  expect((await screen.findByRole('alert')).textContent).toMatch(/削除の完了/);
  await user.click(screen.getByRole('button', { name: 'この面接を削除する' }));
  expect(await screen.findByText('保存された面接はありません。')).toBeTruthy();
});

test('履歴のエラーから復帰し、前後のページを表示する', async () => {
  const user = userEvent.setup();
  let calls = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/local-session') {
        return Response.json({ operationToken: 'a'.repeat(64) });
      }
      calls++;
      if (calls === 1) {
        throw 'offline';
      }
      if (calls === 2) {
        throw new Error('サーバー停止中');
      }
      return Response.json({
        items: [],
        next: url.includes('?') ? null : { createdAt: 1, interviewId: 'one' },
      });
    }),
  );
  render(<PracticePage />);
  expect((await screen.findByRole('alert')).textContent).toContain('履歴を取得できません');
  await user.click(screen.getByRole('button', { name: '再取得' }));
  expect((await screen.findByRole('alert')).textContent).toContain('サーバー停止中');
  await user.click(screen.getByRole('button', { name: '再取得' }));
  await user.click(await screen.findByRole('button', { name: '以前の面接を見る' }));
  await user.click(await screen.findByRole('button', { name: '最新の履歴へ' }));
  expect(await screen.findByRole('button', { name: '以前の面接を見る' })).toBeTruthy();
});

test('詳細を再取得し、失敗した評価を手動再試行して次の試行日時を表示する', async () => {
  const user = userEvent.setup();
  const session = {
    interviewId: 'one',
    status: 'ended',
    theme: '保存された面接',
    createdAt: 10,
    activeMs: 2500,
  };
  let fetched = 0;
  let attempts = 0;
  const jobId = '00000000-0000-4000-8000-000000000001';
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, init) => {
      if (url === '/api/local-session') {
        return Response.json({ operationToken: 'a'.repeat(64) });
      }
      if (url === '/api/interview-history') {
        return Response.json({ items: [session], next: null });
      }
      if (init?.method === 'POST') {
        attempts++;
        if (attempts === 1) {
          throw 'offline';
        }
        if (attempts === 2) {
          throw new Error('再評価に失敗しました');
        }
        return Response.json({ jobId });
      }
      fetched++;
      if (fetched === 1) {
        throw 'offline';
      }
      if (fetched === 2) {
        throw new Error('詳細の取得失敗');
      }
      return Response.json({
        session,
        material: { title: '構成', heading: '判断', excerpt: '内容' },
        background: '担当',
        audioRemainingMs: 60000,
        transcriptIncomplete: false,
        transcripts: [],
        playback: [],
        evaluation: {
          jobId,
          status: fetched === 5 ? 'retry_wait' : 'failed',
          attemptCount: 1,
          nextAttemptAt: fetched === 5 ? 100 : null,
          lastErrorCode: fetched === 3 ? null : 'AI_TIMEOUT',
          result: null,
        },
      });
    }),
  );
  render(<PracticePage />);
  await user.click(await screen.findByRole('button', { name: session.theme }));
  expect((await screen.findByRole('alert')).textContent).toContain('記録を取得できません');
  const refresh = screen.getByRole('button', { name: '記録を更新' });
  await user.click(refresh);
  expect((await screen.findByRole('alert')).textContent).toContain('詳細の取得失敗');
  await user.click(refresh);
  expect(await screen.findByText(/評価を完了できません/)).toBeTruthy();
  await user.click(refresh);
  expect(await screen.findByText(/評価の応答が制限時間/)).toBeTruthy();
  const retry = screen.getByRole('button', { name: '同じ条件で再評価する' });
  await user.click(retry);
  expect((await screen.findByRole('alert')).textContent).toContain('再評価を受け付けられません');
  await user.click(retry);
  expect((await screen.findByRole('alert')).textContent).toContain('再評価に失敗');
  await user.click(retry);
  expect(await screen.findByText(/次の試行/)).toBeTruthy();
  await user.click(screen.getByRole('button', { name: '準備と履歴へ戻る' }));
  expect(await screen.findByRole('button', { name: session.theme })).toBeTruthy();
});

test.each(['履歴', '詳細'])('%sの読取中に画面を閉じた後の成功と失敗を破棄する', async (kind) => {
  for (const succeeds of [true, false]) {
    let resolve!: (result: Response) => void;
    let reject!: () => void;
    const pending = new Promise<Response>((ok, no) => {
      resolve = ok;
      reject = no;
    });
    let signal: AbortSignal | undefined;
    const session = {
      interviewId: 'one',
      theme: '面接',
      status: 'ended',
      createdAt: 10,
      activeMs: 100,
    };
    const detail = {
      session,
      material: { title: '題', heading: '見出し', excerpt: '引用' },
      background: '',
      transcriptIncomplete: false,
      transcripts: [],
      playback: [],
      evaluation: null,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, init) => {
        if (url === '/api/local-session') {
          return Response.json({ operationToken: 'a'.repeat(64) });
        }
        signal = init.signal;
        return pending;
      }),
    );
    const page =
      kind === '履歴'
        ? render(<PracticeHistory onOpen={vi.fn()} />)
        : render(<PracticeRecord id="one" onDeleted={vi.fn()} />);
    await waitFor(() => expect(signal).toBeDefined());
    page.unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      if (succeeds) {
        resolve(Response.json(kind === '履歴' ? { items: [], next: null } : detail));
      } else {
        reject();
      }
    });
    expect(screen.queryByRole('alert')).toBeNull();
  }
});
