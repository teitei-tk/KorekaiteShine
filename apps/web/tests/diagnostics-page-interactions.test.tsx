// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://localhost:4327"}
import './helpers/dom';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import { DiagnosticPage } from '../src/diagnostics/page';

const jobId = 'de82593e-01ef-4871-80e2-a8b8ba46ae95';
const accepted = { jobId, scenario: 'success', acceptedAt: '2026-11-03T00:00:00.000Z' };
const completed = {
  ...accepted,
  status: 'completed',
  attemptCount: 1,
  updatedAt: '2026-11-03T00:00:01.000Z',
  finishedAt: '2026-11-03T00:00:01.000Z',
  nextAttemptAt: null,
  lastErrorCode: null,
  checks: { doPersistence: 'passed', consumerCompletion: 'passed', dlqReceipt: 'not_expected' },
};
function pendingResponse() {
  return Promise.withResolvers<Response>();
}
const start = () => screen.getByRole<HTMLButtonElement>('button', { name: '新しい実行を開始' });
const resend = () => screen.getByRole<HTMLButtonElement>('button', { name: '同じ実行を再送' });
const refresh = () => screen.getByRole<HTMLButtonElement>('button', { name: '状態を再取得' });

test('初期化後は新規開始だけを許可し、受付前には状態を取得しない', async () => {
  const fetcher = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetcher);
  render(<DiagnosticPage />);
  expect(start().disabled).toBe(false);
  expect(resend().disabled).toBe(true);
  expect(refresh().disabled).toBe(true);
  expect(screen.getByRole<HTMLSelectElement>('combobox').disabled).toBe(false);
  await userEvent.click(refresh());
  expect(fetcher).not.toHaveBeenCalled();
});

test('選択したシナリオを送信し、受付結果を表示する', async () => {
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json({ ...accepted, scenario: 'retry_then_success' }, { status: 202 }),
  );
  vi.stubGlobal('fetch', fetcher);
  render(<DiagnosticPage />);
  await userEvent.selectOptions(screen.getByRole('combobox'), 'retry_then_success');
  await userEvent.click(start());
  const section = await screen.findByRole('region', { name: '受付結果' });
  expect(section.textContent).toContain(jobId);
  expect(section.textContent).toContain('一度失敗してから成功');
  const request = new Request(fetcher.mock.calls[0]![0]);
  expect(request.method).toBe('POST');
  expect(request.url).toBe('http://localhost:4327/api/diagnostics/check-jobs');
  expect(await request.json()).toEqual({ scenario: 'retry_then_success' });
  expect(request.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/u);
  expect(refresh().disabled).toBe(false);
  expect(resend().disabled).toBe(true);
});

test('応答消失後の再送は選択変更前のシナリオとキーを保持する', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockRejectedValueOnce(new TypeError('応答消失'))
    .mockResolvedValueOnce(Response.json(accepted, { status: 202 }));
  vi.stubGlobal('fetch', fetcher);
  render(<DiagnosticPage />);
  await userEvent.click(start());
  await screen.findByRole('alert');
  await userEvent.selectOptions(screen.getByRole('combobox'), 'exhaust_retries');
  await userEvent.click(resend());
  await screen.findByRole('region', { name: '受付結果' });
  const requests = fetcher.mock.calls.map(([input]) => new Request(input));
  expect(requests).toHaveLength(2);
  expect(await requests[0]!.json()).toEqual({ scenario: 'success' });
  expect(await requests[1]!.json()).toEqual({ scenario: 'success' });
  expect(requests[1]!.headers.get('Idempotency-Key')).toBe(
    requests[0]!.headers.get('Idempotency-Key'),
  );
  expect(screen.queryByRole('alert')).toBeNull();
});

