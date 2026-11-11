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
  let time = 0,
    started = null,
    active = 0,
    generation = 1,
    refused = false;
  let silent = false;
  const transcripts = [];
  vi.spyOn(performance, 'now').mockImplementation(() => time);
  delay.mockImplementation(async (ms) => {
    time += ms;
  });
  const close = () => {
    if (started !== null) {
      active += time - started;
      started = null;
    }
  };
  const settings = {
    url: 'http://127.0.0.1:4327',
    omitNextOpening: vi.fn(),
    muteReplies: vi.fn(),
    silenceCurrentConnections: () => {
      silent = true;
    },
    rejectDials: (value) => {
      refused = value;
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
  let input, output;
  const server = {
    send: vi.fn(),
    close,
    onMessage: (fn) => {
      output = fn;
    },
  };
  const client = {
    send: vi.fn(),
    close: vi.fn(),
    onMessage: (fn) => {
      input = fn;
    },
    connectToServer: () => server,
  };
  const emit = (event) => output(JSON.stringify(event));
  const locator = (name) => ({
    waitFor: vi.fn(),
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
      if (name === 'マイクを許可して開始' && refused) {
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
          generation++;
        }
        if (name === 'マイクを許可して再開') {
          generation++;
          silent = false;
        }
        started = time;
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
        session: { interviewId: 'one', activeMs: active },
        audioRemainingMs: 3600000 - active,
        transcripts: [...transcripts],
      }),
    ];
    const match = responses.find(predicate);
    expect(match).toBeDefined();
    return match;
  });
  window.voiceE2e = { speaking: true };
  await hooks.before.call(world);
  const relay = page.routeWebSocket.mock.calls[0][1];
  relay(client);
  const voice = Buffer.alloc(12);
  voice.writeInt16LE(500, 10);
  function transcript(speaker) {
    const event = {
      type: 'transcript',
      speaker,
      content: speaker,
      sequence: transcripts.length,
      fragmentId: String(transcripts.length),
      generation,
    };
    transcripts.push(event);
    emit(event);
  }
  speak.mockImplementation(async () => {
    for (let n = 0; n < 3; n++) {
      input(voice);
    }
    if (!silent) {
      transcript('user');
      transcript('assistant');
    }
  });
  return { world, relay, client, server, input, output, page, context, emit, close, browser };
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
