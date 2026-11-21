import type { HistoryWindow, HistorySnapshot } from './history-observe.ts';
import { always } from '@antithesishq/bombadil';
import type { Cell } from '@antithesishq/bombadil';
import { actions, extract, registerCustomAction } from '@antithesishq/bombadil/browser';
import type { ActionTemplate } from '@antithesishq/bombadil/browser';
import { requiredCoverage } from './evidence.ts';
import type { ExplorationFixtures } from './fixtures.ts';
import { performHistoryAction } from './history-actions.ts';
import { historyIssues } from './history-model.ts';
import { installHistoryObserver, readHistoryCoverage } from './history-observe.ts';

export function createSpecification(fixtures: ExplorationFixtures) {
  const first = fixtures.interviews.find((item) => item.key === 'a');
  const second = fixtures.interviews.find((item) => item.key === 'b');
  if (!first || !second) {
    throw new Error('履歴探索には2件のfixtureが必要です。');
  }
  const observation: Cell<HistorySnapshot | null> = extract(({ window }) =>
    structuredClone((window as HistoryWindow).bombadilHistory?.read() ?? null),
  );
  const coverage = extract(readHistoryCoverage);
  const initialize = registerCustomAction<[ExplorationFixtures, boolean]>(
    'history-observe',
    installHistoryObserver,
  );
  const step = registerCustomAction('history-operate', performHistoryAction);
  const explore = actions(() => {
    const snapshot = observation.current;
    if (!snapshot) {
      return [initialize(fixtures, true)];
    }
    const { reached } = coverage.current;
    const deleted = snapshot.requests.filter(
      (request) =>
        request.method === 'DELETE' && request.status === 204 && request.finished !== null,
    );
    const latest = deleted.at(-1);
    if (latest) {
      if (snapshot.generation <= (latest.generation ?? snapshot.generation)) {
        return ['Reload'];
      }
      const { finished } = latest;
      const fresh = snapshot.requests.filter(
        (request) =>
          request.method === 'GET' &&
          request.generation === snapshot.generation &&
          request.finished !== null &&
          finished !== null &&
          request.started > finished,
      );
      if (
        !reached.includes('deleted-and-reloaded') ||
        !fresh.some(
          (request) =>
            request.id === null && request.status === 200 && request.history !== undefined,
        ) ||
        !deleted.every((deletion) =>
          fresh.some((request) => request.id === deletion.id && request.status === 404),
        )
      ) {
        return [step('verify-deleted', '', fixtures)];
      }
    }
    function open(id: string): ActionTemplate[] {
      return snapshot?.listedIds !== null && snapshot?.listedIds !== undefined
        ? [step('open', id, fixtures)]
        : [step('back', '', fixtures)];
    }
    if (!reached.includes('opened-a')) {
      return open(first.id);
    }
    if (!reached.includes('opened-b')) {
      return open(second.id);
    }
    if (!reached.includes('delayed-detail-isolated')) {
      if (snapshot.delayedDetail.received) {
        if (snapshot.detail?.selectedId === second.id) {
          return [step('release-detail', '', fixtures)];
        }
        return open(second.id);
      }
      return snapshot.listedIds === null
        ? [step('back', '', fixtures)]
        : [step('hold-open', first.id, fixtures)];
    }
    if (!reached.includes('cancelled-delete')) {
      return snapshot.detail ? [step('cancel', '', fixtures)] : open(first.id);
    }
    if (!reached.includes('deleted-and-reloaded')) {
      return snapshot.detail ? [step('delete', '', fixtures)] : open(first.id);
    }
    const remaining = fixtures.interviews.filter(
      (fixture) => !deleted.some((request) => request.id === fixture.id),
    );
    if (remaining.length === 0) {
      // 同じ実行へ再投入せず、正常な空表示を不変条件で確認して終了時刻まで待つ。
      return ['Wait'];
    }
    const choices: [number, ActionTemplate][] = snapshot.detail
      ? [
          [8, step('back', '', fixtures)],
          [3, step('cancel', '', fixtures)],
          [1, step('delete', '', fixtures)],
          [1, 'Reload'],
        ]
      : [
          ...remaining.map((fixture): [number, ActionTemplate] => [
            8,
            step('open', fixture.id, fixtures),
          ]),
          [1, 'Reload'],
        ];
    return {
      branches: choices.map(([weight, value]): [number, { value: ActionTemplate }] => [
        weight,
        { value },
      ]),
    };
  });
  const invariant = always(() => {
    const snapshot = observation.current;
    const { reached } = coverage.current;
    if (!reached.every((marker) => requiredCoverage.history.includes(marker))) {
      return false;
    }
    if (!snapshot) {
      return true;
    }
    const allDeleted = fixtures.interviews.every((fixture) =>
      snapshot.requests.some(
        (request) =>
          request.id === fixture.id &&
          request.method === 'DELETE' &&
          request.status === 204 &&
          request.finished !== null,
      ),
    );
    return (
      snapshot.integrityErrors.length === 0 &&
      historyIssues(snapshot, fixtures).length === 0 &&
      (!allDeleted || snapshot.listedIds === null || snapshot.emptyHistory)
    );
  });
  return { explore, invariant };
}
