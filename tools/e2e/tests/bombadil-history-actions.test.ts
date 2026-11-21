// @vitest-environment jsdom
import { readJsonObject, requestUrl } from './bombadil-test-json.ts';
import type { HistoryWindow, HistorySnapshot } from '../bombadil/history-observe.ts';

import { requireValue } from '../bombadil/required.ts';
import { afterEach, expect, test, vi } from 'vitest';
import { createFixtures } from '../bombadil/fixtures.ts';
import { installHistoryObserver } from '../bombadil/history-observe.ts';
import { historyIssues } from '../bombadil/history-model.ts';
import { performHistoryAction } from '../bombadil/history-actions.ts';
const browser = globalThis.window as HistoryWindow;
afterEach(() => {
  browser.bombadilHistory?.stop();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  browser.sessionStorage.clear();
});
test('旧詳細の受信を保留して別面接へ移動し、解放後の表示一致から到達を記録する', async () => {
  const fixtures = createFixtures('00000000-0000-4000-8000-000000000001');
  const [first, second] = fixtures.interviews;
  if (!first || !second) {
    throw new Error('2件のfixtureが必要です。');
  }
  const fixtureInput = fixtures;
  const state = { selected: '' };
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({})),
  );
  function history() {
    state.selected = '';
    document.body.innerHTML = '<section><h2>面接履歴</h2><ul></ul></section>';
    const list = document.querySelector('ul');
    if (!list) {
      throw new Error('一覧がありません。');
    }
    for (const fixture of fixtures.interviews) {
      const row = document.createElement('li');
      const button = document.createElement('button');
      button.textContent = fixture.theme;
      button.addEventListener('click', () => {
        state.selected = fixture.id;
        document.body.innerHTML = '<article><output>面接の記録を読み込み中…</output></article>';
        const back = document.createElement('button');
        back.textContent = '準備と履歴へ戻る';
        back.addEventListener('click', history);
        document.body.append(back);
        void browser.fetch(`/api/interviews/${fixture.id}`).then(() => {
          if (state.selected === fixture.id) {
            const article = document.querySelector('article');
            if (!article) {
              throw new Error('詳細がありません。');
            }
            article.innerHTML = `<h2>${fixture.theme}</h2><section><h2>評価結果</h2><p>${fixture.summary}</p></section>
              <ol><li id="transcript-1">${fixture.statement}</li></ol>`;
          }
          return undefined;
        });
      });
      row.append(button);
      list.append(row);
    }
  }
  history();
  await installHistoryObserver(document, browser, fixtureInput);
  const act = (operation: Parameters<typeof performHistoryAction>[2], id = '') =>
    performHistoryAction(document, browser, operation, id, fixtureInput);
  await act('hold-open', first.id);
  expect(browser.bombadilHistory?.read().delayedDetail).toEqual({ id: first.id, received: true });
  expect(browser.bombadilHistory?.read().requests.at(-1)?.finished).toBeNull();
  await act('back');
  await act('open', second.id);
  await act('release-detail');
  const snapshot = browser.bombadilHistory?.read();
  if (!snapshot) {
    throw new Error('観測がありません。');
  }
  expect(historyIssues(snapshot, fixtures)).toEqual([]);
  expect(snapshot.detail?.selectedId).toBe(second.id);
  expect(snapshot.requests[0]?.finished).toBeGreaterThan(snapshot.requests[1]?.finished ?? 0);
  expect(
    readJsonObject(browser.sessionStorage.getItem('bombadil-history-coverage') ?? '{}'),
  ).toEqual({
    reached: ['opened-b', 'delayed-detail-isolated'],
  });
});
test('削除成功と再読み込み後の一覧不在・詳細404が揃った場合だけ到達済みにする', async () => {
  const fixtures = createFixtures('00000000-0000-4000-8000-000000000001');
  const fixtureInput = fixtures;
  const found = fixtures.interviews.find((item) => item.key === 'a');
  if (!found) {
    throw new Error('fixtureがありません。');
  }
  const fixture = found;
  const state = { deleteStatus: 503, deleted: false, detailStatus: 200 };
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'DELETE') {
      state.deleted = state.deleteStatus === 204;
      return new Response(null, { status: state.deleteStatus });
    }
    if (requestUrl(input) === '/api/interview-history') {
      return Response.json({
        items: fixtures.interviews
          .filter((item) => !state.deleted || item.id !== fixture.id)
          .map((item) => ({ interviewId: item.id, theme: item.theme, createdAt: item.createdAt })),
        next: null,
      });
    }
    return new Response(null, { status: state.detailStatus });
  });
  vi.stubGlobal('fetch', fetcher);
  function history() {
    document.body.innerHTML = `<section><h2>面接履歴</h2><ul>${fixtures.interviews
      .filter((item) => !state.deleted || item.id !== fixture.id)
      .map((item) => `<li><button>${item.theme}</button></li>`)
      .join('')}</ul></section>`;
  }
  function detail() {
    document.body.innerHTML = `<article><h2>${fixture.theme}</h2>
      <section><h2>評価結果</h2><p>${fixture.summary}</p></section>
      <ol><li id="transcript-1">${fixture.statement}</li></ol><button>記録の削除</button></article>`;
    const button = document.querySelector('button');
    if (!button) {
      throw new Error('削除ボタンがありません。');
    }
    button.addEventListener('click', () => {
      const dialog = document.createElement('div');
      dialog.innerHTML = '<button>キャンセル</button><button>この面接を削除する</button>';
      const confirm = dialog.querySelectorAll('button').item(1);
      confirm.addEventListener('click', () => {
        void browser.fetch(`/api/interviews/${fixture.id}`, { method: 'DELETE' }).then(() => {
          if (state.deleted) {
            history();
          } else {
            dialog.remove();
          }
          return undefined;
        });
      });
      document.body.append(dialog);
    });
  }
  history();
  await installHistoryObserver(document, browser, fixtureInput);
  const selection = [...document.querySelectorAll('button')].find(
    (button) => button.textContent === fixture.theme,
  );
  if (!selection) {
    throw new Error('履歴がありません。');
  }
  selection.click();
  detail();
  const act = (operation: Parameters<typeof performHistoryAction>[2]) =>
    performHistoryAction(document, browser, operation, '', fixtureInput);
  const coverage = () =>
    readJsonObject(browser.sessionStorage.getItem('bombadil-history-coverage') ?? '{"reached":[]}');
  await act('delete');
  expect(browser.bombadilHistory?.read().requests.at(-1)?.status).toBe(503);
  expect(coverage().reached).not.toContain('deleted-and-reloaded');
  state.deleteStatus = 204;
  await act('delete');
  expect(browser.bombadilHistory?.read().requests.at(-1)?.status).toBe(204);
  await act('verify-deleted');
  expect(coverage().reached).not.toContain('deleted-and-reloaded');
  browser.bombadilHistory?.stop();
  history();
  await installHistoryObserver(document, browser, fixtureInput);
  await act('verify-deleted');
  expect(coverage().reached).not.toContain('deleted-and-reloaded');
  state.detailStatus = 404;
  await act('verify-deleted');
  expect(coverage().reached).toContain('deleted-and-reloaded');
  const requests = browser.bombadilHistory?.read().requests ?? [];
  const deletion = requests.find(
    (request) => request.method === 'DELETE' && request.status === 204,
  );
  expect(requests.at(-1)).toMatchObject({ method: 'GET', id: fixture.id, status: 404 });
  expect(requests.at(-1)?.generation).toBeGreaterThan(deletion?.generation ?? 0);
  expect(requests.at(-1)?.started).toBeGreaterThan(deletion?.finished ?? 0);
});
test('2件の詳細表示と削除取消の到達を画面操作・取得成功・固有値で確認する', async () => {
  const fixtures = createFixtures('00000000-0000-4000-8000-000000000001');
  const fixtureInput = fixtures;
  const fetcher = vi.fn(async () => Response.json({}));
  vi.stubGlobal('fetch', fetcher);
  function renderHistory() {
    document.body.innerHTML = `<section><h2>面接履歴</h2><ul>${fixtures.interviews
      .map((item) => `<li><button>${item.theme}</button></li>`)
      .join('')}</ul></section>`;
    for (const [index, button] of [...document.querySelectorAll('button')].entries()) {
      button.addEventListener('click', () => {
        const fixture = requireValue(fixtures.interviews[index]);
        void browser.fetch(`/api/interviews/${fixture.id}`).then(() => {
          document.body.innerHTML = `<button>準備と履歴へ戻る</button>
            <article><h2>${fixture.theme}</h2><section><h2>評価結果</h2><p>${fixture.summary}</p></section>
            <ol><li id="transcript-1"><strong>あなた</strong> ${fixture.statement}</li></ol>
            <button>記録の削除</button></article>`;
          requireValue(document.querySelector('button')).addEventListener('click', renderHistory);
          requireValue(document.querySelector('article button')).addEventListener('click', () => {
            const dialog = document.createElement('div');
            dialog.innerHTML = '<button>キャンセル</button><button>この面接を削除する</button>';
            requireValue(dialog.querySelector('button')).addEventListener('click', () =>
              dialog.remove(),
            );
            document.body.append(dialog);
          });

          return undefined;
        });
      });
    }
  }
  renderHistory();
  await installHistoryObserver(document, browser, fixtureInput);
  const act = (operation: Parameters<typeof performHistoryAction>[2], id = '') =>
    performHistoryAction(document, browser, operation, id, fixtureInput);
  await act('open', requireValue(fixtures.interviews[0]).id);
  await act('back');
  await act('open', requireValue(fixtures.interviews[1]).id);
  await act('cancel');
  const observation = requireValue(browser.bombadilHistory).read();
  expect(historyIssues(observation, fixtures)).toEqual([]);
  expect(
    observation.requests.map((request) => [request.method, request.id, request.status]),
  ).toEqual([
    ['GET', requireValue(fixtures.interviews[0]).id, 200],
    ['GET', requireValue(fixtures.interviews[1]).id, 200],
    ['GET', requireValue(fixtures.interviews[1]).id, 200],
  ]);
  expect(fetcher).toHaveBeenLastCalledWith(
    `/api/interviews/${requireValue(fixtures.interviews[1]).id}`,
    {
      cache: 'no-store',
    },
  );
  expect(
    readJsonObject(requireValue(browser.sessionStorage.getItem('bombadil-history-coverage'))),
  ).toEqual({
    reached: ['opened-a', 'opened-b', 'cancelled-delete'],
  });
  expect(requireValue(observation.cancellations[0]).checkedAt).not.toBeNull();
});
test('履歴操作は対象欠落・期限・破損した到達記録・失敗した削除を成功に数えない', async () => {
  const fixtures = createFixtures('00000000-0000-4000-8000-000000000001');
  const a = requireValue(fixtures.interviews[0]);
  const act = (operation: Parameters<typeof performHistoryAction>[2], id = '') =>
    performHistoryAction(document, browser, operation, id, fixtures);
  await expect(act('back')).rejects.toThrow('観測が未初期化');
  const initial = (): HistorySnapshot => ({
    generation: 2,
    detail: null,
    listedIds: [],
    emptyHistory: true,
    delayedDetail: { id: null, received: false },
    selectedId: null,
    confirmingId: null,
    requests: [],
    cancellations: [],
    integrityErrors: [],
  });
  const detail = {
    selectedId: a.id,
    theme: a.theme,
    summary: a.summary,
    statements: [a.statement],
  };
  const state = { snapshot: initial() };
  const release = vi.fn<() => void>();
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ items: [] }));
  vi.stubGlobal('fetch', fetcher);
  browser.bombadilHistory = {
    read: () => state.snapshot,
    holdNextDetail: vi.fn<(id: string) => void>(),
    releaseDetail: release,
    stop: () => {
      delete browser.bombadilHistory;
    },
  };
  const key = 'bombadil-history-coverage';
  try {
    await expect(act('hold-open', 'unknown')).rejects.toThrow('保留する面接がありません');
    await expect(act('open', 'unknown')).rejects.toThrow('探索対象の面接がありません');
    await expect(act('release-detail')).rejects.toThrow('解放する詳細応答がありません');
    await expect(act('delete')).rejects.toThrow('対象となる面接が表示されていません');
    state.snapshot = { ...initial(), detail };
    await expect(act('delete')).rejects.toThrow('対象となる面接が表示されていません');
    document.body.innerHTML = '<button disabled>準備と履歴へ戻る</button>';
    await expect(act('back')).rejects.toThrow('操作対象がありません');
    requireValue(document.querySelector('button')).disabled = false;
    state.snapshot = { ...initial(), listedIds: null };
    const clock = vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(10_001);
    try {
      await expect(act('back')).rejects.toThrow('時間内に完了しません');
    } finally {
      clock.mockRestore();
    }
    const held = {
      method: 'GET' as const,
      id: a.id,
      started: 1,
      finished: null as number | null,
      status: 200,
    };
    state.snapshot = {
      ...initial(),
      detail,
      requests: [held],
      delayedDetail: { id: a.id, received: false },
    };
    await expect(act('release-detail')).rejects.toThrow('解放する詳細応答がありません');
    state.snapshot.delayedDetail.received = true;
    release.mockImplementation(() => {
      held.finished = 2;
    });
    await act('release-detail');
    expect(browser.sessionStorage.getItem(key)).toBeNull();
    state.snapshot = {
      ...initial(),
      requests: [{ method: 'DELETE', id: a.id, started: 1, finished: 2, status: 204 }],
    };
    await act('verify-deleted');
    expect(fetcher).not.toHaveBeenCalled();
    state.snapshot = {
      ...initial(),
      requests: [
        { method: 'DELETE', id: null, started: 1, finished: 2, status: 204, generation: 1 },
      ],
    };
    await act('verify-deleted');
    expect(fetcher).toHaveBeenCalledOnce();
    expect(browser.sessionStorage.getItem(key)).toBeNull();
    const opened = (theme = a.theme) => {
      state.snapshot = initial();
      document.body.innerHTML = `<button>${a.theme}</button>`;
      requireValue(document.querySelector('button')).addEventListener('click', () => {
        state.snapshot = {
          ...initial(),
          detail: { ...detail, theme },
          selectedId: a.id,
          requests: [{ method: 'GET', id: a.id, started: 1, finished: 2, status: 200 }],
        };
      });
    };
    opened('別の面接のテーマ');
    await act('open', a.id);
    expect(browser.sessionStorage.getItem(key)).toBeNull();
    for (const text of ['null', '1', '[]', '{', '{"reached":null}', '{"reached":[1]}']) {
      opened();
      browser.sessionStorage.setItem(key, text);
      await expect(act('open', a.id)).rejects.toThrow();
      expect(browser.sessionStorage.getItem(key)).toBe(text);
    }
    opened();
    browser.sessionStorage.setItem(key, '{"reached":["opened-a"]}');
    await act('open', a.id);
    expect(readJsonObject(requireValue(browser.sessionStorage.getItem(key)))).toEqual({
      reached: ['opened-a'],
    });
    for (const mode of [
      'missing',
      'unchecked',
      'deleted-during',
      'deleted-after',
      'failed-read',
      'delete-failed',
    ] as const) {
      browser.sessionStorage.removeItem(key);
      state.snapshot = { ...initial(), detail, selectedId: a.id };
      document.body.innerHTML = '<button>記録の削除</button>';
      requireValue(document.querySelector('button')).addEventListener('click', () => {
        state.snapshot.confirmingId = a.id;
        document.body.innerHTML = '<button>キャンセル</button><button>この面接を削除する</button>';
        const [cancel, remove] = document.querySelectorAll('button');
        requireValue(cancel).addEventListener('click', () => {
          state.snapshot.cancellations =
            mode === 'missing'
              ? []
              : [{ id: a.id, opened: 1, cancelled: 2, checkedAt: mode === 'unchecked' ? null : 4 }];
          state.snapshot.requests =
            mode === 'deleted-during' || mode === 'deleted-after'
              ? [
                  {
                    method: 'DELETE',
                    id: a.id,
                    started: mode === 'deleted-during' ? 3 : 5,
                    finished: 6,
                    status: 204,
                  },
                ]
              : [];
        });
        requireValue(remove).addEventListener('click', () => {
          state.snapshot.requests = [
            { method: 'DELETE', id: a.id, started: 1, finished: 2, status: 500 },
          ];
        });
      });
      fetcher.mockResolvedValueOnce(
        new Response(null, { status: mode === 'failed-read' ? 403 : 200 }),
      );
      await act(mode === 'delete-failed' ? 'delete' : 'cancel');
      expect(browser.sessionStorage.getItem(key)).toBe(
        mode === 'deleted-after' ? '{"reached":["cancelled-delete"]}' : null,
      );
    }
  } finally {
    delete browser.bombadilHistory;
  }
});
