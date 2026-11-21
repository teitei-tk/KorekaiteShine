// @vitest-environment jsdom
import type { PreparationWindow } from '../bombadil/observe.ts';
import type { HistoryWindow } from '../bombadil/history-observe.ts';

import { afterEach, expect, test, vi } from 'vitest';
import { createFixtures } from '../bombadil/fixtures.ts';
import { installHistoryObserver } from '../bombadil/history-observe.ts';
import { installPreparationObserver } from '../bombadil/observe.ts';
const browser = globalThis.window as PreparationWindow & HistoryWindow;

afterEach(() => {
  browser.bombadilHistory?.stop();
  browser.bombadilPreparation?.stop();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  browser.sessionStorage.clear();
});

test('標準output要素の処理中表示を観測し、読み込み中の履歴を空一覧と区別する', async () => {
  document.body.innerHTML = `<fieldset><textarea>架空の経験</textarea>
    <input type="checkbox" checked><button disabled>テーマを分析する</button><output>処理中…</output>
    </fieldset><section><h2>面接履歴</h2><output>履歴を読み込み中…</output></section>`;
  vi.stubGlobal('fetch', vi.fn());
  await installPreparationObserver(document, browser);
  await installHistoryObserver(
    document,
    browser,
    createFixtures('00000000-0000-4000-8000-000000000001'),
  );
  expect.soft(browser.bombadilPreparation?.read().view?.pending).toBe(true);
  expect.soft(browser.bombadilHistory?.read().listedIds).toBeNull();
  for (const output of document.querySelectorAll('output')) {
    output.remove();
  }
  expect(browser.bombadilPreparation?.read().view?.pending).toBe(false);
  expect(browser.bombadilHistory?.read().listedIds).toEqual([]);
});
