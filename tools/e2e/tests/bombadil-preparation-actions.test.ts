// @vitest-environment jsdom
import { readJsonObject } from './bombadil-test-json.ts';
import { parseJson } from '@korekaite/api-contracts/json';
import { validateSavedMaterialAnalysis } from '@korekaite/api-contracts/http/materials-validators';
import type { PreparationWindow, PreparationSnapshot } from '../bombadil/observe.ts';

import { requireValue } from '../bombadil/required.ts';
import { afterEach, expect, test, vi } from 'vitest';
import { installPreparationObserver } from '../bombadil/observe.ts';
import { performPreparationAction } from '../bombadil/preparation-actions.ts';
const browser = globalThis.window as PreparationWindow;
afterEach(() => {
  browser.bombadilPreparation?.stop();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  browser.sessionStorage.clear();
});
test('分析・選択・編集・未確認操作の到達を実応答とDOMの変化から記録する', async () => {
  document.body.innerHTML = `<fieldset><textarea></textarea><input type="checkbox">
    <button disabled>テーマを分析する</button></fieldset>`;
  const response = {
    analysisId: 'fictional-analysis',
    themes: [{ title: '索引の判断', heading: '検索改善', excerpt: '索引を追加しました。' }],
  };
  const fetch = vi.fn(async () => Response.json(response));
  vi.stubGlobal('fetch', fetch);
  const textarea = requireValue(document.querySelector('textarea'));
  const checkbox = requireValue(document.querySelector<HTMLInputElement>('input[type="checkbox"]'));
  const button = requireValue(document.querySelector('button'));
  textarea.addEventListener('input', () => {
    checkbox.checked = false;
    button.disabled = true;
    document.querySelector('section')?.remove();
  });
  checkbox.addEventListener('change', () => {
    button.disabled = !checkbox.checked || !textarea.value.trim();
  });
  button.addEventListener('click', () => {
    void browser
      .fetch('/api/materials/analyze', {
        method: 'POST',
        body: JSON.stringify({ markdown: textarea.value, confirmed: true }),
      })
      .then(async (result) => {
        const analysis = parseJson(await result.text());
        if (!validateSavedMaterialAnalysis(analysis)) {
          throw new TypeError('分析fixtureが不正です。');
        }
        const [theme] = analysis.themes;
        if (!theme) {
          throw new Error('分析fixtureに候補がありません。');
        }
        const section = document.createElement('section');
        section.innerHTML = `<div><label><input type="radio" name="theme">${theme.title}</label>
        <blockquote><small>${theme.heading}</small><p>${theme.excerpt}</p></blockquote></div>`;
        requireValue(document.querySelector('fieldset')).append(section);

        return undefined;
      });
  });
  await installPreparationObserver(document, browser);
  const act = (operation: Parameters<typeof performPreparationAction>[2], value = '') =>
    performPreparationAction(document, browser, operation, value);
  await act('edit', '架空の図書館で索引を追加しました。');
  await act('confirm');
  await act('analyze');
  await act('select');
  expect(requireValue(requireValue(browser.bombadilPreparation).read().view).selected).toBe(0);
  await act('edit', '編集した架空の経験です。候補を比較しました。');
  await act('blocked');
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(
    readJsonObject(requireValue(browser.sessionStorage.getItem('bombadil-preparation-coverage'))),
  ).toEqual({
    reached: ['analyzed', 'edited-after-confirmation', 'blocked-unconfirmed'],
  });
  // 到達済みのマーカーを重複させない。
  await act('blocked');
  expect(
    readJsonObject(requireValue(browser.sessionStorage.getItem('bombadil-preparation-coverage')))
      .reached,
  ).toHaveLength(3);
});
test('分析応答を保留したまま連打・離脱・復帰し、古い応答の解放後も新しい画面を保つ', async () => {
  document.body.innerHTML = `<fieldset><textarea>架空の経験です。</textarea>
    <input type="checkbox" checked><button>テーマを分析する</button></fieldset><button>架空の履歴</button>`;
  const response = {
    analysisId: 'old-analysis',
    themes: [{ title: '構成', heading: '本文', excerpt: '架空の経験' }],
  };
  const fetch = vi.fn(async () => Response.json(response));
  vi.stubGlobal('fetch', fetch);
  const original = requireValue(document.querySelector('fieldset'));
  requireValue(document.querySelector('button')).addEventListener('click', () => {
    // Reactのイベント終了時の反映に合わせ、同じ呼び出しスタック内では無効化しない。
    browser.queueMicrotask(() => {
      original.disabled = true;
      original.insertAdjacentHTML('beforeend', '<p role="status">処理中…</p>');
    });
    void browser
      .fetch('/api/materials/analyze', {
        method: 'POST',
        body: JSON.stringify({ markdown: '架空の経験です。', confirmed: true }),
      })
      .then(async (result) => {
        await result.json();
        // アンマウント済み画面への結果は、現在のDOMを変更しない。
        original.insertAdjacentHTML('beforeend', '<section>古い分析結果</section>');

        return undefined;
      });
  });
  requireValue(document.querySelectorAll('button')[1]).addEventListener('click', () => {
    document.body.innerHTML = '<button>準備と履歴へ戻る</button>';
    requireValue(document.querySelector('button')).addEventListener('click', () => {
      document.body.innerHTML =
        '<fieldset><textarea></textarea><input type="checkbox"><button disabled>テーマを分析する</button></fieldset>';
    });
  });
  await installPreparationObserver(document, browser);
  await performPreparationAction(document, browser, 'hold-analyze', '');
  expect(requireValue(browser.bombadilPreparation).read().delayedAnalysis.received).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(1);
  await performPreparationAction(document, browser, 'open', '架空の履歴');
  await performPreparationAction(document, browser, 'back', '');
  await performPreparationAction(document, browser, 'release-analysis', '');
  expect(requireValue(browser.bombadilPreparation).read().view).toMatchObject({
    epoch: 2,
    markdown: '',
    themes: [],
    confirmed: false,
  });
  expect(document.body.textContent).not.toContain('古い分析結果');
  expect(
    readJsonObject(requireValue(browser.sessionStorage.getItem('bombadil-preparation-coverage')))
      .reached,
  ).toContain('delayed-analysis-isolated');
});
test('準備操作は未初期化・未完了・不正な到達記録を成功条件へ数えない', async () => {
  const act = (operation: Parameters<typeof performPreparationAction>[2], value = '') =>
    performPreparationAction(document, browser, operation, value);
  await expect(
    performPreparationAction(document.implementation.createHTMLDocument(), browser, 'wait', ''),
  ).rejects.toThrow('探索に必要な値');
  await expect(act('wait')).rejects.toThrow('観測が未初期化');
  const view = {
    epoch: 1,
    markdown: '架空の経験',
    confirmed: true,
    pending: false,
    analyzeDisabled: false,
    themes: [],
    selected: null,
  };
  const initial = (): PreparationSnapshot => ({
    view: { ...view },
    requests: [],
    edits: [],
    integrityErrors: [],
    delayedAnalysis: { armed: false, received: false },
  });
  const state = { snapshot: initial() };
  const hold = vi.fn<() => void>();
  const release = vi.fn<() => void>();
  browser.bombadilPreparation = {
    read: () => state.snapshot,
    holdNextAnalysis: hold,
    releaseAnalysis: release,
    stop: () => {
      delete browser.bombadilPreparation;
    },
  };
  try {
    await act('wait');
    for (const current of [null, { ...view, pending: true }]) {
      state.snapshot = { ...initial(), view: current };
      await act('edit', '変更');
      expect(state.snapshot.view).toEqual(current);
    }
    state.snapshot = { ...initial(), view: { ...view, analyzeDisabled: true } };
    await act('analyze');
    await act('hold-analyze');
    expect(hold).not.toHaveBeenCalled();
    await expect(act('release-analysis')).rejects.toThrow('解放する分析応答がありません');
    expect(release).toHaveBeenCalledOnce();
    await expect(act('open', '存在しない履歴')).rejects.toThrow('ボタンがありません');
    document.body.innerHTML = '<button>履歴</button>';
    const clock = vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(10_001);
    try {
      await expect(act('open', '履歴')).rejects.toThrow('時間内に完了しません');
    } finally {
      clock.mockRestore();
    }
    requireValue(document.querySelector('button')).addEventListener('click', () => {
      state.snapshot = { ...initial(), view: null };
    });
    await act('open', '履歴');
    expect(browser.sessionStorage.getItem('bombadil-preparation-delay')).toBeNull();
    document.body.innerHTML = '<button>準備と履歴へ戻る</button>';
    requireValue(document.querySelector('button')).addEventListener('click', () => {
      state.snapshot = initial();
    });
    await act('back');
    expect(browser.sessionStorage.getItem('bombadil-preparation-delay')).toBeNull();
    const held = {
      body: { markdown: view.markdown, confirmed: true as const },
      markdown: view.markdown,
      confirmed: true,
      epoch: 1,
      started: 1,
      finished: null as number | null,
      response: null,
    };
    state.snapshot = { ...initial(), requests: [held] };
    release.mockImplementation(() => {
      held.finished = 2;
    });
    await act('release-analysis');
    expect(browser.sessionStorage.getItem('bombadil-preparation-coverage')).toBeNull();
    document.body.innerHTML = '<button>テーマを分析する</button>';
    state.snapshot = initial();
    requireValue(document.querySelector('button')).addEventListener('click', () => {
      state.snapshot = { ...initial(), requests: [{ ...held, finished: 2 }] };
    });
    await act('analyze');
    expect(browser.sessionStorage.getItem('bombadil-preparation-coverage')).toBeNull();
    // 確認済みの画面をクリックしても「未確認の要求を阻止した」証拠にはしない。
    await act('blocked');
    expect(browser.sessionStorage.getItem('bombadil-preparation-coverage')).toBeNull();
    document.body.innerHTML = '<button disabled>テーマを分析する</button>';
    state.snapshot = { ...initial(), view: { ...view, confirmed: false, analyzeDisabled: true } };
    for (const text of ['null', '1', '[]', '{', '{"reached":null}', '{"reached":[1]}']) {
      browser.sessionStorage.setItem('bombadil-preparation-coverage', text);
      await expect(act('blocked')).rejects.toThrow();
      expect(browser.sessionStorage.getItem('bombadil-preparation-coverage')).toBe(text);
    }
  } finally {
    delete browser.bombadilPreparation;
  }
});
