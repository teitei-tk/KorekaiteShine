// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://localhost:4327"}
import './helpers/dom';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import { InterviewPage } from '../src/routes/index';

test('一覧の初回取得中は読み込み状態を表示する', async () => {
  const fetcher = vi.fn(() => new Promise<Response>(() => {}));
  vi.stubGlobal('fetch', fetcher);
  render(<InterviewPage />);
  expect(screen.getByRole('status').textContent).toBe('読み込み中…');
  expect(screen.queryByRole('table')).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
});

const interviewList = {
  items: [
    {
      id: 'first',
      theme: 'Queueを選んだ判断',
      startedAt: '2026-11-03T15:00:00Z',
      materialKind: 'code',
      durationSeconds: 900,
      evaluationStatus: 'waiting',
    },
    {
      id: 'second',
      theme: 'DOで状態を保持',
      startedAt: '2026-11-03T14:00:00Z',
      materialKind: 'experience',
      durationSeconds: 600,
      evaluationStatus: 'failed',
    },
  ],
};

function pendingResponse() {
  let resolve!: (response: Response) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Response>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

test('取得した2件の内容と日本時間・材料・評価状態を表示する', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json(interviewList));
  vi.stubGlobal('fetch', fetcher);
  render(<InterviewPage />);
  await screen.findByText('2件の面接');
  const rows = screen.getAllByRole('row');
  expect(rows).toHaveLength(3);
  expect(rows[1].textContent).toBe('2026/11/4 0:00:00Queueを選んだ判断コード15分評価待ち');
  expect(rows[2].textContent).toBe('2026/11/3 23:00:00DOで状態を保持経験Markdown10分評価失敗');
  const request = fetcher.mock.calls[0]?.[0];
  expect(new Request(request!).url).toBe('http://localhost:4327/api/interviews');
});

test('空の一覧では0件を表示し、データ行やエラーを表示しない', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ items: [] })),
  );
  render(<InterviewPage />);
  await screen.findByText('0件の面接');
  expect(screen.getAllByRole('row')).toHaveLength(1);
  expect(screen.queryByRole('alert')).toBeNull();
});

test('一覧取得のHTTP失敗を読み込み終了後にエラーとして表示する', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 500 })),
  );
  render(<InterviewPage />);
  expect((await screen.findByRole('alert')).textContent).toBe('面接一覧を取得できませんでした。');
  expect(screen.queryByRole('status')).toBeNull();
  expect(screen.queryByRole('table')).toBeNull();
});

test('再取得中は前の一覧を消し、完了後は新しい一覧を表示する', async () => {
  const pending = pendingResponse();
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(interviewList))
    .mockImplementationOnce(() => pending.promise);
  vi.stubGlobal('fetch', fetcher);
  render(<InterviewPage />);
  await screen.findByText('2件の面接');
  await userEvent.click(screen.getByRole('button', { name: '再取得' }));
  expect(screen.getByRole('status').textContent).toBe('読み込み中…');
  expect(screen.queryByRole('table')).toBeNull();
  await act(async () => pending.resolve(Response.json({ items: [] })));
  await screen.findByText('0件の面接');
  expect(fetcher).toHaveBeenCalledTimes(2);
});

test('取得失敗後も再取得でエラーを消し、一覧表示へ復帰する', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockRejectedValueOnce(new TypeError('通信失敗'))
    .mockResolvedValueOnce(Response.json(interviewList));
  vi.stubGlobal('fetch', fetcher);
  render(<InterviewPage />);
  await screen.findByRole('alert');
  await userEvent.click(screen.getByRole('button', { name: '再取得' }));
  await screen.findByText('2件の面接');
  expect(screen.queryByRole('alert')).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(2);
});

test('古い成功応答は再取得した最新の一覧を上書きしない', async () => {
  const old = pendingResponse();
  vi.stubGlobal(
    'fetch',
    vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => old.promise)
      .mockResolvedValueOnce(Response.json({ items: [] })),
  );
  render(<InterviewPage />);
  await userEvent.click(screen.getByRole('button', { name: '再取得' }));
  await screen.findByText('0件の面接');
  await act(async () => old.resolve(Response.json(interviewList)));
  expect(screen.getByRole('status').textContent).toBe('0件の面接');
  expect(screen.queryByText('Queueを選んだ判断')).toBeNull();
});

test('古い失敗応答は再取得した最新の成功をエラーに戻さない', async () => {
  const old = pendingResponse();
  vi.stubGlobal(
    'fetch',
    vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => old.promise)
      .mockResolvedValueOnce(Response.json(interviewList)),
  );
  render(<InterviewPage />);
  await userEvent.click(screen.getByRole('button', { name: '再取得' }));
  await screen.findByText('2件の面接');
  await act(async () => old.reject(new TypeError('古い要求の通信失敗')));
  expect(screen.getByRole('status').textContent).toBe('2件の面接');
  expect(screen.queryByRole('alert')).toBeNull();
});

test('古い成功応答は最新の取得失敗表示を消さない', async () => {
  const old = pendingResponse();
  vi.stubGlobal(
    'fetch',
    vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => old.promise)
      .mockResolvedValueOnce(new Response(null, { status: 500 })),
  );
  render(<InterviewPage />);
  await userEvent.click(screen.getByRole('button', { name: '再取得' }));
  await screen.findByRole('alert');
  await act(async () => old.resolve(Response.json(interviewList)));
  expect(screen.getByRole('alert').textContent).toBe('面接一覧を取得できませんでした。');
  expect(screen.queryByRole('table')).toBeNull();
});

test('アンマウントした画面の応答は新しく表示した画面へ混入しない', async () => {
  const old = pendingResponse();
  vi.stubGlobal(
    'fetch',
    vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => old.promise)
      .mockResolvedValueOnce(Response.json({ items: [] })),
  );
  const first = render(<InterviewPage />);
  first.unmount();
  render(<InterviewPage />);
  await screen.findByText('0件の面接');
  await act(async () => old.resolve(Response.json(interviewList)));
  expect(screen.getByRole('status').textContent).toBe('0件の面接');
  expect(screen.getAllByRole('table')).toHaveLength(1);
});
