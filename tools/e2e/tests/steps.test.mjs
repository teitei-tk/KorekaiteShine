// @vitest-environment jsdom
import { URL as NodeURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { afterEach, expect, test, vi } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { startVoiceRuntime } from '../runtime.mjs';
import { speak, waitForPlayback } from '../media.mjs';
const hooks = vi.hoisted(() => ({ steps: new Map() }));
vi.mock('@cucumber/cucumber', () => {
  const register = (name, action) => hooks.steps.set(name, action);
  return {
    Before: (action) => {
      hooks.before = action;
    },
    After: (action) => {
      hooks.after = action;
    },
    Given: register,
    When: register,
    Then: register,
    setDefaultTimeout: vi.fn(),
  };
});
vi.mock('playwright', () => ({ chromium: { launch: vi.fn() } }));
vi.mock('../runtime.mjs', () => ({ startVoiceRuntime: vi.fn() }));
vi.mock('../media.mjs', () => ({
  fakeMediaArgs: [],
  installMediaProbe: vi.fn(),
  playbackCount: vi.fn(() => 1),
  waitForQuiet: vi.fn(),
  waitForOpening: vi.fn(),
  waitForPlayback: vi.fn(),
  speak: vi.fn(),
}));
vi.mock('node:timers/promises', () => ({ setTimeout: vi.fn() }));
await import('../steps.mjs');
const feature = readFileSync(
  new NodeURL('../features/voice-interview.feature', import.meta.url),
  'utf8',
);
const [background, ...scenarios] = feature.split(/^[ \t]*シナリオ: /m);
const stepNames = (section) =>
  [...section.matchAll(/^\s*(?:前提|もし|かつ|ならば) (.+)$/gm)].map((match) => match[1]);
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  document.body.replaceChildren();
  delete window.restoreInterviewNetwork;
  delete window.voiceE2e;
});

