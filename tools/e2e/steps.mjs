import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { After, Before, Given, Then, When, setDefaultTimeout } from '@cucumber/cucumber';
import { chromium } from 'playwright';
import {
  fakeMediaArgs,
  installMediaProbe,
  playbackCount,
  speak,
  waitForOpening,
  waitForPlayback,
  waitForQuiet,
} from './media.mjs';
import { startVoiceRuntime } from './runtime.mjs';

setDefaultTimeout(180_000);
const startButton = 'マイクを許可して開始';
const minute = 60_000;
const material =
  '架空の経験です。図書館で、蔵書検索に時間がかかっていました。私は索引の追加とキャッシュを比較し、更新頻度と計測結果をもとに索引を選びました。';

Before(async function () {
  this.runtime = await startVoiceRuntime({ profile: process.env.E2E_PROFILE ?? 'pr' });
  this.browser = await chromium.launch({
    executablePath: process.env.E2E_CHROME_PATH || undefined,
    args: fakeMediaArgs,
    env: Object.fromEntries(
      Object.entries(process.env).filter(([key]) =>
        [
          'PATH',
          'HOME',
          'TMPDIR',
          'TMP',
          'TEMP',
          'LANG',
          'DISPLAY',
          'XDG_RUNTIME_DIR',
          'SystemRoot',
        ].includes(key),
      ),
    ),
  });
  this.context = await this.browser.newContext({ permissions: ['microphone'] });
  await installMediaProbe(this.context);
  this.page = await this.context.newPage();
  this.page.setDefaultTimeout(45_000);
  this.sockets = [];
  this.events = [];
  this.offline = false;
  this.voicedFrames = 0;
  await this.page.route('**/api/local-session', (route) =>
    this.offline ? route.abort('internetdisconnected') : route.continue(),
  );
  // ブラウザと本物の Worker の間を透過転送し、回線障害のときだけ両端を閉じる。
  await this.page.routeWebSocket('**/api/interviews/*/live*', (client) => {
    if (this.offline) {
      client.close();
      return;
    }
    const server = client.connectToServer();
    this.sockets.push({ client, server });
    client.onMessage((message) => {
      server.send(message);
      if (Buffer.isBuffer(message)) {
        // 先頭8バイトの世代番号に続く24 kHz PCM。音声そのものは記録しない。
        const pcm = message.subarray(8);
        for (const index of pcm.keys().take(Math.floor(pcm.length / 2))) {
          if (Math.abs(pcm.readInt16LE(index * 2)) > 300) {
            this.voicedFrames++;
            break;
          }
        }
      }
    });
    server.onMessage((message) => {
      if (typeof message === 'string') {
        const event = JSON.parse(message);
        this.events.push(event);
      }
      client.send(message);
    });
  });
});

After(async function ({ result }) {
  if (result?.status === 'FAILED' && this.events) {
    const states = this.events
      .filter((e) => e.type === 'state' || e.type === 'error')
      .map((e) => (e.type === 'state' ? e.status : e.code));
    console.log('面接の状態:', states.join(' → '));
  }
  try {
    await this.browser?.close();
  } finally {
    await this.runtime?.stop();
  }
});

function button(world, name) {
  return world.page.getByRole('button', { name, exact: true });
}

function status(world, label) {
  return world.page.getByRole('status').filter({ hasText: new RegExp('^' + label + ' ·') });
}

async function readWithAction(world, path, action, method = 'GET') {
  const [response] = await Promise.all([
    world.page.waitForResponse(
      (reply) => new URL(reply.url()).pathname === path && reply.request().method() === method,
    ),
    action(),
  ]);
  assert.ok(response.ok(), `${path} が HTTP ${response.status()} を返しました`);
  return response.json();
}

function detailPath(world) {
  return '/api/interviews/' + encodeURIComponent(world.id);
}

async function detail(world) {
  const result = await readWithAction(world, detailPath(world), () =>
    button(world, '記録を更新').click(),
  );
  assert.equal(result.session.interviewId, world.id);
  return result;
}

