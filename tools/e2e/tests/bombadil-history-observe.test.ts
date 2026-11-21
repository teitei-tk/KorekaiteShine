// @vitest-environment jsdom
import { requestUrl } from './bombadil-test-json.ts';
import { parseJson } from '@korekaite/api-contracts/json';
import { validateInterviewDetail } from '@korekaite/api-contracts/http/application-validators';
import type { HistoryWindow } from '../bombadil/history-observe.ts';

import { requireValue } from '../bombadil/required.ts';
import { afterEach, expect, test, vi } from 'vitest';
import type { components } from '@korekaite/api-contracts/http';
import { createFixtures } from '../bombadil/fixtures.ts';
import { installHistoryObserver, readHistoryCoverage } from '../bombadil/history-observe.ts';
import { summarizeExploration } from '../bombadil/evidence.ts';
import { historyIssues } from '../bombadil/history-model.ts';
const browser = globalThis.window as HistoryWindow;
afterEach(() => {
  browser.bombadilHistory?.stop();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  browser.sessionStorage.clear();
});
test('探索開始時は履歴の読み込み完了を待ち、正常な空一覧でも初期化できる', async () => {
  document.body.innerHTML =
    '<section><h2>面接履歴</h2><output>履歴を読み込み中…</output></section>';
  vi.stubGlobal('fetch', vi.fn());
  const state = { initialized: false };
  const pending = installHistoryObserver(
    document,
    browser,
    createFixtures('00000000-0000-4000-8000-000000000001'),
    true,
  ).then(() => {
    state.initialized = true;
    return undefined;
  });
  try {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 30);
    });
    expect(state.initialized).toBe(false);
  } finally {
    document.body.innerHTML =
      '<section><h2>面接履歴</h2><p>保存された面接はありません。</p></section>';
    await pending;
  }
  expect(state.initialized).toBe(true);
  expect(browser.bombadilHistory?.read()).toMatchObject({ listedIds: [], emptyHistory: true });
});
test('旧詳細応答を保留して別面接を表示し、解放後の古い内容の混入を検出する', async () => {
  const fixtures = createFixtures('00000000-0000-4000-8000-000000000001');
  const [a, b] = fixtures.interviews;
  function detail(
    fixture: (typeof fixtures.interviews)[number],
  ): components['schemas']['InterviewDetail'] {
    const axis = {
      status: 'unconfirmed' as const,
      score: null,
      reason: '架空の評価です。',
      evidence: [],
    };
    return {
      session: {
        interviewId: fixture.id,
        status: 'ended',
        theme: fixture.theme,
        createdAt: fixture.createdAt,
        activeMs: 0,
      },
      material: { title: fixture.theme, heading: '本文', excerpt: '架空の経験' },
      background: '',
      transcriptIncomplete: false,
      playback: [],
      transcripts: [
        {
          fragmentId: `fragment-${fixture.id}`,
          sequence: 1,
          generation: 1,
          speaker: 'user',
          content: fixture.statement,
          sourceStartMs: null,
          sourceEndMs: null,
          receivedAt: fixture.createdAt,
        },
      ],
      evaluation: {
        jobId: fixture.jobId,
        status: 'completed',
        attemptCount: 1,
        nextAttemptAt: null,
        lastErrorCode: null,
        result: {
          summary: fixture.summary,
          axes: {
            problem: axis,
            alternatives: axis,
            reasoning: axis,
            action: axis,
            learning: axis,
          },
          strengths: [],
          gaps: [],
          unconfirmed: [],
          practiceQuestions: [],
          consistency: [],
        },
      },
    };
  }
  function history() {
    document.body.innerHTML = `<section><h2>面接履歴</h2><ul>${fixtures.interviews
      .map((item) => `<li><button>${item.theme}</button></li>`)
      .join('')}</ul></section>`;
  }
  function render(value: components['schemas']['InterviewDetail']) {
    document.body.innerHTML = `<article><h2>${value.session.theme}</h2><section><h2>評価結果</h2><p>${requireValue(requireValue(value.evaluation).result).summary}</p></section>
      <ol><li id="transcript-1"><strong>あなた</strong> ${requireValue(value.transcripts[0]).content}</li></ol></article>`;
  }
  history();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) =>
      Response.json(
        detail(requestUrl(input).endsWith(requireValue(a).id) ? requireValue(a) : requireValue(b)),
      ),
    ),
  );
  await installHistoryObserver(document, browser, fixtures);
  const probe = requireValue(browser.bombadilHistory);
  probe.holdNextDetail(requireValue(a).id);
  requireValue(document.querySelector('button')).click();
  const controller = new AbortController();
  const delivered = { first: false };
  const first = browser
    .fetch(`/api/interviews/${requireValue(a).id}`, { signal: controller.signal })
    .then(async (response) => {
      delivered.first = true;
      const value = parseJson(await response.text());
      if (!validateInterviewDetail(value)) {
        throw new TypeError('詳細fixtureが不正です。');
      }
      render(value);

      return undefined;
    });
  try {
    await vi.waitFor(() => expect(probe.read().delayedDetail.received).toBe(true));
    expect(delivered.first).toBe(false);
    controller.abort();
    history();
    requireValue(document.querySelectorAll('button')[1]).click();
    const value = parseJson(
      await (await browser.fetch(`/api/interviews/${requireValue(b).id}`)).text(),
    );
    if (!validateInterviewDetail(value)) {
      throw new TypeError('詳細fixtureが不正です。');
    }
    render(value);
    expect(historyIssues(probe.read(), fixtures)).toEqual([]);
    probe.releaseDetail();
    await first;
    expect(probe.read().selectedId).toBe(requireValue(b).id);
    expect(historyIssues(probe.read(), fixtures)).toContain('mixed-interview-detail');
    expect(requireValue(probe.read().requests[0]).finished).toBeGreaterThan(
      requireValue(requireValue(probe.read().requests[1]).finished),
    );
  } finally {
    probe.releaseDetail();
    await first;
  }
});
test('履歴クリック直後の画面反映待ちでも選択した面接IDを保持する', async () => {
  const fixtures = createFixtures('00000000-0000-4000-8000-000000000001');
  const a = requireValue(fixtures.interviews[0]);
  document.body.innerHTML = `<section><h2>面接履歴</h2><ul><li><button>${a.theme}</button></li></ul></section>`;
  vi.stubGlobal('fetch', vi.fn());
  await installHistoryObserver(document, browser, fixtures);
  requireValue(document.querySelector('button')).click();
  // Reactがまだ一覧を描画している間の観測でも、クリックの証拠を消さない。
  expect(requireValue(browser.bombadilHistory).read().selectedId).toBe(a.id);
  expect(requireValue(browser.bombadilHistory).read().listedIds).toEqual([a.id]);
});
test('実際に削除を確認した面接IDを要求へ対応付け、別IDへの削除を検出する', async () => {
  const fixtures = createFixtures('00000000-0000-4000-8000-000000000001');
  const [a, b] = fixtures.interviews;
  for (const id of [requireValue(b).id, requireValue(a).id]) {
    browser.bombadilHistory?.stop();
    browser.sessionStorage.clear();
    document.body.innerHTML = `<section><h2>面接履歴</h2><ul><li><button>${requireValue(a).theme}</button></li></ul></section>`;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 204 })),
    );
    await installHistoryObserver(document, browser, fixtures);
    requireValue(document.querySelector('button')).click();
    document.body.innerHTML = '<article><button>記録の削除</button></article>';
    requireValue(document.querySelector('button')).click();
    requireValue(document.querySelector('button')).textContent = 'この面接を削除する';
    requireValue(document.querySelector('button')).click();
    document.body.replaceChildren();
    await browser.fetch(`/api/interviews/${id}`, { method: 'DELETE' });
    const snapshot = requireValue(browser.bombadilHistory).read();
    if (id === requireValue(b).id) {
      expect(historyIssues(snapshot, fixtures)).toContain('unconfirmed-deletion');
    } else {
      expect(historyIssues(snapshot, fixtures)).toEqual([]);
    }
    expect(requireValue(snapshot.requests[0]).confirmedId).toBe(requireValue(a).id);
  }
});
test('実際の履歴選択・取消とHTTP取得を結び付け、詳細の固有値をDOMから観測する', async () => {
  const fixtures = createFixtures('00000000-0000-4000-8000-000000000001');
  const a = requireValue(fixtures.interviews[0]);
  document.body.innerHTML = `<section><h2>面接履歴</h2><ul><li><button>${a.theme}</button></li></ul></section>`;
  const fetch = vi.fn(async () => new Response(null, { status: 200 }));
  vi.stubGlobal('fetch', fetch);
  await installHistoryObserver(document, browser, fixtures);
  expect(requireValue(browser.bombadilHistory).read().listedIds).toEqual([a.id]);
  requireValue(document.querySelector('button')).click();
  document.body.innerHTML = `<button>準備と履歴へ戻る</button><article><h2>${a.theme}</h2>
    <section><h2>評価結果</h2><p>${a.summary}</p></section>
    <section><h3>保存済みの文字起こし</h3><ol><li id="transcript-1"><strong>あなた</strong> ${a.statement}</li></ol></section>
    <button>記録の削除</button></article>`;
  expect(requireValue(browser.bombadilHistory).read().detail).toEqual({
    selectedId: a.id,
    theme: a.theme,
    statements: [a.statement],
    summary: a.summary,
  });
  requireValue(document.querySelector<HTMLButtonElement>('article button')).click();
  requireValue(document.querySelector<HTMLButtonElement>('article button')).textContent =
    'キャンセル';
  requireValue(document.querySelector<HTMLButtonElement>('article button')).click();
  await browser.fetch('/api/local-session', { method: 'POST' });
  await browser.fetch(`/api/interviews/${a.id}`, { cache: 'no-store' });
  const snapshot = requireValue(browser.bombadilHistory).read();
  expect(snapshot.requests).toHaveLength(1);
  expect(snapshot.requests[0]).toMatchObject({ method: 'GET', id: a.id, status: 200 });
  expect(snapshot.cancellations).toHaveLength(1);
  expect(requireValue(snapshot.cancellations[0]).id).toBe(a.id);
  expect(requireValue(snapshot.cancellations[0]).checkedAt).toBe(
    requireValue(snapshot.requests[0]).finished,
  );
  expect(requireValue(snapshot.cancellations[0]).cancelled).toBeLessThan(
    requireValue(snapshot.requests[0]).started,
  );
  expect(fetch).toHaveBeenCalledTimes(2);
});
test('再初期化後も削除の証拠と要求順序を保持し、別fixtureへの混入は拒否する', async () => {
  const fixtures = createFixtures('00000000-0000-4000-8000-000000000001');
  const a = requireValue(fixtures.interviews[0]);
  document.body.innerHTML = `<section><h2>面接履歴</h2><ul><li><button>${a.theme}</button></li></ul></section>`;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      return requestUrl(input).includes('/api/interview-history')
        ? Response.json({ items: [], next: null })
        : new Response(null, { status: 404 });
    }),
  );
  await installHistoryObserver(document, browser, fixtures);
  requireValue(document.querySelector('button')).click();
  document.body.innerHTML = '<article><button>記録の削除</button></article>';
  requireValue(document.querySelector('button')).click();
  requireValue(document.querySelector('button')).textContent = 'この面接を削除する';
  requireValue(document.querySelector('button')).click();
  await browser.fetch(`/api/interviews/${a.id}`, { method: 'DELETE' });
  const completed = requireValue(requireValue(browser.bombadilHistory).read().requests[0]);
  requireValue(browser.bombadilHistory).stop();
  document.body.innerHTML =
    '<section><h2>面接履歴</h2><p>保存された面接はありません。</p></section>';
  await installHistoryObserver(document, browser, fixtures);
  expect(requireValue(browser.bombadilHistory).read().requests).toEqual([completed]);
  expect(requireValue(browser.bombadilHistory).read().generation).toBe(
    requireValue(completed.generation) + 1,
  );
  expect(requireValue(browser.bombadilHistory).read().selectedId).toBeNull();
  await browser.fetch('/api/interview-history', { cache: 'no-store' });
  await browser.fetch(`/api/interviews/${a.id}`, { cache: 'no-store' });
  const restored = requireValue(browser.bombadilHistory).read();
  expect(requireValue(restored.requests[1]).started).toBeGreaterThan(
    requireValue(completed.finished),
  );
  expect(restored.requests[2]).toMatchObject({ id: a.id, status: 404 });
  expect(historyIssues(restored, fixtures)).toEqual([]);
  requireValue(browser.bombadilHistory).stop();
  const other = createFixtures('00000000-0000-4000-8000-000000000002');
  await expect(installHistoryObserver(document, browser, other)).rejects.toThrow(/fixture/u);
});
test('履歴の保存済み観測を復元し、壊れた保存値はfetchを差し替える前に拒否する', async () => {
  const fixtures = createFixtures('00000000-0000-4000-8000-000000000001');
  const a = requireValue(fixtures.interviews[0]);
  const b = requireValue(fixtures.interviews[1]);
  const request = { method: 'GET', id: null, started: 1, finished: null, status: null };
  const saved = {
    version: 1,
    fixtureText: JSON.stringify(fixtures),
    generation: 4,
    tick: 9,
    selectedId: a.id,
    confirmation: { id: a.id, opened: 2 },
    confirmations: [a.id],
    requests: [
      request,
      {
        method: 'DELETE',
        id: a.id,
        started: 3,
        finished: 4,
        status: 204,
        confirmedId: a.id,
        generation: 4,
        history: { items: [{ interviewId: b.id }] },
      },
    ],
    cancellations: [
      { id: a.id, opened: 1, cancelled: 2, checkedAt: null },
      { id: b.id, opened: 3, cancelled: 4, checkedAt: 5 },
    ],
    integrityErrors: ['previous-observation-error'],
  };
  const original = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', original);
  document.body.innerHTML = `<article><h2>${a.theme}</h2></article>`;
  const key = 'bombadil-history-observation';
  browser.sessionStorage.setItem(key, JSON.stringify(saved));
  await installHistoryObserver(document, browser, fixtures);
  const probe = requireValue(browser.bombadilHistory);
  expect(probe.read()).toMatchObject({
    generation: 5,
    selectedId: a.id,
    confirmingId: a.id,
    requests: saved.requests,
    cancellations: saved.cancellations,
    integrityErrors: saved.integrityErrors,
  });
  probe.stop();
  browser.sessionStorage.setItem(
    key,
    JSON.stringify({ ...saved, selectedId: null, confirmation: null }),
  );
  await installHistoryObserver(document, browser, fixtures);
  const unselected = requireValue(browser.bombadilHistory);
  expect(unselected.read()).toMatchObject({
    selectedId: null,
    confirmingId: null,
    generation: 5,
    requests: saved.requests,
  });
  unselected.stop();
  const invalidRequests: string[] = [];
  for (const invalid of [
    { ...request, method: 'POST' },
    { ...request, id: 1 },
    { ...request, started: null },
    { ...request, finished: '4' },
    { ...request, status: '200' },
    { ...request, confirmedId: 1 },
    { ...request, generation: '4' },
    { ...request, history: null },
    { ...request, history: { items: false } },
    { ...request, history: { items: [1] } },
    { ...request, history: { items: [{ interviewId: null }] } },
  ]) {
    invalidRequests.push(JSON.stringify({ ...saved, requests: [invalid] }));
  }
  for (const text of [
    '{',
    '[]',
    '1',
    ...invalidRequests,
    ...[
      { ...saved, version: 2 },
      { ...saved, generation: '4' },
      { ...saved, selectedId: 1 },
      { ...saved, confirmation: [] },
      { ...saved, confirmation: { id: a.id, opened: '2' } },
      { ...saved, confirmations: [null] },
      { ...saved, requests: null },
      { ...saved, cancellations: [{ id: a.id, opened: 1, cancelled: 2, checkedAt: '5' }] },
      { ...saved, integrityErrors: [null] },
    ].map((invalid) => JSON.stringify(invalid)),
    JSON.stringify(saved).replace('"tick":9', '"tick":1e400'),
  ]) {
    browser.sessionStorage.setItem(key, text);
    await expect(installHistoryObserver(document, browser, fixtures)).rejects.toThrow();
    expect(browser.bombadilHistory).toBeUndefined();
    expect(browser).toHaveProperty('fetch', original);
  }
});
test('履歴観測は未知の表示・対象外通信・二重保留を区別し、停止時に他のfetchを上書きしない', async () => {
  const fixtures = createFixtures('00000000-0000-4000-8000-000000000001');
  const a = requireValue(fixtures.interviews[0]);
  const b = requireValue(fixtures.interviews[1]);
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ items: [] }));
  vi.stubGlobal('fetch', fetcher);
  await expect(
    installHistoryObserver(document.implementation.createHTMLDocument(), browser, fixtures),
  ).rejects.toThrow('探索に必要な値');
  document.body.innerHTML = '<section><h2>面接履歴</h2><output>読み込み中</output></section>';
  const clock = vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(10_001);
  try {
    await expect(installHistoryObserver(document, browser, fixtures, true)).rejects.toThrow(
      '読み込みが完了しません',
    );
  } finally {
    clock.mockRestore();
    browser.bombadilHistory?.stop();
    browser.sessionStorage.clear();
  }
  document.body.innerHTML = `<section><h2>面接履歴</h2><ul>
    <li><button>未知の面接</button></li><li><button>別の未知面接</button></li><li><button>${a.theme}</button></li>
    </ul></section><article><h2>${a.theme}</h2></article>
    <button disabled>記録の削除</button><button>準備と履歴へ戻る</button><button>キャンセル</button><button>この面接を削除する</button>`;
  await installHistoryObserver(document, browser, fixtures);
  const probe = requireValue(browser.bombadilHistory);
  const observed = Object.getOwnPropertyDescriptor(browser, 'fetch');
  await installHistoryObserver(document, browser, fixtures);
  expect(Object.getOwnPropertyDescriptor(browser, 'fetch')).toEqual(observed);
  expect(probe.read()).toMatchObject({
    listedIds: ['', '', a.id],
    integrityErrors: ['unknown-history-row'],
    detail: { selectedId: '' },
  });
  expect(probe.read().integrityErrors).toEqual(['unknown-history-row']);
  document.dispatchEvent(new Event('click'));
  document.body.click();
  const button = (title: string) =>
    requireValue(
      [...document.querySelectorAll('button')].find((element) => element.textContent === title),
    );
  button('記録の削除').dispatchEvent(new MouseEvent('click', { bubbles: true }));
  button('この面接を削除する').click();
  button('キャンセル').click();
  expect(probe.read().confirmingId).toBeNull();
  button(a.theme).click();
  button('準備と履歴へ戻る').click();
  expect(probe.read().selectedId).toBeNull();
  for (const [input, init] of [
    [
      new Request(new URL('/api/local-session', browser.location.href), { method: 'POST' }),
      undefined,
    ],
    [new URL('/api/interview-history', browser.location.href), { method: 'POST' }],
    [new URL(`/api/interviews/${a.id}`, browser.location.href), { method: 'PUT' }],
    [new URL(`https://example.com/api/interviews/${a.id}`), undefined],
  ] as const) {
    await browser.fetch(input, init);
  }
  expect(probe.read().requests).toEqual([]);
  await browser.fetch(new Request(new URL(`/api/interviews/${a.id}`, browser.location.href)));
  await browser.fetch(
    new Request(new URL(`/api/interviews/${a.id}`, browser.location.href), { method: 'DELETE' }),
  );
  expect(probe.read().requests.map((request) => request.method)).toEqual(['GET', 'DELETE']);
  button(a.theme).click();
  button('記録の削除').disabled = false;
  button('記録の削除').click();
  button('キャンセル').click();
  await browser.fetch(`/api/interviews/${b.id}`);
  expect(probe.read().cancellations.at(-1)?.checkedAt).toBeNull();
  await browser.fetch(`/api/interviews/${a.id}`);
  const checkedAt = probe.read().cancellations.at(-1)?.checkedAt;
  expect(checkedAt).toEqual(expect.any(Number));
  await browser.fetch(`/api/interviews/${a.id}`);
  expect(probe.read().cancellations.at(-1)?.checkedAt).toBe(checkedAt);
  expect(() => probe.holdNextDetail('unknown')).toThrow('保留条件が不正');
  probe.holdNextDetail(a.id);
  expect(() => probe.holdNextDetail(a.id)).toThrow('保留条件が不正');
  fetcher.mockResolvedValueOnce(new Response(null, { status: 204 }));
  const held = browser.fetch(`/api/interviews/${a.id}`);
  await expect.poll(() => probe.read().delayedDetail.received).toBe(true);
  await browser.fetch(`/api/interviews/${a.id}`);
  const replacement = vi.fn<typeof fetch>();
  browser.fetch = replacement;
  probe.stop();
  const response = await held;
  expect(response.status).toBe(204);
  expect(await response.text()).toBe('');
  expect(response.headers.get('Content-Type')).toBe('application/json');
  expect(browser).toHaveProperty('fetch', replacement);
  expect(browser.bombadilHistory).toBeUndefined();
});

