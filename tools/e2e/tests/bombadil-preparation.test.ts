import { requireValue } from '../bombadil/required.ts';
import { expect, test } from 'vitest';
import { preparationIssues } from '../bombadil/preparation-model.ts';
import type { PreparationObservation } from '../bombadil/preparation-model.ts';
function observation(): PreparationObservation {
  return {
    view: {
      epoch: 1,
      markdown: '架空の経験です。索引を追加しました。',
      confirmed: true,
      pending: false,
      analyzeDisabled: false,
      themes: [],
      selected: null,
    },
    requests: [],
    edits: [],
  };
}
test('材料上限は文字数ではなくUTF-8の32768バイトで判定する', () => {
  for (const markdown of [
    'a'.repeat(32_768),
    'é'.repeat(16_384),
    `${'あ'.repeat(10_922)}ab`,
    '😀'.repeat(8192),
  ]) {
    const current = { ...observation(), view: { ...requireValue(observation().view), markdown } };
    expect(preparationIssues(current)).toEqual([]);
    const oversized = `${markdown}c`;
    const invalid = { ...current, view: { ...current.view, markdown: oversized } };
    expect(preparationIssues(invalid)).toContain('analysis-button-policy');
    const blocked = { ...invalid, view: { ...invalid.view, analyzeDisabled: true } };
    expect(preparationIssues(blocked)).toEqual([]);
    expect(
      preparationIssues({
        ...blocked,
        requests: [
          {
            body: { markdown: oversized, confirmed: true },
            markdown: oversized,
            confirmed: true,
            epoch: 1,
            started: 1,
            finished: 2,
          },
        ],
      }),
    ).toContain('invalid-analysis-material');
  }
});
test('材料の編集後は確認・旧テーマ候補・選択がすべて解除される', () => {
  const before = {
    ...requireValue(observation().view),
    confirmed: true,
    themes: [{ title: '索引の判断', heading: '検索改善', excerpt: '索引を追加しました。' }],
    selected: 0,
  };
  const after = {
    ...before,
    markdown: '編集した架空の経験です。',
    confirmed: false,
    analyzeDisabled: true,
    themes: [],
    selected: null,
  };
  const valid = { ...observation(), view: after, edits: [{ before, after }] };
  expect(preparationIssues(valid)).toEqual([]);
  for (const retained of [{ confirmed: true }, { themes: before.themes }, { selected: 0 }]) {
    expect(
      preparationIssues({
        ...valid,
        edits: [{ before, after: { ...after, ...retained } }],
      }),
    ).toContain('material-edit-reset');
  }
  // 編集時点で解除済みなら、後の再確認を違反にしない。
  expect(
    preparationIssues({ ...valid, view: { ...after, confirmed: true, analyzeDisabled: false } }),
  ).toEqual([]);
});
test('未確認の分析はボタン状態と実際の要求をそれぞれ照合し、確認済み要求は許可する', () => {
  const valid = observation();
  const request = {
    body: { markdown: requireValue(valid.view).markdown, confirmed: true as const },
    markdown: requireValue(valid.view).markdown,
    confirmed: true,
    epoch: 1,
    started: 1,
    finished: 2,
  };
  expect(preparationIssues({ ...valid, requests: [request] })).toEqual([]);
  const unchecked = {
    ...valid,
    view: { ...requireValue(valid.view), confirmed: false, analyzeDisabled: true },
  };
  expect(preparationIssues(unchecked)).toEqual([]);
  expect(
    preparationIssues({ ...unchecked, view: { ...unchecked.view, analyzeDisabled: false } }),
  ).toContain('analysis-button-policy');
  // 表示が無効でも、実際に未確認の要求が出ていれば違反とする。
  expect(
    preparationIssues({ ...unchecked, requests: [{ ...request, confirmed: false }] }),
  ).toContain('unconfirmed-analysis');
});
test('空文字と空白だけの材料は、確認済みでも分析を許可しない', () => {
  for (const markdown of ['', ' \t\n', '　\n']) {
    const current = { ...observation(), view: { ...requireValue(observation().view), markdown } };
    expect(preparationIssues(current)).toContain('analysis-button-policy');
    const blocked = { ...current, view: { ...current.view, analyzeDisabled: true } };
    expect(preparationIssues(blocked)).toEqual([]);
    expect(
      preparationIssues({
        ...blocked,
        requests: [
          {
            body: { markdown, confirmed: true },
            markdown,
            confirmed: true,
            epoch: 1,
            started: 1,
            finished: 2,
          },
        ],
      }),
    ).toContain('invalid-analysis-material');
  }
});
test('同じ準備画面で分析の処理期間が重なる要求を検出する', () => {
  const current = observation();
  const first = {
    body: { markdown: requireValue(current.view).markdown, confirmed: true as const },
    markdown: requireValue(current.view).markdown,
    confirmed: true,
    epoch: 1,
    started: 1,
    finished: 4,
  };
  const next = { ...first, started: 5, finished: 6 };
  expect(preparationIssues({ ...current, requests: [first, next] })).toEqual([]);
  expect(preparationIssues({ ...current, requests: [first, { ...next, started: 3 }] })).toContain(
    'duplicate-analysis',
  );
  expect(
    preparationIssues({ ...current, requests: [{ ...first, finished: null }, next] }),
  ).toContain('duplicate-analysis');
  expect(
    preparationIssues({ ...current, requests: [first, { ...next, started: 3, epoch: 2 }] }),
  ).toEqual([]);
  // 収集順ではなく実際の開始・終了順で判定する。
  expect(
    preparationIssues({ ...current, requests: [next, { ...first, finished: null }] }),
  ).toContain('duplicate-analysis');
});
test('分析中は確認済みで有効な材料でも分析ボタンを無効にする', () => {
  const current = observation();
  const pending = { ...current, view: { ...requireValue(current.view), pending: true } };
  expect(preparationIssues(pending)).toContain('analysis-button-policy');
  expect(
    preparationIssues({ ...pending, view: { ...pending.view, analyzeDisabled: true } }),
  ).toEqual([]);
});
test('表示中のテーマは同じ準備画面と材料の完了済み分析応答に一致する', () => {
  const current = observation();
  const response = {
    analysisId: 'analysis-one',
    themes: [{ title: '索引の判断', heading: '検索改善', excerpt: '索引を追加しました。' }],
  };
  const request = {
    body: { markdown: requireValue(current.view).markdown, confirmed: true as const },
    markdown: requireValue(current.view).markdown,
    confirmed: true,
    epoch: 1,
    started: 1,
    finished: 2,
    response,
  };
  const visible = {
    ...current,
    view: { ...requireValue(current.view), themes: response.themes },
    requests: [request],
  };
  expect(preparationIssues(visible)).toEqual([]);
  expect(preparationIssues({ ...visible, view: { ...visible.view, epoch: 2 } })).toContain(
    'stale-analysis',
  );
  expect(
    preparationIssues({ ...visible, view: { ...visible.view, markdown: '別の架空の経験' } }),
  ).toContain('stale-analysis');
  expect(preparationIssues({ ...visible, requests: [{ ...request, finished: null }] })).toContain(
    'stale-analysis',
  );
  for (const changed of [
    { title: '別の判断' },
    { heading: '別の見出し' },
    { excerpt: '別の抜粋' },
  ]) {
    expect(
      preparationIssues({
        ...visible,
        view: {
          ...visible.view,
          themes: [{ ...requireValue(response.themes[0]), ...changed }],
        },
      }),
    ).toContain('stale-analysis');
  }
  expect(
    preparationIssues({ ...visible, view: { ...visible.view, epoch: 2, themes: [] } }),
  ).toEqual([]);
  expect(preparationIssues({ ...visible, view: null })).toEqual([]);
});
test('分析要求の本文がクリック時に確認した本文と異なれば検出する', () => {
  const current = observation();
  const request = {
    body: { markdown: requireValue(current.view).markdown, confirmed: true as const },
    markdown: requireValue(current.view).markdown,
    confirmed: true,
    epoch: 1,
    started: 1,
    finished: 2,
  };
  expect(preparationIssues({ ...current, requests: [request] })).toEqual([]);
  expect(
    preparationIssues({
      ...current,
      requests: [
        {
          ...request,
          body: { ...request.body, markdown: '確認していない別の架空材料' },
        },
      ],
    }),
  ).toContain('unconfirmed-analysis');
});

test('確認済みの上限32768バイトの材料が分析できない回帰を検出する', () => {
  for (const markdown of ['a'.repeat(32_768), `${'あ'.repeat(10_922)}ab`]) {
    const current = {
      ...observation(),
      view: { ...requireValue(observation().view), markdown, analyzeDisabled: true },
    };
    expect(preparationIssues(current)).toContain('analysis-button-policy');
    expect(
      preparationIssues({ ...current, view: { ...current.view, analyzeDisabled: false } }),
    ).toEqual([]);
    expect(
      preparationIssues({ ...current, view: { ...current.view, markdown: `${markdown}c` } }),
    ).toEqual([]);
  }
});