test('新しい実行は変更後のシナリオと別の冪等キーを送る', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockRejectedValueOnce(new TypeError('応答消失'))
    .mockResolvedValueOnce(
      Response.json({ ...accepted, scenario: 'exhaust_retries' }, { status: 202 }),
    );
  vi.stubGlobal('fetch', fetcher);
  render(<DiagnosticPage />);
  await userEvent.click(start());
  await screen.findByRole('alert');
  await userEvent.selectOptions(screen.getByRole('combobox'), 'exhaust_retries');
  await userEvent.click(start());
  await screen.findByRole('region', { name: '受付結果' });
  const requests = fetcher.mock.calls.map(([input]) => new Request(input));
  expect(requests).toHaveLength(2);
  expect(await requests[1]!.json()).toEqual({ scenario: 'exhaust_retries' });
  expect(requests[1]!.headers.get('Idempotency-Key')).not.toBe(
    requests[0]!.headers.get('Idempotency-Key'),
  );
});

test('送信中の操作を無効にし、再描画前の連打でも要求を一つに保つ', async () => {
  const pending = pendingResponse();
  const fetcher = vi.fn<typeof fetch>(() => pending.promise);
  vi.stubGlobal('fetch', fetcher);
  render(<DiagnosticPage />);
  act(() => {
    start().click();
    start().click();
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(start().disabled).toBe(true);
  expect(resend().disabled).toBe(true);
  expect(refresh().disabled).toBe(true);
  expect(screen.getByRole<HTMLSelectElement>('combobox').disabled).toBe(true);
  expect(screen.getByRole('status').textContent).toBe('通信中…');
  await act(async () => pending.resolve(Response.json(accepted, { status: 202 })));
  expect(start().disabled).toBe(false);
});

test('状態取得は受付したjobIdへ一度だけ送信し、取得中の操作を無効にする', async () => {
  const pending = pendingResponse();
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(accepted, { status: 202 }))
    .mockImplementationOnce(() => pending.promise);
  vi.stubGlobal('fetch', fetcher);
  render(<DiagnosticPage />);
  await userEvent.click(start());
  await screen.findByRole('region', { name: '受付結果' });
  act(() => {
    refresh().click();
    refresh().click();
  });
  expect(fetcher).toHaveBeenCalledTimes(2);
  const request = new Request(fetcher.mock.calls[1]![0]);
  expect(request.method).toBe('GET');
  expect(request.url).toBe(`http://localhost:4327/api/diagnostics/check-jobs/${jobId}`);
  expect(start().disabled).toBe(true);
  expect(refresh().disabled).toBe(true);
  expect(resend().disabled).toBe(true);
  expect(screen.getByRole<HTMLSelectElement>('combobox').disabled).toBe(true);
  await act(async () => pending.resolve(Response.json(completed)));
  expect(
    within(screen.getByRole('region', { name: '診断結果' })).getByRole('status').textContent,
  ).toBe('正常完了');
});

test('ジョブ失敗はHTTPエラーではなく診断結果として表示する', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json({ ...accepted, scenario: 'exhaust_retries' }, { status: 202 }),
    )
    .mockResolvedValueOnce(
      Response.json({
        ...completed,
        scenario: 'exhaust_retries',
        status: 'failed',
        attemptCount: 4,
        lastErrorCode: 'AI_TEMPORARY',
        checks: {
          doPersistence: 'passed',
          consumerCompletion: 'not_expected',
          dlqReceipt: 'pending',
        },
      }),
    );
  vi.stubGlobal('fetch', fetcher);
  render(<DiagnosticPage />);
  await userEvent.click(start());
  await screen.findByRole('region', { name: '受付結果' });
  await userEvent.click(refresh());
  const result = await screen.findByRole('region', { name: '診断結果' });
  expect(within(result).getByRole('status').textContent).toBe('ジョブ失敗');
  expect(result.textContent).toContain('AI_TEMPORARY');
  expect(result.textContent).toContain('未確認');
  expect(screen.queryByRole('alert')).toBeNull();
});

test('状態取得のHTTP失敗後も再取得で正常結果へ復帰する', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(accepted, { status: 202 }))
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(Response.json(completed));
  vi.stubGlobal('fetch', fetcher);
  render(<DiagnosticPage />);
  await userEvent.click(start());
  await screen.findByRole('region', { name: '受付結果' });
  await userEvent.click(refresh());
  await screen.findByRole('alert');
  expect(screen.queryByRole('region', { name: '診断結果' })).toBeNull();
  await userEvent.click(refresh());
  const result = await screen.findByRole('region', { name: '診断結果' });
  expect(within(result).getByRole('status').textContent).toBe('正常完了');
  expect(screen.queryByRole('alert')).toBeNull();
});

