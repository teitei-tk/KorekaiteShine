import type { JsonValue } from '@korekaite/api-contracts/json';
import type { ExplorationFixtures } from './fixtures.ts';
import type { HistoryObservation, HistoryRequest, DeletionCancellation } from './history-model.ts';
export type HistorySnapshot = {
  emptyHistory: boolean;
  delayedDetail: {
    id: string | null;
    received: boolean;
  };
  generation: number;
  selectedId: string | null;
  confirmingId: string | null;
  integrityErrors: string[];
} & HistoryObservation;
export type HistoryProbe = {
  read: () => HistorySnapshot;
  holdNextDetail: (id: string) => void;
  releaseDetail: () => void;
  stop: () => void;
};
export type HistoryWindow = Window & { bombadilHistory?: HistoryProbe };
// ブラウザへ直列化するため、実行時の補助関数はこの関数内に置く。
export async function installHistoryObserver(
  document: Document,
  window: HistoryWindow,
  fixtures: ExplorationFixtures,
  waitForHistory = false,
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

  function readString(value: JsonValue | undefined): string {
    if (typeof value !== 'string') {
      throw new TypeError('観測値が文字列ではありません。');
    }
    return value;
  }
  function readNumber(value: JsonValue | undefined): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new TypeError('観測値が数値ではありません。');
    }
    return value;
  }
  function readArray(value: JsonValue | undefined): JsonValue[] {
    if (!Array.isArray(value)) {
      throw new TypeError('観測値が配列ではありません。');
    }
    return value;
  }
  function readHistory(value: JsonValue) {
    return {
      items: readArray(jsonRecord(value).items).map((item) => ({
        interviewId: readString(jsonRecord(item).interviewId),
      })),
    };
  }
  function readRequest(value: JsonValue): HistoryRequest {
    const row = jsonRecord(value);
    if (row.method !== 'GET' && row.method !== 'DELETE') {
      throw new Error('観測メソッドが不正です。');
    }
    return {
      method: row.method,
      id: row.id === null ? null : readString(row.id),
      started: readNumber(row.started),
      finished: row.finished === null ? null : readNumber(row.finished),
      status: row.status === null ? null : readNumber(row.status),
      ...(row.confirmedId === undefined ? {} : { confirmedId: readString(row.confirmedId) }),
      ...(row.generation === undefined ? {} : { generation: readNumber(row.generation) }),
      ...(row.history === undefined ? {} : { history: readHistory(row.history) }),
    };
  }
  if (window.bombadilHistory) {
    return;
  }
  const fixtureText = JSON.stringify(fixtures);
  const realm = requireValue(document.defaultView);
  const originalFetch = window.fetch;
  const storageKey = 'bombadil-history-observation';
  const initial = {
    version: 1,
    fixtureText,
    generation: 0,
    tick: 0,
    selectedId: null as string | null,
    confirmation: null as {
      id: string;
      opened: number;
    } | null,
    confirmations: [] as string[],
    requests: [] as HistoryRequest[],
    cancellations: [] as DeletionCancellation[],
    integrityErrors: [] as string[],
  };
  const savedValue = parseJsonValue(window.sessionStorage.getItem(storageKey) ?? 'null');
  const saved = savedValue === null ? null : jsonRecord(savedValue);
  if (saved && (saved.version !== 1 || saved.fixtureText !== fixtureText)) {
    throw new Error('保存された観測のfixtureが一致しません。');
  }
  function restore(row: Record<string, JsonValue>): typeof initial {
    const confirmation = row.confirmation === null ? null : jsonRecord(row.confirmation);
    return {
      version: 1,
      fixtureText,
      generation: readNumber(row.generation),
      tick: readNumber(row.tick),
      selectedId: row.selectedId === null ? null : readString(row.selectedId),
      confirmation:
        confirmation === null
          ? null
          : { id: readString(confirmation.id), opened: readNumber(confirmation.opened) },
      confirmations: readArray(row.confirmations).map((value) => readString(value)),
      requests: readArray(row.requests).map((value) => readRequest(value)),
      cancellations: readArray(row.cancellations).map((value) => {
        const cancel = jsonRecord(value);
        return {
          id: readString(cancel.id),
          opened: readNumber(cancel.opened),
          cancelled: readNumber(cancel.cancelled),
          checkedAt: cancel.checkedAt === null ? null : readNumber(cancel.checkedAt),
        };
      }),
      integrityErrors: readArray(row.integrityErrors).map((value) => readString(value)),
    };
  }
  const state = saved === null ? initial : restore(saved);
  const delay = {
    current: null as {
      id: string;
      claimed: boolean;
      received: boolean;
      promise: Promise<void>;
      resolve: () => void;
    } | null,
  };
  state.generation += 1;
  if (!document.querySelector('article')) {
    state.selectedId = null;
    state.confirmation = null;
  }
  const save = () => window.sessionStorage.setItem(storageKey, JSON.stringify(state));
  save();
  function tick() {
    state.tick += 1;
    return state.tick;
  }
  function read(): HistorySnapshot {
    const article = document.querySelector('article');
    const theme = article?.querySelector(':scope > h2')?.textContent ?? null;
    const report = [...(article?.querySelectorAll('section') ?? [])].find(
      (section) => section.querySelector(':scope > h2')?.textContent.trim() === '評価結果',
    );
    const detail =
      theme === null
        ? null
        : {
            selectedId: state.selectedId ?? '',
            theme,
            statements: [...requireValue(article).querySelectorAll('li[id^="transcript-"]')].map(
              (item) =>
                [...item.childNodes]
                  .filter((node): node is Text => node.nodeType === realm.Node.TEXT_NODE)
                  .map((node) => node.data)
                  .join('')
                  .trim(),
            ),
            summary: report?.querySelector(':scope > p')?.textContent ?? null,
          };
    const history = [...document.querySelectorAll('section')].find(
      (section) => section.querySelector(':scope > h2')?.textContent.trim() === '面接履歴',
    );
    const loading = !!history?.querySelector('output, [role="status"], [role="alert"]');
    const listedIds =
      history && !loading
        ? [...history.querySelectorAll('li button')].map((button) => {
            const fixture = fixtures.interviews.find(
              (item) => item.theme === button.textContent.trim(),
            );
            if (!fixture && !state.integrityErrors.includes('unknown-history-row')) {
              state.integrityErrors.push('unknown-history-row');
            }
            return fixture?.id ?? '';
          })
        : null;
    save();
    return {
      emptyHistory:
        history !== undefined &&
        listedIds?.length === 0 &&
        [...history.querySelectorAll(':scope > p')].some(
          (paragraph) => paragraph.textContent.trim() === '保存された面接はありません。',
        ),
      delayedDetail: { id: delay.current?.id ?? null, received: delay.current?.received ?? false },
      generation: state.generation,
      detail,
      listedIds,
      selectedId: state.selectedId,
      confirmingId: state.confirmation?.id ?? null,
      requests: state.requests,
      cancellations: state.cancellations,
      integrityErrors: state.integrityErrors,
    };
  }
  function click(event: Event) {
    const button = event.target instanceof realm.Element ? event.target.closest('button') : null;
    if (!button || button.matches(':disabled')) {
      return;
    }
    const title = button.textContent.trim();
    const fixture = fixtures.interviews.find((item) => item.theme === title);
    if (fixture) {
      state.selectedId = fixture.id;
      state.confirmation = null;
    } else if (title === '準備と履歴へ戻る') {
      state.selectedId = null;
      state.confirmation = null;
    } else if (title === '記録の削除' && state.selectedId) {
      state.confirmation = { id: state.selectedId, opened: tick() };
    } else if (title === 'キャンセル' && state.confirmation) {
      state.cancellations.push({ ...state.confirmation, cancelled: tick(), checkedAt: null });
      state.confirmation = null;
    } else if (title === 'この面接を削除する' && state.confirmation) {
      state.confirmations.push(state.confirmation.id);
      state.confirmation = null;
    }
    save();
  }
  document.addEventListener('click', click, true);
  const observedFetch: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string' || input instanceof realm.URL ? String(input) : input.url,
      window.location.href,
    );
    const method = (
      init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')
    ).toUpperCase();
    const match = /^\/api\/interviews\/(?<id>[^/]+)$/u.exec(url.pathname);
    const history = url.pathname === '/api/interview-history';
    if (
      url.origin !== window.location.origin ||
      (!match && !history) ||
      (method !== 'GET' && method !== 'DELETE') ||
      (history && method !== 'GET')
    ) {
      return originalFetch.call(window, input, init);
    }
    const request: HistoryRequest = {
      generation: state.generation,
      method,
      id: match ? decodeURIComponent(requireValue(match.groups?.id)) : null,
      started: tick(),
      finished: null,
      status: null,
    };
    if (method === 'DELETE') {
      const index = state.confirmations.indexOf(requireValue(request.id));
      const [confirmedId] = state.confirmations.splice(index === -1 ? 0 : index, 1);
      request.confirmedId = confirmedId;
    }
    state.requests.push(request);
    save();
    const held =
      method === 'GET' && delay.current?.id === request.id && !delay.current.claimed
        ? delay.current
        : null;
    if (held) {
      held.claimed = true;
    }
    try {
      const response = await originalFetch.call(window, input, init);
      request.status = response.status;
      if (history && response.status === 200) {
        request.history = readHistory(parseJsonValue(await response.clone().text()));
      }
      if (held) {
        const text = await response.clone().text();
        held.received = true;
        await held.promise;
        // 受信済みの詳細を離脱後にも届け、画面側の古い応答の無視を検査する。
        return new realm.Response([204, 205, 304].includes(response.status) ? null : text, {
          status: response.status,
          headers: { 'Content-Type': response.headers.get('Content-Type') ?? 'application/json' },
        });
      }
      return response;
    } finally {
      request.finished = tick();
      if (method === 'GET') {
        const cancel = state.cancellations.find(
          (item) =>
            item.id === request.id && item.checkedAt === null && item.cancelled < request.started,
        );
        if (cancel) {
          cancel.checkedAt = request.finished;
        }
      }
      save();
    }
  };
  window.fetch = observedFetch;
  window.bombadilHistory = {
    read,
    holdNextDetail: (id) => {
      if (delay.current || !fixtures.interviews.some((fixture) => fixture.id === id)) {
        throw new Error('詳細応答の保留条件が不正です。');
      }
      const deferred = Promise.withResolvers<undefined>();
      delay.current = {
        id,
        claimed: false,
        received: false,
        promise: deferred.promise,
        resolve: () => {
          deferred.resolve(undefined);
        },
      };
    },
    releaseDetail: () => {
      delay.current?.resolve();
      delay.current = null;
    },
    stop: () => {
      delay.current?.resolve();
      save();
      document.removeEventListener('click', click, true);
      if (window.fetch === observedFetch) {
        window.fetch = originalFetch;
      }
      delete window.bombadilHistory;
    },
  };
  if (waitForHistory) {
    const end = performance.now() + 10_000;
    while (read().listedIds === null) {
      if (performance.now() >= end) {
        throw new Error('探索用履歴の読み込みが完了しませんでした。');
      }
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, 20);
      });
    }
  }
}