test('1件目の404確認後でも、2件目の削除後に500が続けば未確認IDを保持する', async () => {
  const fixtures = createFixtures('00000000-0000-4000-8000-000000000001');
  const first = requireValue(fixtures.interviews[0]);
  const second = requireValue(fixtures.interviews[1]);
  const state = { secondStatus: 500 };
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (input, init) => {
      if (init?.method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      if (requestUrl(input) === '/api/interview-history') {
        return Response.json({ items: [], next: null });
      }
      return new Response(null, {
        status: requestUrl(input).endsWith(second.id) ? state.secondStatus : 404,
      });
    }),
  );
  document.body.innerHTML =
    '<section><h2>面接履歴</h2><p>保存された面接はありません。</p></section>';
  const coverage = () => readHistoryCoverage({ window: browser });
  expect(coverage().pendingDeletions).toBeNull();
  await installHistoryObserver(document, browser, fixtures);
  expect(coverage().pendingDeletions).toEqual([]);
  const reload = async () => {
    browser.bombadilHistory?.stop();
    expect(coverage().pendingDeletions).toBeNull();
    await installHistoryObserver(document, browser, fixtures);
  };
  await browser.fetch(`/api/interviews/${first.id}`, { method: 'DELETE' });
  await browser.fetch('/api/interview-history');
  await browser.fetch(`/api/interviews/${first.id}`);
  expect(coverage().pendingDeletions).toEqual([first.id]);
  await reload();
  await browser.fetch('/api/interview-history');
  await browser.fetch(`/api/interviews/${first.id}`);
  expect(coverage().pendingDeletions).toEqual([]);
  browser.sessionStorage.setItem(
    'bombadil-history-coverage',
    JSON.stringify({
      reached: [
        'opened-a',
        'opened-b',
        'cancelled-delete',
        'deleted-and-reloaded',
        'delayed-detail-isolated',
      ],
    }),
  );
  const outcome = () =>
    summarizeExploration({
      target: 'history',
      exitCode: 0,
      trace: JSON.stringify({
        action: 'Reload',
        snapshots: [{ name: 'coverage', value: coverage() }],
        violations: [],
      }),
    });
  expect(outcome().status).toBe('passed');
  await browser.fetch(`/api/interviews/${second.id}`, { method: 'DELETE' });
  await reload();
  await browser.fetch('/api/interview-history');
  await browser.fetch(`/api/interviews/${first.id}`);
  await browser.fetch(`/api/interviews/${second.id}`);
  expect(coverage().pendingDeletions).toEqual([second.id]);
  expect(outcome().status).toBe('incomplete');
  state.secondStatus = 404;
  await browser.fetch(`/api/interviews/${second.id}`);
  expect(coverage().pendingDeletions).toEqual([]);
  expect(outcome().status).toBe('passed');
});