// 同じ受け入れ条件に模擬ブラウザの観測結果を与え、失敗を検知する側も検証する。
async function observer() {
  const world = {};
  const timeContext = { time: 0, started: null, active: 0, generation: 1, refused: false };
  const questionState = {
    silent: false,
    currentQuestion: undefined,
    held: undefined,
    receiveInOtherTab: undefined,
  };
  const transcripts = [];
  const questions = {
    言い換えを依頼: '具体的な役割は何ですか。',
    質問を見送る: '他の手段をなぜ選びませんでしたか。',
  };
  vi.spyOn(performance, 'now').mockImplementation(() => timeContext.time);
  delay.mockImplementation(async (ms) => {
    timeContext.time += ms;
  });
  const close = () => {
    if (timeContext.started !== null) {
      timeContext.active += timeContext.time - timeContext.started;
      timeContext.started = null;
    }
  };
  const settings = {
    url: 'http://127.0.0.1:4327',
    omitNextOpening: vi.fn(),
    extendNextOpening: vi.fn(),
    holdNextQuestion: () =>
      new Promise((resolve) => {
        questionState.held = resolve;
      }),
    muteReplies: vi.fn(),
    silenceCurrentConnections: () => {
      questionState.silent = true;
    },
    rejectDials: (value) => {
      timeContext.refused = value;
    },
    stop: vi.fn(),
    restart: vi.fn(),
  };
  startVoiceRuntime.mockResolvedValue(settings);
  const page = {
    setDefaultTimeout: vi.fn(),
    goto: vi.fn(),
    route: vi.fn(),
    routeWebSocket: vi.fn(),
    waitForFunction: vi.fn(),
    waitForResponse: vi.fn(),
    evaluate: (fn) => fn(),
    exposeFunction: (key, fn) => {
      window[key] = fn;
    },
  };
  const context = { newPage: () => page, request: { get: async () => ({ status: () => 403 }) } };
  const browser = { newContext: () => context, close: vi.fn() };
  chromium.launch.mockResolvedValue(browser);
  const inputContext = { input: undefined, output: undefined };
  const server = {
    send: vi.fn(),
    close,
    onMessage: (fn) => {
      inputContext.output = fn;
    },
  };
  const client = {
    send: vi.fn(),
    close: vi.fn(),
    onMessage: (fn) => {
      inputContext.input = fn;
    },
    connectToServer: () => server,
  };
  page.on = (_event, listen) =>
    listen({
      on: (_frame, receive) => {
        questionState.receiveInOtherTab = receive;
        receive({ payload: Buffer.alloc(1) });
      },
    });
  const emit = (event) => {
    const payload = JSON.stringify(event);
    inputContext.output(payload);
    questionState.receiveInOtherTab?.({ payload });
  };
  const locator = (name) => ({
    waitFor: vi.fn(),
    isVisible: async () => false,
    evaluate: (fn) => fn({ nextElementSibling: { textContent: questionState.currentQuestion } }),
    first() {
      return this;
    },
    filter() {
      return this;
    },
    check: vi.fn(),
    setInputFiles: async (file) => {
      const field = document.createElement('textarea');
      field.value = file.buffer.toString();
      document.body.append(field);
    },
    click: async () => {
      if (questions[name]) {
        timeContext.generation++;
        if (questionState.held) {
          questionState.held();
          questionState.held = undefined;
          questionState.currentQuestion = questions[name];
          transcript('assistant', '前の質問から遅れて届いた続きです。');
          return;
        }
        questionState.currentQuestion = questions[name];
        transcript('assistant', questionState.currentQuestion, true);
        window.voiceE2e.playedFrequencies.push(440);
      }
      if (
        ['このタブで引き継ぐ', 'マイクを許可して再開'].includes(name) &&
        questionState.currentQuestion
      ) {
        timeContext.generation++;
        transcript('assistant', questionState.currentQuestion, true);
        window.voiceE2e.playedFrequencies.push(440);
      }
      if (name === 'マイクを許可して開始' && timeContext.refused) {
        emit({ type: 'error', code: 'AUDIO_CONNECT_FAILED' });
        return;
      }
      if (['マイクを許可して開始', 'マイクを許可して再開', '再接続'].includes(name)) {
        if (name === '再接続') {
          document.body.click();
          const button = document.createElement('button');
          button.textContent = name;
          document.body.append(button);
          button.click();
          timeContext.generation++;
        }
        if (name === 'マイクを許可して再開') {
          timeContext.generation++;
          questionState.silent = false;
        }
        timeContext.started = timeContext.time;
        emit({ type: 'state', interviewId: 'one', status: 'active' });
      } else if (['一時停止', '音声をつなぎ直す', '終了して評価する'].includes(name)) {
        close();
      }
    },
  });
  page.getByRole = (_role, options) => locator(options?.name);
  page.getByLabel = page.getByText = page.locator = locator;
  page.waitForFunction.mockImplementation((fn, arg) => expect(fn(arg)).toBe(true));
  page.waitForResponse.mockImplementation(async (predicate) => {
    const response = (path, method, value) => ({
      ok: () => true,
      status: () => 200,
      url: () => settings.url + path,
      request: () => ({ method: () => method }),
      json: async () => value,
    });
    const responses = [
      response('/irrelevant', 'GET', {}),
      response('/api/interviews', 'GET', {}),
      response('/api/interviews', 'POST', { interviewId: 'one', theme: '題材' }),
      response('/api/interviews/one', 'GET', {
        session: { interviewId: 'one', activeMs: timeContext.active },
        audioRemainingMs: 3600000 - timeContext.active,
        transcripts: [...transcripts],
      }),
    ];
    const match = responses.find(predicate);
    expect(match).toBeDefined();
    return match;
  });
  window.voiceE2e = { speaking: true, playedFrequencies: [] };
  await hooks.before.call(world);
  const relay = page.routeWebSocket.mock.calls[0][1];
  relay(client);
  const voice = Buffer.alloc(12);
  voice.writeInt16LE(500, 10);
  function transcript(speaker, content = speaker, startsQuestion = false) {
    const event = {
      type: 'transcript',
      speaker,
      content,
      startsQuestion,
      sequence: transcripts.length,
      fragmentId: String(transcripts.length),
      generation: timeContext.generation,
    };
    transcripts.push(event);
    emit(event);
  }
  window.voiceE2e.speak = () => inputContext.input(voice);
  speak.mockImplementation(async () => {
    for (const _ of Array(3).keys()) {
      inputContext.input(voice);
    }
    if (!questionState.silent) {
      transcript('user');
      transcript('assistant');
    }
  });
  return {
    world,
    relay,
    client,
    server,
    input: inputContext.input,
    output: inputContext.output,
    page,
    context,
    emit,
    close,
    browser,
  };
}

test.each(scenarios.map((section) => [section.split('\n')[0], section]))(
  '観測した利用時間・音声・保存内容を照合する：%s',
  async (_title, section) => {
    const { world } = await observer();
    for (const name of [...stepNames(background), ...stepNames(section)]) {
      await hooks.steps.get(name).call(world);
    }
    await hooks.after.call(world, { result: { status: 'PASSED' } });
  },
);

