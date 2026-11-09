// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://localhost/"}
import './helpers/dom';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import { PracticePage } from '../src/routes/practice';

test('準備した面接へ移動し、HTTPSで接続して終了通知から記録を読み直す', async () => {
  const user = userEvent.setup();
  const peers: Peer[] = [];
  class Peer {
    onmessage!: (event: MessageEvent) => void;
    close = vi.fn();
    constructor(readonly url: URL) {
      peers.push(this);
    }
  }
  vi.stubGlobal('WebSocket', Peer);
  const session = { interviewId: 'one', theme: '選択', status: 'ready', createdAt: 1, activeMs: 0 };
  const theme = { title: '選択', heading: '本文', excerpt: '架空' };
  let ended = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url) => {
      switch (url) {
        case '/api/local-session':
          return Response.json({ operationToken: 'a'.repeat(64) });
        case '/api/materials/analyze':
          return Response.json({ analysisId: 'saved', themes: [theme] });
        case '/api/interview-history':
          return Response.json({ items: [], next: null });
        case '/api/interviews':
          return Response.json(session);
        case '/api/interviews/one':
          return Response.json({
            session: { ...session, status: ended ? 'ended' : 'ready' },
            material: theme,
            background: '',
            transcriptIncomplete: false,
            transcripts: [
              {
                fragmentId: 'f1',
                sequence: 1,
                generation: 1,
                speaker: 'assistant',
                content: '質問',
                sourceStartMs: null,
                sourceEndMs: null,
                receivedAt: 1,
              },
            ],
            playback: [],
            evaluation: null,
          });
        default:
          throw new Error(String(url));
      }
    }),
  );
  render(<PracticePage />);
  await user.type(screen.getByLabelText('経験Markdownの内容'), '架空');
  await user.click(screen.getByRole('checkbox'));
  await user.click(screen.getByRole('button', { name: 'テーマを分析する' }));
  await user.click(await screen.findByRole('radio', { name: '選択' }));
  await user.click(screen.getByRole('button', { name: '面接を準備する' }));
  expect(await screen.findByRole('heading', { name: '音声面接' })).toBeTruthy();
  await waitFor(() => expect(peers).toHaveLength(1));
  const [socket] = peers;
  expect(socket.url.protocol).toBe('wss:');
  ended = true;
  await act(async () =>
    socket.onmessage(
      new MessageEvent('message', {
        data: JSON.stringify({
          type: 'state',
          interviewId: 'one',
          generation: 1,
          status: 'ended',
          canControl: false,
          activeMs: 0,
          activeSince: null,
          deadline: null,
          updatedAt: 2,
          transcriptIncomplete: false,
          evaluationJobId: null,
        }),
      }),
    ),
  );
  expect(await screen.findByText(/終了 · 面接時間/)).toBeTruthy();
  expect(screen.getByText('面接官')).toBeTruthy();
});
