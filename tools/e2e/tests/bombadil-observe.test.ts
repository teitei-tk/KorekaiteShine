// @vitest-environment jsdom
import { requestUrl } from './bombadil-test-json.ts';
import { parseJson } from '@korekaite/api-contracts/json';
import type { PreparationWindow, PreparationSnapshot } from '../bombadil/observe.ts';

import { requireValue } from '../bombadil/required.ts';
import { afterEach, expect, test, vi } from 'vitest';
import {
  installPreparationObserver,
  readPreparationSnapshot,
  restorePreparationSnapshot,
} from '../bombadil/observe.ts';
import { preparationIssues } from '../bombadil/preparation-model.ts';
const browser = globalThis.window as PreparationWindow;
afterEach(() => {
  browser.bombadilPreparation?.stop();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});
test('離脱後の分析要求も実クリック時の確認内容に対応付け、認証応答を保存しない', async () => {
  const markdown = '架空の図書館で索引を追加しました。';
  document.body.innerHTML = `<fieldset><textarea>${markdown}</textarea>
    <input type="checkbox" checked><button>テーマを分析する</button></fieldset>`;
  const response = {
    analysisId: 'fictional-analysis',
    themes: [{ title: '索引の判断', heading: '検索改善', excerpt: '索引を追加しました。' }],
  };
  const fetch = vi.fn(async (input: RequestInfo | URL) =>
    Response.json(
      requestUrl(input).includes('/api/local-session') ? { token: 'must-not-record' } : response,
    ),
  );
  vi.stubGlobal('fetch', fetch);
  await installPreparationObserver(document, browser);
  requireValue(document.querySelector('button')).click();
  document.body.replaceChildren();
  await browser.fetch('/api/local-session', { method: 'POST' });
  await browser.fetch('/api/materials/analyze', {
    method: 'POST',
    body: JSON.stringify({ markdown, confirmed: true }),
    headers: { 'X-Interview-Token': 'must-not-record' },
  });
  const snapshot = requireValue(browser.bombadilPreparation).read();
  expect(snapshot.view).toBeNull();
  expect(snapshot.requests).toHaveLength(1);
  expect(snapshot.requests[0]).toMatchObject({
    body: { markdown, confirmed: true },
    markdown,
    confirmed: true,
    epoch: 1,
    response,
  });
  expect(requireValue(snapshot.requests[0]).finished).toBeGreaterThan(
    requireValue(snapshot.requests[0]).started,
  );
  expect(JSON.stringify(snapshot)).not.toContain('must-not-record');
  expect(fetch).toHaveBeenCalledTimes(2);
});
test('入力イベント前後のDOMから、材料編集による確認とテーマのリセットを観測する', async () => {
  document.body.innerHTML = `<fieldset><textarea>編集前の架空材料</textarea>
    <input type="checkbox" checked><button>テーマを分析する</button>
    <section><div><label><input type="radio" name="theme" checked>索引の判断</label>
    <blockquote><small>検索改善</small><p>索引を追加しました。</p></blockquote></div></section></fieldset>`;
  vi.stubGlobal('fetch', vi.fn());
  await installPreparationObserver(document, browser);
  const textarea = requireValue(document.querySelector('textarea'));
  textarea.addEventListener('input', () => {
    requireValue(document.querySelector<HTMLInputElement>('input[type="checkbox"]')).checked =
      false;
    requireValue(document.querySelector('section')).remove();
    requireValue(document.querySelector('button')).disabled = true;
  });
  textarea.value = '編集後の架空材料';
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((resolve) => {
    browser.setTimeout(resolve, 0);
  });
  const snapshot = requireValue(browser.bombadilPreparation).read();
  expect(snapshot.edits).toHaveLength(1);
  expect(requireValue(snapshot.edits[0]).before).toMatchObject({
    markdown: '編集前の架空材料',
    confirmed: true,
    selected: 0,
    themes: [{ title: '索引の判断', heading: '検索改善', excerpt: '索引を追加しました。' }],
  });
  expect(requireValue(snapshot.edits[0]).after).toMatchObject({
    markdown: '編集後の架空材料',
    confirmed: false,
    selected: null,
    themes: [],
    analyzeDisabled: true,
  });
});
test('次の分析応答だけを保留し、認証と別画面の要求を通してから元の応答を解放する', async () => {
  const render = (markdown: string) => {
    document.body.innerHTML = `<fieldset><textarea>${markdown}</textarea>
      <input type="checkbox" checked><button>テーマを分析する</button></fieldset>`;
  };
  render('架空の経験、最初の材料');
  const response = {
    analysisId: 'held-analysis',
    themes: [{ title: '構成', heading: '本文', excerpt: '架空の経験' }],
  };
  const fetch = vi.fn(async () => Response.json(response));
  vi.stubGlobal('fetch', fetch);
  await installPreparationObserver(document, browser);
  const probe = requireValue(browser.bombadilPreparation);
  probe.holdNextAnalysis();
  requireValue(document.querySelector('button')).click();
  const delivered = { first: false };
  const first = browser
    .fetch('/api/materials/analyze', {
      method: 'POST',
      body: JSON.stringify({ markdown: '架空の経験、最初の材料', confirmed: true }),
    })
    .then(async (result) => {
      delivered.first = true;
      return parseJson(await result.text());
    });
  await vi.waitFor(() => expect(probe.read().delayedAnalysis.received).toBe(true));
  expect(delivered.first).toBe(false);
  expect(requireValue(probe.read().requests[0]).finished).toBeNull();
  await browser.fetch('/api/local-session', { method: 'POST' });
  render('架空の経験、次の材料');
  requireValue(document.querySelector('button')).click();
  await browser.fetch('/api/materials/analyze', {
    method: 'POST',
    body: JSON.stringify({ markdown: '架空の経験、次の材料', confirmed: true }),
  });
  expect(requireValue(probe.read().requests[1]).epoch).toBe(2);
  expect(requireValue(probe.read().requests[1]).finished).not.toBeNull();
  expect(delivered.first).toBe(false);
  probe.releaseAnalysis();
  expect(await first).toEqual(response);
  expect(requireValue(probe.read().requests[0]).finished).toBeGreaterThan(
    requireValue(requireValue(probe.read().requests[1]).finished),
  );
  expect(fetch).toHaveBeenCalledTimes(3);
});
test('準備観測は欠けたDOMや不正な分析データを正常な結果にせず、停止時に自分の監視だけを解除する', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
    Response.json({ analysisId: 'fixture', themes: [] }),
  );
  vi.stubGlobal('fetch', fetch);
  await expect(
    installPreparationObserver(document.implementation.createHTMLDocument(), browser),
  ).rejects.toThrow('探索に必要な値');
  const clock = vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(10_001);
  try {
    await expect(installPreparationObserver(document, browser, '準備完了')).rejects.toThrow(
      '読み込みが完了しません',
    );
  } finally {
    clock.mockRestore();
  }
  const ready = installPreparationObserver(document, browser, '準備完了');
  document.body.innerHTML = '<button>準備完了</button>';
  await ready;
  const probe = requireValue(browser.bombadilPreparation);
  const observed = Object.getOwnPropertyDescriptor(browser, 'fetch');
  await installPreparationObserver(document, browser);
  expect(Object.getOwnPropertyDescriptor(browser, 'fetch')).toEqual(observed);
  expect(probe.read().view).toBeNull();
  document.body.innerHTML = '<button>テーマを分析する</button>';
  requireValue(document.querySelector('button')).click();
  document.dispatchEvent(new Event('click'));
  document.body.innerHTML =
    '<fieldset><textarea>架空の経験</textarea><input type="radio" name="theme" checked></fieldset>';
  expect(probe.read().view).toMatchObject({
    confirmed: false,
    analyzeDisabled: true,
    selected: 0,
    themes: [{ title: '', heading: '', excerpt: '' }],
  });
  const render = () => {
    document.body.innerHTML =
      '<fieldset><textarea>架空の経験</textarea><input type="checkbox" checked><button>テーマを分析する</button></fieldset>';
    probe.read();
  };
  render();
  const textarea = requireValue(document.querySelector('textarea'));
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  document.dispatchEvent(new Event('input'));
  const button = requireValue(document.querySelector('button'));
  button.disabled = true;
  button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  button.disabled = false;
  textarea.value = '変更して離脱';
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  document.body.replaceChildren();
  await new Promise<void>((resolve) => {
    browser.setTimeout(resolve, 0);
  });
  expect(probe.read().edits).toEqual([]);
  render();
  const path = '/api/materials/analyze';
  const body = JSON.stringify({ markdown: '架空の経験', confirmed: true });
  for (const input of [
    new URL(path, browser.location.href),
    new Request(new URL('/api/local-session', browser.location.href), { method: 'POST' }),
    new Request(new URL(path, browser.location.href)),
    new URL('https://example.com/api/materials/analyze'),
  ]) {
    await browser.fetch(input);
  }
  expect(probe.read().requests).toEqual([]);
  await browser.fetch(path, { method: 'POST', body });
  expect(probe.read().integrityErrors).toEqual(['unmatched-analysis-request']);
  for (const invalid of [
    undefined,
    new URLSearchParams('markdown=x'),
    '{}',
    '{"markdown":1,"confirmed":true}',
    '{"markdown":"x","confirmed":1}',
  ]) {
    requireValue(document.querySelector('button')).click();
    await browser.fetch(path, { method: 'POST', body: invalid });
  }
  expect(probe.read().requests).toEqual([]);
  expect(probe.read().integrityErrors).toHaveLength(6);
  for (const invalid of ['null', '[]', '1', '{']) {
    requireValue(document.querySelector('button')).click();
    await expect(browser.fetch(path, { method: 'POST', body: invalid })).rejects.toThrow();
  }
  for (const payload of [
    null,
    [],
    1,
    { analysisId: 1, themes: [] },
    { analysisId: 'fixture', themes: null },
    ...[
      null,
      [],
      { title: 1 },
      { title: 'a', heading: 1 },
      { title: 'a', heading: 'b', excerpt: 1 },
    ].map((theme) => ({ analysisId: 'fixture', themes: [theme] })),
  ]) {
    fetch.mockResolvedValueOnce(Response.json(payload));
    requireValue(document.querySelector('button')).click();
    await expect(browser.fetch(path, { method: 'POST', body })).rejects.toThrow();
    const request = requireValue(probe.read().requests.at(-1));
    expect(request.response).toBeNull();
    expect(request.finished).toBeGreaterThan(request.started);
  }
  const denied = new Response(null, { status: 403 });
  fetch.mockResolvedValueOnce(denied);
  probe.holdNextAnalysis();
  expect(() => probe.holdNextAnalysis()).toThrow('すでに保留');
  requireValue(document.querySelector('button')).click();
  const pending = browser.fetch(path, { method: 'POST', body });
  await expect.poll(() => probe.read().delayedAnalysis.received).toBe(true);
  const current = requireValue(document.querySelector('textarea'));
  current.value = '監視停止前の編集';
  current.dispatchEvent(new Event('input', { bubbles: true }));
  const clear = vi.spyOn(browser, 'clearTimeout');
  const replacement = vi.fn<typeof globalThis.fetch>();
  browser.fetch = replacement;
  try {
    probe.stop();
    await expect(pending).resolves.toBe(denied);
    expect(clear).toHaveBeenCalledOnce();
    expect(browser).toHaveProperty('fetch', replacement);
    expect(browser.bombadilPreparation).toBeUndefined();
    expect(probe.read().edits).toEqual([]);
  } finally {
    clear.mockRestore();
  }
});

