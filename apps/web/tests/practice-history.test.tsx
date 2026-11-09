// @vitest-environment jsdom
import './helpers/dom';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import { PracticePage } from '../src/routes/practice';

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
              alternatives: axis,
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
            consistency: [],
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
  expect(screen.getAllByText('未確認')).toHaveLength(4);
  const link = screen.getByRole('link', { name: '発言1' });
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
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    if (url === '/api/local-session') {
      return Response.json({ operationToken: 'a'.repeat(64) });
    }
    if (url === '/api/interview-history') {
      return Response.json({ items: removed ? [] : [session], next: null });
    }
    if (init?.method === 'DELETE') {
      expect(new Headers(init.headers).get('X-Interview-Token')).toBe('a'.repeat(64));
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
  expect(await screen.findByText('保存された面接はありません。')).toBeTruthy();
});
