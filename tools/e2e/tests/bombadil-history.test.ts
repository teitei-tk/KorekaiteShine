import { requireValue } from '../bombadil/required.ts';
import { expect, test } from 'vitest';
import { historyIssues } from '../bombadil/history-model.ts';
import type { HistoryObservation } from '../bombadil/history-model.ts';
import { createFixtures } from '../bombadil/fixtures.ts';
test('削除取消の検証完了までDELETEを許さず、取消後の記録消失も検出する', () => {
  const valid: HistoryObservation = {
    detail: null,
    listedIds: null,
    requests: [{ method: 'GET', id: 'fixture-a', started: 3, finished: 4, status: 200 }],
    cancellations: [{ id: 'fixture-a', opened: 1, cancelled: 2, checkedAt: 5 }],
  };
  expect(historyIssues(valid)).toEqual([]);
  for (const id of ['fixture-a', 'fixture-b']) {
    for (const status of [204, 503]) {
      expect(
        historyIssues({
          ...valid,
          requests: [...valid.requests, { method: 'DELETE', id, started: 3, finished: 4, status }],
        }),
      ).toContain('delete-during-cancellation');
    }
  }
  expect(
    historyIssues({ ...valid, requests: [{ ...requireValue(valid.requests[0]), status: 404 }] }),
  ).toContain('cancelled-record-missing');
  expect(
    historyIssues({
      ...valid,
      requests: [
        ...valid.requests,
        {
          method: 'DELETE',
          id: 'fixture-b',
          confirmedId: 'fixture-b',
          started: 6,
          finished: 7,
          status: 204,
        },
      ],
    }),
  ).toEqual([]);
  expect(
    historyIssues({
      ...valid,
      cancellations: [{ ...requireValue(valid.cancellations[0]), checkedAt: null }],
      requests: [{ ...requireValue(valid.requests[0]), finished: null, status: null }],
    }),
  ).toEqual([]);
});
test('選択した面接のテーマ・発言・評価に別の面接の内容を混ぜない', () => {
  const fixtures = createFixtures('00000000-0000-4000-8000-000000000001');
  const [a, b] = fixtures.interviews;
  const valid: HistoryObservation = {
    listedIds: null,
    requests: [],
    cancellations: [],
    detail: {
      selectedId: requireValue(a).id,
      theme: requireValue(a).theme,
      statements: [requireValue(a).statement],
      summary: requireValue(a).summary,
    },
  };
  expect(historyIssues(valid, fixtures)).toEqual([]);
  for (const mixed of [
    { theme: requireValue(b).theme },
    { statements: [requireValue(b).statement] },
    { statements: [requireValue(a).statement, requireValue(b).statement] },
    { summary: requireValue(b).summary },
    { selectedId: requireValue(b).id },
  ]) {
    expect(
      historyIssues({ ...valid, detail: { ...requireValue(valid.detail), ...mixed } }, fixtures),
    ).toContain('mixed-interview-detail');
  }
  expect(
    historyIssues(
      { ...valid, detail: { ...requireValue(valid.detail), selectedId: 'not-in-fixtures' } },
      fixtures,
    ),
  ).toContain('unknown-interview');
  expect(historyIssues({ ...valid, detail: null }, fixtures)).toEqual([]);
});
test('DELETE成功後の再取得と表示から消失を確認し、失敗や古い取得は成功と混同しない', () => {
  const fixtures = createFixtures('00000000-0000-4000-8000-000000000001');
  const a = requireValue(fixtures.interviews[0]);
  const deletion = {
    method: 'DELETE' as const,
    id: a.id,
    confirmedId: a.id,
    started: 1,
    finished: 2,
    status: 204,
  };
  const valid: HistoryObservation = {
    detail: null,
    listedIds: [],
    cancellations: [],
    requests: [
      deletion,
      {
        method: 'GET',
        id: null,
        started: 3,
        finished: 4,
        status: 200,
        history: { items: [] },
      },
      { method: 'GET', id: a.id, started: 5, finished: 6, status: 404 },
    ],
  };
  expect(historyIssues(valid, fixtures)).toEqual([]);
  expect(historyIssues({ ...valid, listedIds: [a.id] }, fixtures)).toContain(
    'deleted-interview-visible',
  );
  expect(
    historyIssues(
      {
        ...valid,
        detail: {
          selectedId: a.id,
          theme: a.theme,
          statements: [a.statement],
          summary: a.summary,
        },
      },
      fixtures,
    ),
  ).toContain('deleted-interview-visible');
  const listed = {
    interviewId: a.id,
    theme: a.theme,
    createdAt: a.createdAt,
    activeMs: 0,
    status: 'ended' as const,
  };
  const resurrected = {
    method: 'GET' as const,
    id: null,
    started: 3,
    finished: 4,
    status: 200,
    history: { items: [listed] },
  };
  expect(historyIssues({ ...valid, requests: [deletion, resurrected] }, fixtures)).toContain(
    'deleted-interview-returned',
  );
  expect(
    historyIssues(
      {
        ...valid,
        requests: [deletion, { method: 'GET', id: a.id, started: 3, finished: 4, status: 200 }],
      },
      fixtures,
    ),
  ).toContain('deleted-interview-returned');
  expect(
    historyIssues({ ...valid, requests: [deletion, { ...resurrected, started: 0 }] }, fixtures),
  ).toEqual([]);
  for (const failed of [
    { ...deletion, status: 503 },
    { ...deletion, status: null, finished: null },
  ]) {
    expect(
      historyIssues({ ...valid, listedIds: [a.id], requests: [failed, resurrected] }, fixtures),
    ).toEqual([]);
  }
});