test('長い材料の過去の編集を要約しても、同一性・上限・各性質違反を保持する', () => {
  const markdown = `${'あ'.repeat(10_922)}ab`;
  const view = {
    epoch: 1,
    markdown,
    confirmed: true,
    pending: false,
    analyzeDisabled: false,
    themes: [],
    selected: null,
  };
  const request = {
    body: { markdown, confirmed: true },
    markdown,
    confirmed: true,
    epoch: 1,
    started: 1,
    finished: 2,
  };
  const initial: PreparationSnapshot = {
    view,
    requests: [request],
    edits: Array.from({ length: 100 }, () => ({
      before: view,
      after: { ...view, markdown: '別の架空材料', confirmed: false, analyzeDisabled: true },
    })),
    integrityErrors: [],
    delayedAnalysis: { armed: false, received: false },
  };
  const state = { snapshot: initial };
  expect(readPreparationSnapshot({ window: browser })).toBeNull();
  browser.bombadilPreparation = {
    read: () => state.snapshot,
    holdNextAnalysis: vi.fn<() => void>(),
    releaseAnalysis: vi.fn<() => void>(),
    stop: () => {
      delete browser.bombadilPreparation;
    },
  };
  const compact = requireValue(readPreparationSnapshot({ window: browser }));
  expect(compact.materials).toEqual([markdown, '別の架空材料']);
  expect(restorePreparationSnapshot(compact)).toEqual(initial);
  expect(restorePreparationSnapshot(null)).toBeNull();
  expect(() => restorePreparationSnapshot({ ...compact, materials: [] })).toThrow('材料の参照');
  expect(compact.requests[0]?.body.markdown).toEqual(compact.view?.markdown);
  expect(compact.edits[0]?.after.markdown).not.toEqual(compact.view?.markdown);
  const serialized = JSON.stringify(compact);
  expect(serialized.length).toBeLessThan(200_000);
  expect(serialized.split(markdown)).toHaveLength(2);
  const variants: PreparationSnapshot[] = [
    initial,
    { ...initial, view: null },
    { ...initial, view: { ...view, pending: true } },
    { ...initial, view: { ...view, markdown: ' \t\n' } },
    { ...initial, view: { ...view, markdown: `${markdown}c` } },
    { ...initial, requests: [{ ...request, confirmed: false }] },
    { ...initial, requests: [{ ...request, body: { ...request.body, markdown: '違う本文' } }] },
    { ...initial, requests: [{ ...request, body: { ...request.body, markdown: `${markdown}c` } }] },
    { ...initial, requests: [request, { ...request, started: 1.5 }] },
    { ...initial, edits: [{ before: view, after: { ...view, markdown: '変更後' } }] },
    {
      ...initial,
      view: { ...view, themes: [{ title: '古い候補', heading: '本文', excerpt: '過去' }] },
    },
  ];
  for (const snapshot of variants) {
    state.snapshot = snapshot;
    const restored = requireValue(
      restorePreparationSnapshot(readPreparationSnapshot({ window: browser })),
    );
    expect(restored).toEqual(snapshot);
    expect(preparationIssues(restored)).toEqual(preparationIssues(snapshot));
  }
});