Given('架空の経験Markdownからテーマを選び面接を準備した', async function () {
  await this.page.goto(new URL('/practice', this.runtime.url).href);
  await this.page.getByText('保存された面接はありません。', { exact: true }).waitFor();
  await this.page.getByLabel('ファイルを選ぶ').setInputFiles({
    name: 'experience.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from(material),
  });
  await this.page.waitForFunction(
    (text) => document.querySelector('textarea')?.value === text,
    material,
  );
  await this.page.getByRole('checkbox').check();
  await button(this, 'テーマを分析する').click();
  await this.page.getByRole('radio').first().check();
  const session = await readWithAction(
    this,
    '/api/interviews',
    () => button(this, '面接を準備する').click(),
    'POST',
  );
  this.id = session.interviewId;
  this.theme = session.theme;
  await button(this, startButton).waitFor();
  this.initialRemaining = (await detail(this)).audioRemainingMs;
  assert.ok(Number.isSafeInteger(this.initialRemaining));
});

async function start(world) {
  world.openingPlayback = await playbackCount(world.page);
  await button(world, startButton).click();
  await status(world, '面接中').waitFor();
}

async function answer(world) {
  await waitForQuiet(world.page);
  world.previousPlayback = await playbackCount(world.page);
  world.beforeAnswer = world.events.length;
  await speak(world.page);
}

async function heardAnswer(world) {
  await waitForPlayback(world.page, world.previousPlayback);
  // 開始時の質問や直前の返答の再生だけで今回の応答が成功扱いになるのを防ぐ。
  const deadline = performance.now() + 45_000;
  while (performance.now() < deadline) {
    const turns = world.events
      .slice(world.beforeAnswer)
      .filter((e) => e.type === 'transcript' && e.content.trim());
    const firstUser = turns.findIndex((e) => e.speaker === 'user');
    if (firstUser >= 0 && turns.slice(firstUser + 1).some((e) => e.speaker === 'assistant')) {
      return;
    }
    await delay(50);
  }
  assert.fail('発話後に本人と面接官の新しい文字起こしが届きませんでした');
}

When('「マイクを許可して開始」でマイクを許可する', async function () {
  await start(this);
});
When('面接中に質問に答える', async function () {
  await waitForOpening(this.page, this.openingPlayback);
  await answer(this);
});
Then('ブラウザで面接官の音声応答が再生される', async function () {
  await heardAnswer(this);
});
Then('次の発話にも音声応答が再生される', async function () {
  await answer(this);
  await heardAnswer(this);
});

async function finish(world) {
  await button(world, '終了して評価する').click();
  await world.page.getByText(/^終了 · 面接時間/).waitFor();
}

When('面接を終了して履歴から開き直す', async function () {
  await finish(this);
  await button(this, '準備と履歴へ戻る').click();
  this.saved = await readWithAction(this, detailPath(this), () =>
    button(this, this.theme).first().click(),
  );
  assert.equal(this.saved.session.interviewId, this.id);
  await this.page.getByRole('heading', { name: this.theme, exact: true }).waitFor();
});

function checkConversation(items) {
  for (const speaker of ['user', 'assistant']) {
    assert.ok(
      items.some((item) => item.speaker === speaker && item.content.trim()),
      speaker + 'の確定発言がありません',
    );
  }
}

Then('同じ面接に本人と面接官の発言が残っている', async function () {
  checkConversation(this.saved.transcripts);
  for (const who of ['あなた', '面接官']) {
    await this.page
      .locator('li[id^="transcript-"] strong')
      .filter({ hasText: who })
      .first()
      .waitFor();
  }
});

Given('今日の音声利用枠がすべて残っている', function () {
  assert.equal(this.initialRemaining, 60 * minute);
});
When('音声サービスとの接続が面接開始前に3回失敗する', async function () {
  await this.runtime.rejectDials(true);
  for (const _ of Array(3).keys()) {
    const offset = this.events.length;
    await button(this, startButton).click();
    await this.page.getByText('音声AIへの接続に失敗しました。再度開始してください。').waitFor();
    await button(this, startButton).waitFor();
    const events = this.events.slice(offset);
    assert.ok(events.some((e) => e.code === 'AUDIO_CONNECT_FAILED'));
    assert.ok(events.every((e) => e.status !== 'active'));
  }
});
Then('今日の残り時間は開始操作前と同じである', async function () {
  assert.equal((await detail(this)).audioRemainingMs, this.initialRemaining);
});
When('音声サービスが復旧して開始を試みる', async function () {
  await this.runtime.rejectDials(false);
  await start(this);
});
Then('面接中になり音声で応答を受け取れる', async function () {
  await answer(this);
  await heardAnswer(this);
});

