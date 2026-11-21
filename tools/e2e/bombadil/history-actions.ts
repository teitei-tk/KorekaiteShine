import type { JsonValue } from '@korekaite/api-contracts/json';
import type { HistoryWindow } from './history-observe.ts';
import type { ExplorationFixtures } from './fixtures.ts';
export type HistoryOperation =
  | 'open'
  | 'back'
  | 'cancel'
  | 'delete'
  | 'verify-deleted'
  | 'hold-open'
  | 'release-detail';
// ブラウザへ直列化するため、実行時の補助処理を関数内に閉じる。
export async function performHistoryAction(
  document: Document,
  window: HistoryWindow,
  operation: HistoryOperation,
  id: string,
  fixtures: ExplorationFixtures,
): Promise<void> {
  function parseJsonValue(text: string): JsonValue {
    // JSON文法だけを断定し、観測に使う各フィールドは呼び出し側で検査する。
    return JSON.parse(text) as JsonValue;
  }
  function jsonRecord(value: JsonValue | undefined): Record<string, JsonValue> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('観測JSONがオブジェクトではありません。');
    }
    return value;
  }
  const probe = window.bombadilHistory;
  if (!probe) {
    throw new Error('履歴の観測が未初期化です。');
  }
  const pause = () =>
    new Promise<void>((resolve) => {
      window.setTimeout(resolve, 20);
    });
  async function wait(predicate: () => boolean) {
    const end = performance.now() + 10_000;
    while (!predicate()) {
      if (performance.now() >= end) {
        throw new Error('履歴の操作が時間内に完了しませんでした。');
      }
      await pause();
    }
  }
  function click(title: string) {
    const button = [...document.querySelectorAll('button')].find(
      (item) => item.textContent.trim() === title && !item.disabled,
    );
    if (!button) {
      throw new Error('履歴の操作対象がありません。');
    }
    button.click();
  }
  function reached(marker: string) {
    const saved = jsonRecord(
      parseJsonValue(
        window.sessionStorage.getItem('bombadil-history-coverage') ?? '{"reached":[]}',
      ),
    );
    if (!Array.isArray(saved.reached)) {
      throw new TypeError('到達記録が配列ではありません。');
    }
    const coverage = {
      reached: saved.reached.map((value) => {
        if (typeof value !== 'string') {
          throw new TypeError('到達記録が文字列ではありません。');
        }
        return value;
      }),
    };
    if (!coverage.reached.includes(marker)) {
      coverage.reached.push(marker);
    }
    window.sessionStorage.setItem('bombadil-history-coverage', JSON.stringify(coverage));
  }
  const before = probe.read();
  if (operation === 'hold-open') {
    const fixture = fixtures.interviews.find((item) => item.id === id);
    if (!fixture) {
      throw new Error('保留する面接がありません。');
    }
    probe.holdNextDetail(id);
    click(fixture.theme);
    await wait(() => probe.read().delayedDetail.received);
    return;
  }
  if (operation === 'release-detail') {
    const held = before.requests.find(
      (request) =>
        request.method === 'GET' &&
        request.id === before.delayedDetail.id &&
        request.finished === null,
    );
    if (!held || !before.delayedDetail.received) {
      throw new Error('解放する詳細応答がありません。');
    }
    probe.releaseDetail();
    await wait(() => held.finished !== null);
    await pause();
    const after = probe.read();
    const fixture = fixtures.interviews.find((item) => item.id === before.detail?.selectedId);
    if (
      fixture &&
      fixture.id !== held.id &&
      held.status === 200 &&
      before.detail?.theme === fixture.theme &&
      before.detail.summary === fixture.summary &&
      before.detail.statements.length === 1 &&
      before.detail.statements[0] === fixture.statement &&
      JSON.stringify(before.detail) === JSON.stringify(after.detail) &&
      before.requests.some(
        (request) =>
          request.method === 'GET' &&
          request.id === fixture.id &&
          request.status === 200 &&
          request.finished !== null &&
          held.finished !== null &&
          request.finished < held.finished,
      )
    ) {
      reached('delayed-detail-isolated');
    }
    return;
  }
  if (operation === 'verify-deleted') {
    const deleted = before.requests.filter(
      (request) =>
        request.method === 'DELETE' && request.status === 204 && request.finished !== null,
    );
    if (
      deleted.length === 0 ||
      deleted.some((request) => before.generation <= (request.generation ?? before.generation))
    ) {
      return;
    }
    const count = before.requests.length;
    await window.fetch('/api/interview-history', { cache: 'no-store' });
    for (const deletion of deleted) {
      if (deletion.id) {
        await window.fetch(`/api/interviews/${encodeURIComponent(deletion.id)}`, {
          cache: 'no-store',
        });
      }
    }
    const after = probe.read();
    const fresh = after.requests.slice(count);
    const history = fresh.find(
      (request) => request.id === null && request.status === 200 && request.history !== undefined,
    );
    if (
      history?.history &&
      history.finished !== null &&
      after.listedIds !== null &&
      deleted.every((deletion) => {
        const { finished } = deletion;
        return (
          finished !== null &&
          history.started > finished &&
          !history.history?.items.some((item) => item.interviewId === deletion.id) &&
          !after.listedIds?.some((listed) => listed === deletion.id) &&
          fresh.some(
            (request) =>
              request.id === deletion.id &&
              request.status === 404 &&
              request.finished !== null &&
              request.started > finished &&
              request.generation === after.generation,
          )
        );
      })
    ) {
      reached('deleted-and-reloaded');
    }
    return;
  }
  if (operation === 'back') {
    click('準備と履歴へ戻る');
    await wait(() => probe.read().listedIds !== null);
    return;
  }
  if (operation === 'open') {
    const index = fixtures.interviews.findIndex((fixture) => fixture.id === id);
    const fixture = fixtures.interviews[index];
    if (!fixture) {
      throw new Error('探索対象の面接がありません。');
    }
    const count = before.requests.length;
    click(fixture.theme);
    await wait(() => {
      const snapshot = probe.read();
      return (
        snapshot.detail !== null &&
        snapshot.requests
          .slice(count)
          .some(
            (request) => request.method === 'GET' && request.id === id && request.finished !== null,
          )
      );
    });
    const after = probe.read();
    if (
      after.detail?.selectedId === id &&
      after.detail.theme === fixture.theme &&
      after.detail.summary === fixture.summary &&
      after.detail.statements.length === 1 &&
      after.detail.statements[0] === fixture.statement &&
      after.requests
        .slice(count)
        .some(
          (request) =>
            request.method === 'GET' &&
            request.id === id &&
            request.status === 200 &&
            request.finished !== null,
        )
    ) {
      reached(index === 0 ? 'opened-a' : 'opened-b');
    }
    return;
  }
  if (!before.detail || !before.selectedId) {
    throw new Error('削除操作の対象となる面接が表示されていません。');
  }
  click('記録の削除');
  await wait(
    () =>
      probe.read().confirmingId === before.selectedId &&
      [...document.querySelectorAll('button')].some(
        (button) => button.textContent.trim() === 'キャンセル' && !button.disabled,
      ),
  );
  if (operation === 'delete') {
    const count = before.requests.length;
    click('この面接を削除する');
    await wait(() =>
      probe
        .read()
        .requests.slice(count)
        .some(
          (request) =>
            request.method === 'DELETE' &&
            request.id === before.selectedId &&
            request.finished !== null,
        ),
    );
    const deletion = probe
      .read()
      .requests.slice(count)
      .find(
        (request) =>
          request.method === 'DELETE' && request.id === before.selectedId && request.status === 204,
      );
    if (deletion) {
      await wait(() => {
        const snapshot = probe.read();
        return snapshot.detail === null && snapshot.listedIds !== null;
      });
    }
    return;
  }
  click('キャンセル');
  await pause();
  const response = await window.fetch(`/api/interviews/${encodeURIComponent(before.selectedId)}`, {
    cache: 'no-store',
  });
  const after = probe.read();
  const cancel = after.cancellations.at(-1);
  const checkedAt = cancel?.checkedAt;
  if (
    response.status === 200 &&
    cancel?.id === before.selectedId &&
    typeof checkedAt === 'number' &&
    !after.requests.some(
      (request) =>
        request.method === 'DELETE' &&
        request.started >= cancel.opened &&
        request.started <= checkedAt,
    )
  ) {
    reached('cancelled-delete');
  }
}
