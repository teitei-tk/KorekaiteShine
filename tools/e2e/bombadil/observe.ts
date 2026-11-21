import type { JsonValue } from '@korekaite/api-contracts/json';
import type {
  AnalysisObservation,
  PreparationObservation,
  PreparationView,
} from './preparation-model.ts';
export type PreparationSnapshot<Material = string> = {
  integrityErrors: string[];
  delayedAnalysis: {
    armed: boolean;
    received: boolean;
  };
} & PreparationObservation<Material>;
export type PreparationProbe = {
  read: () => PreparationSnapshot;
  holdNextAnalysis: () => void;
  releaseAnalysis: () => void;
  stop: () => void;
};
export type PreparationWindow = Window & { bombadilPreparation?: PreparationProbe };
// Bombadilは関数本体をブラウザへ渡すため、実行時の補助関数をすべて内側に置く。
export async function installPreparationObserver(
  document: Document,
  window: PreparationWindow,
  readyTitle = '',
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

  if (window.bombadilPreparation) {
    return;
  }
  if (readyTitle) {
    const end = performance.now() + 10_000;
    while (
      ![...document.querySelectorAll('button')].some(
        (button) => button.textContent.trim() === readyTitle,
      )
    ) {
      if (performance.now() >= end) {
        throw new Error('探索用履歴の読み込みが完了しませんでした。');
      }
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, 20);
      });
    }
  }
  const realm = requireValue(document.defaultView);
  const originalFetch = window.fetch;
  const state = {
    epoch: 0,
    tick: 0,
    textarea: null as HTMLTextAreaElement | null,
    markdown: '',
    timers: new Set<number>(),
    clicks: [] as {
      view: PreparationView;
      started: number;
    }[],
    requests: [] as AnalysisObservation[],
    edits: [] as PreparationObservation['edits'],
    integrityErrors: [] as string[],
    held: null as {
      promise: Promise<void>;
      resolve: () => void;
      claimed: boolean;
      received: boolean;
    } | null,
  };
  function tick() {
    state.tick += 1;
    return state.tick;
  }
  function view(): PreparationView | null {
    const textarea = document.querySelector<HTMLTextAreaElement>('fieldset textarea');
    if (textarea !== state.textarea) {
      state.textarea = textarea;
      if (textarea) {
        state.epoch += 1;
      }
    }
    if (!textarea) {
      return null;
    }
    state.markdown = textarea.value;
    const fieldset = requireValue(textarea.closest('fieldset'));
    const button = [...fieldset.querySelectorAll('button')].find(
      (item) => item.textContent.trim() === 'テーマを分析する',
    );
    const radios = [...fieldset.querySelectorAll<HTMLInputElement>('input[name="theme"]')];
    const selected = radios.findIndex((radio) => radio.checked);
    return {
      epoch: state.epoch,
      markdown: textarea.value,
      confirmed:
        fieldset.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked ?? false,
      pending: [...fieldset.querySelectorAll('output, [role="status"]')].some(
        (element) => element.textContent.trim() === '処理中…',
      ),
      analyzeDisabled: button?.matches(':disabled') ?? true,
      themes: radios.map((radio) => {
        const container = radio.closest('div');
        return {
          title: radio.closest('label')?.textContent.trim() ?? '',
          heading: container?.querySelector('blockquote small')?.textContent ?? '',
          excerpt: container?.querySelector('blockquote p')?.textContent ?? '',
        };
      }),
      selected: selected === -1 ? null : selected,
    };
  }
  function click(event: Event) {
    const button = event.target instanceof realm.Element ? event.target.closest('button') : null;
    if (button?.textContent.trim() !== 'テーマを分析する' || button.matches(':disabled')) {
      return;
    }
    const current = view();
    if (current) {
      state.clicks.push({ view: current, started: tick() });
    }
  }
  function input(event: Event) {
    const { textarea } = state;
    const { markdown } = state;
    const current = view();
    if (event.target !== textarea || !current || current.markdown === markdown) {
      return;
    }
    const before = { ...current, markdown };
    const timer = window.setTimeout(() => {
      state.timers.delete(timer);
      const after = view();
      if (after?.epoch === before.epoch) {
        state.edits.push({ before, after });
      }
    }, 0);
    state.timers.add(timer);
  }
  document.addEventListener('click', click, true);
  document.addEventListener('input', input, true);
  view();
  const observedFetch: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string' || input instanceof realm.URL ? String(input) : input.url,
      window.location.href,
    );
    const method = (
      init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')
    ).toUpperCase();
    if (
      url.origin !== window.location.origin ||
      url.pathname !== '/api/materials/analyze' ||
      method !== 'POST'
    ) {
      return originalFetch.call(window, input, init);
    }
    const clicked = state.clicks.shift();
    const body = typeof init?.body === 'string' ? jsonRecord(parseJsonValue(init.body)) : null;
    if (
      !clicked ||
      !body ||
      typeof body.markdown !== 'string' ||
      typeof body.confirmed !== 'boolean'
    ) {
      state.integrityErrors.push('unmatched-analysis-request');
      return originalFetch.call(window, input, init);
    }
    const request: AnalysisObservation = {
      body: { markdown: body.markdown, confirmed: body.confirmed },
      markdown: clicked.view.markdown,
      confirmed: clicked.view.confirmed,
      epoch: clicked.view.epoch,
      started: clicked.started,
      finished: null,
      response: null,
    };
    state.requests.push(request);
    const held = state.held && !state.held.claimed ? state.held : null;
    if (held) {
      held.claimed = true;
    }
    try {
      const response = await originalFetch.call(window, input, init);
      if (response.ok) {
        const payload = jsonRecord(parseJsonValue(await response.clone().text()));
        if (typeof payload.analysisId !== 'string' || !Array.isArray(payload.themes)) {
          throw new TypeError('分析応答の観測値が不正です。');
        }
        const themes = payload.themes.map((value) => {
          const theme = jsonRecord(value);
          if (
            typeof theme.title !== 'string' ||
            typeof theme.heading !== 'string' ||
            typeof theme.excerpt !== 'string'
          ) {
            throw new TypeError('分析候補の観測値が不正です。');
          }
          return { title: theme.title, heading: theme.heading, excerpt: theme.excerpt };
        });
        request.response = { analysisId: payload.analysisId, themes };
      }
      if (held) {
        held.received = true;
        await held.promise;
        if (request.response) {
          // 受信済みの分析結果だけを遅延配送する。離脱後のAbortにも結果を届け、古い応答の無視を検査する。
          return new realm.Response(JSON.stringify(request.response), {
            status: response.status,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      }
      return response;
    } finally {
      request.finished = tick();
    }
  };
  window.fetch = observedFetch;
  window.bombadilPreparation = {
    read: () => ({
      view: view(),
      requests: state.requests,
      edits: state.edits,
      integrityErrors: state.integrityErrors,
      delayedAnalysis: { armed: state.held !== null, received: state.held?.received ?? false },
    }),
    holdNextAnalysis: () => {
      if (state.held) {
        throw new Error('分析応答はすでに保留されています。');
      }
      const deferred = Promise.withResolvers<undefined>();
      state.held = {
        promise: deferred.promise,
        resolve: () => {
          deferred.resolve(undefined);
        },
        claimed: false,
        received: false,
      };
    },
    releaseAnalysis: () => {
      state.held?.resolve();
      state.held = null;
    },
    stop: () => {
      state.held?.resolve();
      document.removeEventListener('click', click, true);
      document.removeEventListener('input', input, true);
      for (const timer of state.timers) {
        window.clearTimeout(timer);
      }
      if (window.fetch === observedFetch) {
        window.fetch = originalFetch;
      }
      delete window.bombadilPreparation;
    },
  };
}

/** 同じ本文は1回だけ保存し、過去の要求と編集は辞書の番号で参照する。 */
export type PreparationRecording = PreparationSnapshot<number> & { materials: string[] };

// Native extractへ渡すため、実行時の処理を関数内へ閉じ込める。
export function readPreparationSnapshot({
  window,
}: {
  window: PreparationWindow;
}): PreparationRecording | null {
  const snapshot = window.bombadilPreparation?.read();
  if (!snapshot) {
    return null;
  }
  const materials: string[] = [];
  const indices = new Map<string, number>();
  function material(text: string): number {
    const previous = indices.get(text);
    if (previous !== undefined) {
      return previous;
    }
    const index = materials.length;
    materials.push(text);
    indices.set(text, index);
    return index;
  }
  function view(value: PreparationView): PreparationView<number> {
    return { ...value, markdown: material(value.markdown) };
  }
  return structuredClone({
    ...snapshot,
    materials,
    view: snapshot.view ? view(snapshot.view) : null,
    requests: snapshot.requests.map((request) => ({
      ...request,
      markdown: material(request.markdown),
      body: { ...request.body, markdown: material(request.body.markdown) },
    })),
    edits: snapshot.edits.map((edit) => ({ before: view(edit.before), after: view(edit.after) })),
  });
}

/** 性質と操作生成には元の観測を渡し、本文の比較やUTF-8判定を変えない。 */
export function restorePreparationSnapshot(
  recording: PreparationRecording | null,
): PreparationSnapshot | null {
  if (recording === null) {
    return null;
  }
  const { materials, ...snapshot } = recording;
  function material(index: number): string {
    const text = materials[index];
    if (text === undefined) {
      throw new Error('観測材料の参照が不正です。');
    }
    return text;
  }
  function view(value: PreparationView<number>): PreparationView {
    return { ...value, markdown: material(value.markdown) };
  }
  return {
    ...snapshot,
    view: snapshot.view ? view(snapshot.view) : null,
    requests: snapshot.requests.map((request) => ({
      ...request,
      markdown: material(request.markdown),
      body: { ...request.body, markdown: material(request.body.markdown) },
    })),
    edits: snapshot.edits.map((edit) => ({ before: view(edit.before), after: view(edit.after) })),
  };
}