/** Native extractへ渡すため、ブラウザ側で自己完結して到達と未確認の削除を観測する。 */
export function readHistoryCoverage({ window }: { window: HistoryWindow }): {
  reached: string[];
  pendingDeletions: string[] | null;
} {
  const value = JSON.parse(
    window.sessionStorage.getItem('bombadil-history-coverage') ?? '{"reached":[]}',
  ) as JsonValue;
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !Array.isArray(value.reached)
  ) {
    throw new Error('到達記録が不正です。');
  }
  const reached = value.reached.map((marker) => {
    if (typeof marker !== 'string') {
      throw new TypeError('到達記録が文字列ではありません。');
    }
    return marker;
  });
  const snapshot = window.bombadilHistory?.read();
  if (!snapshot) {
    return { reached, pendingDeletions: null };
  }
  const deleted = snapshot.requests.filter(
    (request) => request.method === 'DELETE' && request.status === 204 && request.finished !== null,
  );
  const pendingDeletions = deleted.flatMap((deletion) => {
    const { id, finished, generation } = deletion;
    if (id === null || finished === null) {
      throw new Error('削除成功の記録が不正です。');
    }
    const fresh = snapshot.requests.filter(
      (request) =>
        request.method === 'GET' &&
        request.finished !== null &&
        request.started > finished &&
        request.generation === snapshot.generation,
    );
    const verified =
      generation !== undefined &&
      snapshot.generation > generation &&
      fresh.some(
        (request) =>
          request.id === null &&
          request.status === 200 &&
          request.history !== undefined &&
          !request.history.items.some((item) => item.interviewId === id),
      ) &&
      fresh.some((request) => request.id === id && request.status === 404);
    return verified ? [] : [id];
  });
  return { reached, pendingDeletions };
}