test('停止中の通信を拒否し、失敗の診断には状態とエラーだけを残す', async () => {
  vi.stubEnv('E2E_PROFILE', 'pr');
  vi.stubEnv('E2E_CHROME_PATH', '/test/chrome');
  const { world, page, relay, client, input, output, server, emit, browser } = await observer();
  const route = { abort: vi.fn(), continue: vi.fn() };
  const request = page.route.mock.calls[0][1];
  request(route);
  world.offline = true;
  request(route);
  expect(route.abort).toHaveBeenCalledWith('internetdisconnected');
  expect(route.continue).toHaveBeenCalled();
  relay(client);
  expect(client.close).toHaveBeenCalled();
  input('sync');
  output(Buffer.alloc(1));
  expect(server.send).toHaveBeenCalledWith('sync');
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  emit({ type: 'state', status: 'active' });
  emit({ type: 'transcript', content: '非公開' });
  emit({ type: 'error', code: 'STALE_STATE' });
  await hooks.after.call(world, { result: { status: 'FAILED' } });
  expect(log).toHaveBeenCalledWith('面接の状態:', 'active → STALE_STATE');
  expect(browser.close).toHaveBeenCalled();
  await hooks.after.call({}, {});
  await hooks.after.call({}, { result: { status: 'FAILED' } });
});

test('再生だけで発話への応答と判定せず、順序と発話フレームの期限を検査する', async () => {
  const { world } = await observer();
  world.beforeAnswer = 0;
  world.events.push(
    { type: 'state' },
    { type: 'transcript', content: '', speaker: 'assistant' },
    { type: 'transcript', content: '質問', speaker: 'assistant' },
    { type: 'transcript', content: '回答', speaker: 'user' },
  );
  await expect(
    hooks.steps.get('ブラウザで面接官の音声応答が再生される').call(world),
  ).rejects.toThrow('新しい文字起こし');
  expect(waitForPlayback).toHaveBeenCalled();
  speak.mockResolvedValue(undefined);
  await expect(hooks.steps.get('次の発話途中で回線が切れる').call(world)).rejects.toThrow(
    '音声フレーム',
  );
});

test('質問を切り替えた後の見出し・保存世代・音声を検査する', async () => {
  const { world } = await observer();
  const step = (name, ...args) => hooks.steps.get(name).call(world, ...args);
  await step('架空の経験Markdownからテーマを選び面接を準備した');
  await step('回答せずに質問を言い換えて見送る');
  await step('最後の質問だけが現在の質問になり、前の質問も会話に残る');
  window.voiceE2e.playedFrequencies.push(880);
  await expect(
    step('「{word}」の質問が単独で表示され音声を聞いて回答できる', '質問を見送る'),
  ).rejects.toThrow('旧接続の遅延音声');
});

test.each(['質問を見送る', '言い換えを依頼'])(
  '返答前に%sを選び、最後に選んだ質問を検査する',
  async (next) => {
    const { world } = await observer();
    const step = (name, ...args) => hooks.steps.get(name).call(world, ...args);
    await step('架空の経験Markdownからテーマを選び面接を準備した');
    await step('「{word}」の返事を保留してから「{word}」を押す', '言い換えを依頼', next);
    await step('「{word}」の質問が単独で表示され音声を聞いて回答できる', next);
  },
);

test.each(['面接中', '一時停止中'])(
  '%sから別タブに引き継ぎ、新タブで音声と応答を検査する',
  async (state) => {
    const { world } = await observer();
    const step = (name, ...args) => hooks.steps.get(name).call(world, ...args);
    await step('架空の経験Markdownからテーマを選び面接を準備した');
    await step('元のタブで見送りを受理した音声AIが返事を保留する');
    await step('同じ面接を別のタブで開き「{word}」から引き継ぐ', state);
    await step('新しい担当タブで回答して返答を聞ける');
    await step('新しい担当タブで見送り後の質問だけを聞いて回答できる');
  },
);

test('応答待ちの一時停止と長い質問中の発話を検査する', async () => {
  const { world } = await observer();
  const step = (name, ...args) => hooks.steps.get(name).call(world, ...args);
  await step('架空の経験Markdownからテーマを選び面接を準備した');
  await step('最初の質問を聞いて応答しない音声AIに言い換えを依頼する');
  await step('見送りの返事を保留してから一時停止して再開する');
  await step('「{word}」の質問が単独で表示され音声を聞いて回答できる', '質問を見送る');
  await step('長い質問を聞きながら返事をして音声AIが応答しなくなる');
});