async function disconnect(world) {
  world.offline = true;
  const { client, server } = world.sockets.at(-1);
  server.close();
  client.close();
  await button(world, '再接続').waitFor();
}

async function reconnect(world) {
  // 失敗した自動試行を通さず、復旧後の最初の操作を人が押す再接続に揃える。
  await button(world, '再接続').waitFor();
  // 自動試行中にボタンが消えることがあるため、手動クリックが届くまで遮断を維持する。
  const allow = Promise.withResolvers();
  await world.page.exposeFunction('restoreInterviewNetwork', () => {
    world.offline = false;
    allow.resolve();
  });
  await world.page.evaluate(() => {
    function restore(event) {
      if (event.target.closest('button')?.textContent.trim() === '再接続') {
        document.removeEventListener('click', restore, true);
        void window.restoreInterviewNetwork();
      }
    }
    document.addEventListener('click', restore, true);
  });
  await button(world, '再接続').click();
  await allow.promise;
  await status(world, '面接中').waitFor();
  assert.equal(world.events.filter((e) => e.type === 'state').at(-1).interviewId, world.id);
}

When('面接を開始して質問を聞き、答える', async function () {
  await start(this);
  this.segmentStart = performance.now();
  await waitForOpening(this.page, this.openingPlayback);
  await delay(2200);
  await answer(this);
  await heardAnswer(this);
});
When('一時停止してから再開する', async function () {
  await button(this, '一時停止').click();
  await status(this, '一時停止中').waitFor();
  this.activeDuration = performance.now() - this.segmentStart;
  await delay(3000);
  await button(this, 'マイクを許可して再開').click();
  await status(this, '面接中').waitFor();
  this.segmentStart = performance.now();
});
When('回線の切断から復帰した後に面接を終了する', async function () {
  await delay(1000);
  this.activeDuration += performance.now() - this.segmentStart;
  await disconnect(this);
  await delay(3000);
  await reconnect(this);
  this.segmentStart = performance.now();
  await delay(1000);
  this.activeDuration += performance.now() - this.segmentStart;
  await finish(this);
});
Then('今日の利用時間は質問を聞いた時間を含む面接中の区間の合計と一致する', async function () {
  const result = await detail(this);
  const charged = this.initialRemaining - result.audioRemainingMs;
  assert.equal(charged, result.session.activeMs);
  assert.ok(
    Math.abs(charged - this.activeDuration) < 1200,
    `課金 ${charged}ms、ブラウザで測った面接中の合計 ${Math.round(this.activeDuration)}ms`,
  );
});

Given('会話を一往復して双方の発言が確定している', async function () {
  await start(this);
  await waitForOpening(this.page, this.openingPlayback);
  await answer(this);
  await heardAnswer(this);
  this.beforeCut = (await detail(this)).transcripts;
  checkConversation(this.beforeCut);
});
When('次の発話途中で回線が切れる', async function () {
  await waitForQuiet(this.page);
  const before = this.voicedFrames;
  await answer(this);
  const deadline = performance.now() + 3000;
  while (this.voicedFrames - before < 3 && performance.now() < deadline) {
    await delay(10);
  }
  assert.ok(this.voicedFrames - before >= 3, '発話の音声フレームが届きませんでした');
  assert.ok(await this.page.evaluate(() => window.voiceE2e.speaking));
  await disconnect(this);
});
When('回線の復旧後に同じタブで「再接続」を押してもう一度話す', async function () {
  await reconnect(this);
  await answer(this);
});
Then('ブラウザで新しい音声応答が再生される', async function () {
  await heardAnswer(this);
});

