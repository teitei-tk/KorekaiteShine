import { expect, test } from 'vitest';
import { summarizeExploration } from '../bombadil/evidence.ts';

const trace = (reached: string[], action: string | null = null) =>
  JSON.stringify({
    timestamp: 1000,
    action,
    state: { url: 'http://127.0.0.1:4327/practice' },
    snapshots: [
      { index: 0, name: 'coverage', value: { reached, pendingDeletions: [] }, time: 1000 },
    ],
    violations: [],
  });

test('操作・違反・snapshotの構造を検証し、壊れた証拠を成功として扱わない', () => {
  const coverage = {
    name: 'coverage',
    value: {
      reached: [
        'analyzed',
        'edited-after-confirmation',
        'blocked-unconfirmed',
        'delayed-analysis-isolated',
      ],
    },
  };
  const row = { action: 'Reload', snapshots: [coverage], violations: [] };
  const summarize = (value: object) =>
    summarizeExploration({
      target: 'preparation',
      exitCode: 0,
      trace: JSON.stringify(value),
    });
  for (const action of [
    { Custom: { name: 'edit', arguments: [] } },
    { Click: { selector: '#analyze' } },
    'Back',
    'Forward',
  ]) {
    expect(summarize({ ...row, action })).toMatchObject({ status: 'passed', actions: 1 });
  }
  expect(summarize({ ...row, action: 'Wait' })).toMatchObject({ status: 'incomplete', actions: 0 });
  expect(
    summarize({ ...row, snapshots: [{ name: 'diagnostic', value: null }, coverage] }).status,
  ).toBe('passed');
  for (const action of [
    {},
    [],
    1,
    'Unknown',
    { Click: {}, Reload: {} },
    { Custom: null },
    { Custom: { name: 1, arguments: [] } },
    { Custom: { name: '', arguments: [] } },
    { Custom: { name: 'edit', arguments: null } },
    { Unknown: {} },
    { Click: null },
  ]) {
    expect(summarize({ ...row, action }).status).toBe('infrastructure_error');
  }
  for (const violations of [[null], [{ name: 1 }], [{ name: '' }]]) {
    expect(summarize({ ...row, violations }).status).toBe('infrastructure_error');
  }
  for (const snapshots of [
    [],
    [null],
    [{ name: 1 }],
    [{ name: 'diagnostic' }],
    [{ name: 'coverage', value: null }],
    [{ name: 'coverage', value: { reached: [1] } }],
  ]) {
    expect(summarize({ ...row, snapshots }).status).toBe('infrastructure_error');
  }
});

test('終了コード0でも操作ゼロや必要な状態の未到達を成功にしない', () => {
  expect(
    summarizeExploration({ target: 'preparation', exitCode: 0, trace: trace([]) }),
  ).toMatchObject({
    status: 'incomplete',
    actions: 0,
    reached: [],
  });
  expect(
    summarizeExploration({
      target: 'preparation',
      exitCode: 0,
      trace: trace(['analyzed'], 'Reload'),
    }),
  ).toMatchObject({
    status: 'incomplete',
    actions: 1,
    reached: ['analyzed'],
  });
});

test('準備画面は遅延応答の固定ケースに未到達なら通常操作が完了しても未完了にする', () => {
  const ordinary = ['analyzed', 'edited-after-confirmation', 'blocked-unconfirmed'];
  expect(
    summarizeExploration({ target: 'preparation', exitCode: 0, trace: trace(ordinary, 'Reload') })
      .status,
  ).toBe('incomplete');
  expect(
    summarizeExploration({
      target: 'preparation',
      exitCode: 0,
      trace: trace([...ordinary, 'delayed-analysis-isolated'], 'Reload'),
    }).status,
  ).toBe('passed');
});

test('履歴は遅延した旧詳細の分離を確認するまで成功にしない', () => {
  const ordinary = ['opened-a', 'opened-b', 'cancelled-delete', 'deleted-and-reloaded'];
  expect(
    summarizeExploration({ target: 'history', exitCode: 0, trace: trace(ordinary, 'Reload') })
      .status,
  ).toBe('incomplete');
  expect(
    summarizeExploration({
      target: 'history',
      exitCode: 0,
      trace: trace([...ordinary, 'delayed-detail-isolated'], 'Reload'),
    }).status,
  ).toBe('passed');
});

test('完了・性質違反・中断・不正な記録を証拠と終了コードの両方で分類する', () => {
  const complete = trace(
    ['analyzed', 'edited-after-confirmation', 'blocked-unconfirmed', 'delayed-analysis-isolated'],
    'Reload',
  );
  const violation = JSON.stringify({
    ...JSON.parse(complete),
    violations: [{ name: 'mustConfirm' }],
  });
  const summarize = (exitCode: number | null, value: string, interrupted = false) =>
    summarizeExploration({ target: 'preparation', exitCode, trace: value, interrupted });
  expect(summarize(0, complete).status).toBe('passed');
  expect(summarize(2, violation).status).toBe('violated');
  expect(summarize(0, complete, true).status).toBe('incomplete');
  expect(summarize(null, complete).status).toBe('infrastructure_error');
  expect(summarize(1, complete).status).toBe('infrastructure_error');
  expect(summarize(2, complete).status).toBe('infrastructure_error');
  expect(summarize(0, violation).status).toBe('infrastructure_error');
  for (const value of [
    '',
    'not-json',
    'null',
    '{}',
    JSON.stringify({
      action: 'Reload',
      snapshots: [{ name: 'coverage', value: { reached: ['invented-marker'] } }],
      violations: [],
    }),
    JSON.stringify({
      action: 'Reload',
      snapshots: [{ name: 'coverage', value: { reached: 'analyzed' } }],
      violations: [],
    }),
    `${complete}\n{`,
  ]) {
    expect(summarize(0, value).status).toBe('infrastructure_error');
  }
  expect(
    summarizeExploration({
      target: 'history',
      exitCode: 0,
      trace: trace(
        [
          'opened-a',
          'opened-b',
          'cancelled-delete',
          'deleted-and-reloaded',
          'delayed-detail-isolated',
        ],
        'Reload',
      ),
    }).status,
  ).toBe('passed');
});

test('以前の削除を確認済みでも、最後の削除に未確認のIDが残れば成功にしない', () => {
  const reached = [
    'opened-a',
    'opened-b',
    'cancelled-delete',
    'deleted-and-reloaded',
    'delayed-detail-isolated',
  ];
  const row = (pendingDeletions: string[] | null) =>
    JSON.stringify({
      action: 'Reload',
      snapshots: [{ name: 'coverage', value: { reached, pendingDeletions } }],
      violations: [],
    });
  const summarize = (lines: string[]) =>
    summarizeExploration({
      target: 'history',
      exitCode: 0,
      trace: lines.join('\n'),
    });
  expect(summarize([row([]), row(['second-id'])]).status).toBe('incomplete');
  expect(summarize([row([]), row(['second-id']), row([])]).status).toBe('passed');
  expect(summarize([row([]), row(null)]).status).toBe('incomplete');
  expect(
    summarize([
      JSON.stringify({
        action: 'Reload',
        snapshots: [{ name: 'coverage', value: { reached } }],
        violations: [],
      }),
    ]).status,
  ).toBe('infrastructure_error');
  const invalid = JSON.stringify({
    action: 'Reload',
    snapshots: [{ name: 'coverage', value: { reached, pendingDeletions: [1] } }],
    violations: [],
  });
  expect(summarize([invalid]).status).toBe('infrastructure_error');
});
