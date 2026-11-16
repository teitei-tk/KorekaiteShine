import { once } from 'node:events';
import { expect, test, vi } from 'vitest';
import WebSocket from 'ws';
import { startProvider } from '../runtime-provider.mjs';

test('模擬AIは発話と無音の境界で応答し、閉じるまで同じ上流セッションを維持する', async () => {
  const provider = await startProvider();
  try {
    expect((await fetch(provider.url)).status).toBe(404);
    const url = provider.url.replace('http:', 'ws:');
    provider.rejectDials(true);
    await expect(once(new WebSocket(url), 'open')).rejects.toThrow('503');
    provider.rejectDials(false);
    await expect(once(new WebSocket(url.replace('/voice', '/other')), 'open')).rejects.toThrow(
      '503',
    );
    const client = new WebSocket(url);
    const events = [];
    client.on('message', (data) => events.push(JSON.parse(data.toString())));
    await once(client, 'open');
    const send = (type, extra = {}) => client.send(JSON.stringify({ type, ...extra }));
    send('session.start');
    await vi.waitFor(() => expect(events).toHaveLength(3), { timeout: 30000 });
    const voice = Buffer.alloc(4802);
    voice.fill(Buffer.from([0xff, 0x03]));
    for (const buf of [voice, Buffer.alloc(9600), voice]) {
      send('session.input_audio.append', { audio: buf.toString('base64') });
    }
    send('ignored');
    send('session.close');
    await vi.waitFor(() => expect(events.at(-1)?.type).toBe('session.closed'), { timeout: 30000 });
    expect(events.filter((e) => e.type === 'session.input_transcript.delta')).toHaveLength(2);
    expect(events.filter((e) => e.type === 'session.output_audio.delta')).toHaveLength(3);
    // RFC 6455の予約ビットを立てたフレームでサーバー側errorを発生させる。
    const closed = once(client, 'close');
    client._socket.write(Buffer.from([0xc1, 0x80, 0, 0, 0, 0]));
    await closed;
    const open = new WebSocket(url);
    await once(open, 'open');
  } finally {
    await provider.stop();
  }
}, 120000);

test('リスナーの終了失敗を呼び出し側に返す', async () => {
  const provider = await startProvider();
  await provider.stop();
  await expect(provider.stop()).rejects.toThrow();
});

async function openPeer(provider) {
  const socket = new WebSocket(provider.url.replace('http:', 'ws:'));
  const events = [];
  socket.on('message', (data) => events.push(JSON.parse(data.toString())));
  await once(socket, 'open');
  return {
    events,
    send(type, fields = {}) {
      socket.send(JSON.stringify({ type, ...fields }));
    },
    async finish() {
      socket.send(JSON.stringify({ type: 'session.close' }));
      await vi.waitFor(() => expect(events.at(-1)?.type).toBe('session.closed'));
    },
  };
}

test('初回質問の無音と延長は各1回だけ適用し、返答案の消音では通常の初回音声を維持する', async () => {
  const provider = await startProvider();
  try {
    const audio = (peer) => peer.events.filter((e) => e.type === 'session.output_audio.delta');
    provider.omitNextOpening();
    const omitted = await openPeer(provider);
    omitted.send('session.start');
    await omitted.finish();
    expect(audio(omitted)).toHaveLength(0);
    provider.extendNextOpening();
    const extended = await openPeer(provider);
    extended.send('session.start');
    await extended.finish();
    expect(audio(extended)).toHaveLength(9);
    const muted = await openPeer(provider);
    provider.muteReplies();
    muted.send('session.start');
    muted.send('session.instructions.append', { content: '言い換え' });
    await muted.finish();
    const [opening, reply] = audio(muted).map((e) => Buffer.from(e.delta, 'base64'));
    expect(opening.some((byte) => byte !== 0)).toBe(true);
    expect(reply).toEqual(Buffer.alloc(opening.length));
  } finally {
    await provider.stop();
  }
});

test.each(['rephrase', 'skip'])(
  '再開時の %s と操作中の保留を再現し、古い質問の続きを一度だけ返す',
  async (operation) => {
    const provider = await startProvider();
    try {
      const session = {
        input: [
          {
            content: [
              { text: JSON.stringify({ resume: { pendingQuestionOperation: operation } }) },
            ],
          },
        ],
      };
      const resumed = await openPeer(provider);
      resumed.send('session.start', { session });
      await resumed.finish();
      const question =
        operation === 'rephrase'
          ? '具体的な役割は何ですか。'
          : '他の手段をなぜ選びませんでしたか。';
      expect(resumed.events[1].delta).toBe(question);

      const delayed = await openPeer(provider);
      const held = provider.holdNextQuestion();
      delayed.send('session.start', { session });
      await held;
      await delayed.finish();
      expect(
        delayed.events
          .filter((e) => e.type === 'session.output_transcript.delta')
          .map((e) => e.delta),
      ).toEqual(['前の質問から遅れて届いた続きです。']);

      const active = await openPeer(provider);
      active.send('session.start');
      const holdCommand = provider.holdNextQuestion();
      active.send('session.instructions.append', { content: '言い換え' });
      await holdCommand;
      active.send('session.instructions.append', { content: '見送り' });
      await active.finish();
      expect(
        active.events
          .filter((e) => e.type === 'session.output_transcript.delta')
          .map((e) => e.delta),
      ).toEqual([
        '取り組んだことを教えてください。',
        '他の手段をなぜ選びませんでしたか。',
        '前の質問から遅れて届いた続きです。',
      ]);
    } finally {
      await provider.stop();
    }
  },
);

test('無応答にした既存の接続は終了通知も返さず、新しい接続は応答する', async () => {
  const provider = await startProvider();
  try {
    const unavailable = await openPeer(provider);
    unavailable.send('session.start');
    await vi.waitFor(() => expect(unavailable.events).toHaveLength(3));
    provider.silenceCurrentConnections();
    unavailable.send('session.close');
    const next = await openPeer(provider);
    next.send('session.start');
    await next.finish();
    expect(unavailable.events).toHaveLength(3);
  } finally {
    await provider.stop();
  }
});