Then('同じ面接に切断前後の確定した発言が重複なく残っている', function () {
  const items = this.saved.transcripts;
  assert.equal(new Set(items.map((item) => item.fragmentId)).size, items.length);
  assert.equal(new Set(items.map((item) => item.sequence)).size, items.length);
  assert.deepEqual(items.slice(0, this.beforeCut.length), this.beforeCut);
  const oldGeneration = Math.max(...this.beforeCut.map((item) => item.generation));
  checkConversation(items.filter((item) => item.generation > oldGeneration));
});

Given('面接中のタブを開いている', async function () {
  await start(this);
});
When('同じURLでサーバーが再起動し以前の接続情報が失効する', async function () {
  this.offline = true;
  this.documentStart = await this.page.evaluate(() => performance.timeOrigin);
  const oldUrl = this.runtime.url;
  await this.runtime.restart();
  assert.equal(this.runtime.url, oldUrl);
  assert.equal(
    await this.page.evaluate(() => performance.timeOrigin),
    this.documentStart,
    'サーバーの再起動でページが再読み込みされました',
  );
  const stale = await this.context.request.get(new URL(detailPath(this), oldUrl).href);
  assert.equal(stale.status(), 403, '再起動前のCookieで面接詳細を取得できました');
  await button(this, '再接続').waitFor();
});
When('画面を再読み込みせず「再接続」を押して話す', async function () {
  await reconnect(this);
  assert.equal(await this.page.evaluate(() => performance.timeOrigin), this.documentStart);
  await answer(this);
});
Then('同じ面接で新しい音声応答が再生される', async function () {
  await heardAnswer(this);
  checkConversation((await detail(this)).transcripts);
});

When('音声AIが接続を閉じずに回答を受け流す', async function () {
  this.runtime.silenceCurrentConnections();
  await answer(this);
});
async function recoverAudio() {
  await this.page.getByRole('status').filter({ hasText: '面接官の音声を待っています' }).waitFor();
  await button(this, '音声をつなぎ直す').click();
  await status(this, '一時停止中').waitFor();
  await button(this, 'マイクを許可して再開').click();
  await status(this, '面接中').waitFor();
}

When('応答待ちの案内から音声をつなぎ直してもう一度話す', async function () {
  await recoverAudio.call(this);
  await answer(this);
});

When('音声AIが最初の質問の音声を送らずに面接が始まる', async function () {
  this.runtime.omitNextOpening();
  await start(this);
});
When('音声待ちの案内から再開して質問を聞き回答する', async function () {
  await recoverAudio.call(this);
  await waitForOpening(this.page, this.openingPlayback);
  await answer(this);
});
When('次の回答には無音の音声と文字起こしだけが届く', async function () {
  this.runtime.muteReplies();
  await answer(this);
});

When('同じ面接を別のタブで開き「{word}」から引き継ぐ', async function (statusLabel) {
  const page = await this.context.newPage();
  const other = { page, events: [], id: this.id };
  this.otherTab = other;
  page.on('websocket', (socket) => {
    socket.on('framereceived', ({ payload }) => {
      if (typeof payload === 'string') {
        other.events.push(JSON.parse(payload));
      }
    });
  });
  await page.goto(new URL('/practice', this.runtime.url).href);
  await button(other, this.theme).first().click();
  await status(other, '面接中').waitFor();
  if (statusLabel === '一時停止中') {
    await button(this, '一時停止').click();
  }
  await status(other, statusLabel).waitFor();
  assert.equal(await button(other, 'マイクを許可して再開').isVisible(), false);
  await button(other, 'このタブで引き継ぐ').click();
  await button(other, '一時停止').waitFor();
  await button(this, 'このタブで引き継ぐ').waitFor();
});

Then('新しい担当タブで回答して返答を聞ける', async function () {
  await answer(this.otherTab);
  await heardAnswer(this.otherTab);
});

