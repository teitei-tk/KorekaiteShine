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
