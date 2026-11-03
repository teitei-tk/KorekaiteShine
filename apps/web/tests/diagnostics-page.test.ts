import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { DiagnosticPage, DiagnosticResult } from '../src/diagnostics/page';

test('初期化前はシナリオ選択と全操作を無効にし、表示と送信の不一致を防ぐ', () => {
  const html = renderToStaticMarkup(createElement(DiagnosticPage));
  expect(html).toContain('value="success"');
  expect(html).toContain('value="retry_then_success"');
  expect(html).toContain('value="exhaust_retries"');
  expect(html).toMatch(/<select[^>]*disabled=""/);
  expect(html).toMatch(/<button type="button" disabled="">新しい実行を開始<\/button>/);
  expect(html).toMatch(/<button type="button" disabled="">同じ実行を再送<\/button>/);
  expect(html).toMatch(/<button type="button" disabled="">状態を再取得<\/button>/);
});

test('失敗確定後もDLQの受信を待ち、3つの観測結果を独立して表示する', () => {
  const html = renderToStaticMarkup(
    createElement(DiagnosticResult, {
      result: {
        jobId: 'de82593e-01ef-4871-80e2-a8b8ba46ae95',
        scenario: 'exhaust_retries',
        status: 'failed',
        attemptCount: 4,
        acceptedAt: '2026-11-03T00:00:00.000Z',
        updatedAt: '2026-11-03T00:08:00.000Z',
        finishedAt: '2026-11-03T00:08:00.000Z',
        nextAttemptAt: null,
        lastErrorCode: 'AI_TEMPORARY',
        checks: {
          doPersistence: 'passed',
          consumerCompletion: 'not_expected',
          dlqReceipt: 'pending',
        },
      },
    }),
  );
  expect(html).toContain('ジョブ失敗');
  expect(html).toMatch(/DO保存<\/dt><dd>確認済み/);
  expect(html).toMatch(/Consumer正常完了<\/dt><dd>対象外/);
  expect(html).toMatch(/DLQ受信<\/dt><dd>未確認/);
  expect(html).not.toContain('role="alert"');
});