When('回答せずに質問を言い換えて見送る', async function () {
  await waitForOpening(this.page, this.openingPlayback);
  for (const name of ['言い換えを依頼', '質問を見送る']) {
    const before = await playbackCount(this.page);
    await button(this, name).click();
    await waitForPlayback(this.page, before);
    await waitForQuiet(this.page);
  }
});
Then('最後の質問だけが現在の質問になり、前の質問も会話に残る', async function () {
  const heading = this.page.getByRole('heading', { name: '現在の質問' });
  assert.equal(
    await heading.evaluate((el) => el.nextElementSibling.textContent),
    '他の手段をなぜ選びませんでしたか。',
  );
  for (const text of [
    '取り組んだことを教えてください。',
    '具体的な役割は何ですか。',
    '他の手段をなぜ選びませんでしたか。',
  ]) {
    await this.page.getByRole('listitem').filter({ hasText: text }).waitFor();
  }
  assert.equal(this.events.filter((e) => e.type === 'transcript' && e.startsQuestion).length, 2);
});
When('最初の質問を聞いて応答しない音声AIに言い換えを依頼する', async function () {
  await waitForOpening(this.page, this.openingPlayback);
  this.runtime.holdNextQuestion();
  await button(this, '言い換えを依頼').click();
});
When('長い質問を聞きながら返事をして音声AIが応答しなくなる', async function () {
  this.runtime.extendNextOpening();
  await start(this);
  await waitForPlayback(this.page, this.openingPlayback);
  this.runtime.silenceCurrentConnections();
  const frames = this.voicedFrames;
  await this.page.evaluate(() => window.voiceE2e.speak());
  await waitForQuiet(this.page);
  assert.ok(this.voicedFrames > frames);
});

When('「{word}」の返事を保留してから「{word}」を押す', async function (first, second) {
  await waitForOpening(this.page, this.openingPlayback);
  const held = this.runtime.holdNextQuestion();
  this.beforeQuestion = await playbackCount(this.page);
  await button(this, first).click();
  await held;
  await button(this, second).click();
});

When('見送りの返事を保留してから一時停止して再開する', async function () {
  await waitForOpening(this.page, this.openingPlayback);
  const held = this.runtime.holdNextQuestion();
  this.beforeQuestion = await playbackCount(this.page);
  await button(this, '質問を見送る').click();
  await held;
  await button(this, '一時停止').click();
  await status(this, '一時停止中').waitFor();
  await button(this, 'マイクを許可して再開').click();
});

async function hearQuestionAndAnswer(operation) {
  const question =
    operation === '質問を見送る'
      ? '他の手段をなぜ選びませんでしたか。'
      : '具体的な役割は何ですか。';
  await this.page.getByText(question, { exact: true }).first().waitFor();
  const heading = this.page.getByRole('heading', { name: '現在の質問' });
  assert.equal(await heading.evaluate((el) => el.nextElementSibling.textContent), question);
  await waitForPlayback(this.page, this.beforeQuestion);
  await waitForQuiet(this.page);
  const frequencies = await this.page.evaluate(() => window.voiceE2e.playedFrequencies);
  assert.ok(
    frequencies.some((hz) => Math.abs(hz - 440) < 12),
    '新しい質問の音声',
  );
  assert.ok(
    frequencies.every((hz) => Math.abs(hz - 880) > 12),
    '旧接続の遅延音声',
  );
  const fragments = (await detail(this)).transcripts;
  assert.equal(fragments.filter((entry) => entry.content === question).length, 1);
  const generation = fragments.find((entry) => entry.content === question).generation;
  assert.ok(
    fragments.every(
      (entry) => !entry.content.includes('遅れて届いた続き') || entry.generation < generation,
    ),
  );
  await answer(this);
  await heardAnswer(this);
}
Then('「{word}」の質問が単独で表示され音声を聞いて回答できる', hearQuestionAndAnswer);

When('元のタブで見送りを受理した音声AIが返事を保留する', async function () {
  await waitForOpening(this.page, this.openingPlayback);
  const held = this.runtime.holdNextQuestion();
  await button(this, '質問を見送る').click();
  await held;
});

Then('新しい担当タブで見送り後の質問だけを聞いて回答できる', async function () {
  this.otherTab.beforeQuestion = 0;
  await hearQuestionAndAnswer.call(this.otherTab, '質問を見送る');
  const frequencies = await this.otherTab.page.evaluate(() => window.voiceE2e.playedFrequencies);
  assert.ok(
    frequencies.every((hz) => Math.abs(hz - 330) > 12),
    '新しい担当タブで最初の質問が繰り返された',
  );
});
