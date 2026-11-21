import type { JsonValue } from '@korekaite/api-contracts/json';
import type { PreparationWindow } from './observe.ts';
export type PreparationOperation =
  | 'edit'
  | 'confirm'
  | 'analyze'
  | 'select'
  | 'blocked'
  | 'open'
  | 'back'
  | 'hold-analyze'
  | 'release-analysis'
  | 'wait';
// この関数はブラウザ側で直列化して実行される。外部の実行時関数を参照しない。
export async function performPreparationAction(
  document: Document,
  window: PreparationWindow,
  operation: PreparationOperation,
  value: string,
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
  function requireValue<T>(value: T | null | undefined): T {
    if (value === null || value === undefined) {
      throw new Error('探索に必要な値がありません。');
    }
    return value;
  }

  const realm = requireValue(document.defaultView);
  const probe = window.bombadilPreparation;
  if (!probe) {
    throw new Error('準備画面の観測が未初期化です。');
  }
  const pause = (milliseconds: number) =>
    new Promise<void>((resolve) => {
      window.setTimeout(resolve, milliseconds);
    });
  async function wait(predicate: () => boolean) {
    const end = performance.now() + 10_000;
    while (!predicate()) {
      if (performance.now() >= end) {
        throw new Error('準備画面の操作が時間内に完了しませんでした。');
      }
      await pause(20);
    }
  }
  function button(title: string) {
    const element = [...document.querySelectorAll('button')].find(
      (item) => item.textContent.trim() === title,
    );
    if (!element) {
      throw new Error('探索対象のボタンがありません。');
    }
    return element;
  }
  function reached(marker: string) {
    const saved = jsonRecord(
      parseJsonValue(
        window.sessionStorage.getItem('bombadil-preparation-coverage') ?? '{"reached":[]}',
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
    window.sessionStorage.setItem('bombadil-preparation-coverage', JSON.stringify(coverage));
  }
  const before = probe.read();
  if (operation === 'wait') {
    await pause(100);
    return;
  }
  if (operation === 'open') {
    button(value).click();
    await wait(() => probe.read().view === null);
    if (before.delayedAnalysis.received) {
      window.sessionStorage.setItem('bombadil-preparation-delay', 'away');
    }
    return;
  }
  if (operation === 'back') {
    button('準備と履歴へ戻る').click();
    await wait(() => probe.read().view !== null);
    if (window.sessionStorage.getItem('bombadil-preparation-delay') === 'away') {
      window.sessionStorage.setItem('bombadil-preparation-delay', 'returned');
    }
    return;
  }
  if (operation === 'release-analysis') {
    const held = before.requests.find((request) => request.finished === null);
    probe.releaseAnalysis();
    if (!held) {
      throw new Error('解放する分析応答がありません。');
    }
    await wait(() => held.finished !== null);
    await pause(30);
    const after = probe.read();
    if (
      held.response &&
      before.view &&
      before.view.epoch !== held.epoch &&
      JSON.stringify(before.view) === JSON.stringify(after.view)
    ) {
      reached('delayed-analysis-isolated');
      window.sessionStorage.setItem('bombadil-preparation-delay', 'done');
    }
    return;
  }
  if (!before.view || before.view.pending) {
    return;
  }
  if (operation === 'hold-analyze') {
    if (before.view.analyzeDisabled) {
      return;
    }
    probe.holdNextAnalysis();
    const analyze = button('テーマを分析する');
    analyze.click();
    // 実ブラウザの別々の入力イベント同様に、イベント終了時のReact反映を挟む。
    // 応答は保留しているので、2回目も処理中のクリックとなる。
    await pause(0);
    analyze.click();
    await wait(() => probe.read().delayedAnalysis.received);
    window.sessionStorage.setItem('bombadil-preparation-delay', 'held');
    return;
  }
  if (operation === 'edit') {
    const textarea = requireValue(document.querySelector<HTMLTextAreaElement>('fieldset textarea'));
    requireValue(
      requireValue(Object.getOwnPropertyDescriptor(realm.HTMLTextAreaElement.prototype, 'value'))
        .set,
    ).call(textarea, value);
    textarea.dispatchEvent(new realm.Event('input', { bubbles: true }));
    await pause(30);
    const after = probe.read();
    if (
      before.view.confirmed &&
      before.view.markdown !== value &&
      after.view?.markdown === value &&
      !after.view.confirmed &&
      after.view.themes.length === 0 &&
      after.view.selected === null &&
      after.edits.some(
        (edit) =>
          edit.before.markdown === requireValue(before.view).markdown &&
          edit.after.markdown === value,
      )
    ) {
      reached('edited-after-confirmation');
    }
  } else if (operation === 'confirm') {
    requireValue(
      document.querySelector<HTMLInputElement>('fieldset input[type="checkbox"]'),
    ).click();
    await pause(30);
  } else if (operation === 'select') {
    document.querySelector<HTMLInputElement>('input[name="theme"]')?.click();
    await pause(30);
  } else if (operation === 'analyze') {
    if (before.view.analyzeDisabled) {
      return;
    }
    const count = before.requests.length;
    button('テーマを分析する').click();
    await wait(() => {
      const current = probe.read();
      return (
        current.requests.length > count &&
        requireValue(current.requests.at(-1)).finished !== null &&
        !current.view?.pending
      );
    });
    const after = probe.read();
    const request = requireValue(after.requests.at(-1));
    if (
      after.view &&
      request.response &&
      request.epoch === after.view.epoch &&
      request.body.markdown === after.view.markdown &&
      after.view.themes.length > 0 &&
      JSON.stringify(request.response.themes) === JSON.stringify(after.view.themes)
    ) {
      reached('analyzed');
    }
  } else {
    const count = before.requests.length;
    button('テーマを分析する').click();
    await pause(80);
    const after = probe.read();
    if (
      !before.view.confirmed &&
      before.view.analyzeDisabled &&
      after.view &&
      !after.view.confirmed &&
      after.view.analyzeDisabled &&
      after.requests.length === count
    ) {
      reached('blocked-unconfirmed');
    }
  }
}