test('履歴の到達判定は不正な保存値・削除記録・一覧に残ったIDを確認済みにしない', async () => {
  const key = 'bombadil-history-coverage';
  const coverage = () => readHistoryCoverage({ window: browser });
  for (const value of ['null', '[]', '1', '"text"', '{}', '{"reached":null}', '{"reached":[1]}']) {
    browser.sessionStorage.setItem(key, value);
    expect(coverage).toThrow();
  }
  browser.sessionStorage.removeItem(key);
  const fixtures = createFixtures('00000000-0000-4000-8000-000000000001');
  const fixture = requireValue(fixtures.interviews[0]);
  const state = { retained: true };
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (input, init) => {
      if (init?.method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      if (requestUrl(input) === '/api/interview-history') {
        return Response.json({
          items: state.retained ? [{ interviewId: fixture.id }] : [],
          next: null,
        });
      }
      return new Response(null, { status: 404 });
    }),
  );
  document.body.innerHTML =
    '<section><h2>面接履歴</h2><p>保存された面接はありません。</p></section>';
  await installHistoryObserver(document, browser, fixtures);
  await browser.fetch(`/api/interviews/${fixture.id}`, { method: 'DELETE' });
  browser.bombadilHistory?.stop();
  await installHistoryObserver(document, browser, fixtures);
  await browser.fetch('/api/interview-history');
  await browser.fetch(`/api/interviews/${fixture.id}`);
  expect(coverage().pendingDeletions).toEqual([fixture.id]);
  state.retained = false;
  await browser.fetch('/api/interview-history');
  expect(coverage().pendingDeletions).toEqual([]);
  const { requests } = requireValue(browser.bombadilHistory).read();
  const deletion = requireValue(requests.find((request) => request.method === 'DELETE'));
  const { generation } = deletion;
  delete deletion.generation;
  expect(coverage().pendingDeletions).toEqual([fixture.id]);
  deletion.generation = generation;
  requests.push({ ...deletion, id: null });
  expect(coverage).toThrow('削除成功の記録');
});