test('状態取得の契約外応答後も再取得で正常結果へ復帰する', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(accepted, { status: 202 }))
    .mockResolvedValueOnce(Response.json({ status: 'completed' }))
    .mockResolvedValueOnce(Response.json(completed));
  vi.stubGlobal('fetch', fetcher);
  render(<DiagnosticPage />);
  await userEvent.click(start());
  await screen.findByRole('region', { name: '受付結果' });
  await userEvent.click(refresh());
  await screen.findByRole('alert');
  expect(screen.queryByRole('region', { name: '診断結果' })).toBeNull();
  await userEvent.click(refresh());
  const result = await screen.findByRole('region', { name: '診断結果' });
  expect(within(result).getByRole('status').textContent).toBe('正常完了');
  expect(screen.queryByRole('alert')).toBeNull();
});

test('入力検証エラーは項目のcodeとpathと要求IDを表示する', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async () =>
      Response.json(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: '説明文',
            requestId: jobId,
            details: [
              { location: 'body', path: '/scenario', code: 'INVALID_VALUE', message: '任意の説明' },
            ],
          },
        },
        { status: 400 },
      ),
    ),
  );
  render(<DiagnosticPage />);
  await userEvent.click(start());
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('body/scenario: INVALID_VALUE');
  expect(alert.textContent).toContain(jobId);
  expect(screen.queryByRole('region', { name: '受付結果' })).toBeNull();
});

test('新規開始中は前回の受付と診断結果を消す', async () => {
  const pending = pendingResponse();
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(accepted, { status: 202 }))
    .mockResolvedValueOnce(Response.json(completed))
    .mockImplementationOnce(() => pending.promise);
  vi.stubGlobal('fetch', fetcher);
  render(<DiagnosticPage />);
  await userEvent.click(start());
  await screen.findByRole('region', { name: '受付結果' });
  await userEvent.click(refresh());
  await screen.findByRole('region', { name: '診断結果' });
  await userEvent.click(start());
  expect(screen.queryByRole('region', { name: '受付結果' })).toBeNull();
  expect(screen.queryByRole('region', { name: '診断結果' })).toBeNull();
  await act(async () => pending.resolve(Response.json(accepted, { status: 202 })));
  expect(screen.queryByRole('region', { name: '診断結果' })).toBeNull();
});

test('許可外のシナリオ変更を受けても最後の有効な選択だけを送信する', async () => {
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json({ ...accepted, scenario: 'retry_then_success' }, { status: 202 }),
  );
  vi.stubGlobal('fetch', fetcher);
  render(<DiagnosticPage />);
  const select = screen.getByRole<HTMLSelectElement>('combobox');
  await userEvent.selectOptions(select, 'retry_then_success');
  fireEvent.change(select, { target: { value: 'not-a-scenario' } });
  expect(select.value).toBe('retry_then_success');
  await userEvent.click(start());
  await screen.findByRole('region', { name: '受付結果' });
  expect(fetcher).toHaveBeenCalledOnce();
  expect(await new Request(fetcher.mock.calls[0]![0]).json()).toEqual({
    scenario: 'retry_then_success',
  });
});

test('実行情報の作成に失敗した場合は要求を送らず、再送も許可しない', async () => {
  const fetcher = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetcher);
  const newId = vi.spyOn(crypto, 'randomUUID').mockImplementationOnce(() => {
    throw new Error('識別子を作成できません');
  });
  render(<DiagnosticPage />);
  await userEvent.click(start());
  expect((await screen.findByRole('alert')).textContent).toContain('受付結果を確認できません');
  expect(resend().disabled).toBe(true);
  await userEvent.click(resend());
  expect(newId).toHaveBeenCalledOnce();
  expect(fetcher).not.toHaveBeenCalled();
});
