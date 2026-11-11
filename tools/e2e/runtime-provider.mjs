import { once } from 'node:events';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

const sampleRate = 24000;

function tone(frequency) {
  const pcm = Buffer.alloc((sampleRate / 2) * 2);
  for (const index of pcm.keys().take(pcm.length / 2)) {
    pcm.writeInt16LE(
      Math.round(8000 * Math.sin((2 * Math.PI * frequency * index) / sampleRate)),
      2 * index,
    );
  }
  return pcm.toString('base64');
}

export async function startProvider() {
  const http = createServer((_request, response) => response.writeHead(404).end());
  const ws = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 });
  const provider = { refused: false, turn: 0 };
  http.on('upgrade', (request, socket, head) => {
    if (provider.refused || request.url !== '/voice') {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      return;
    }
    ws.handleUpgrade(request, socket, head, (peer) => ws.emit('connection', peer));
  });
  ws.on('connection', (peer) => {
    const session = crypto.randomUUID();
    const turnState = { startedAt: undefined, voiced: 0, quiet: 0, answered: false };
    const send = (event) => peer.send(JSON.stringify(event));
    function transcript(speaker, delta) {
      const end = Math.floor(performance.now()) - turnState.startedAt;
      send({
        type: `session.${speaker}_transcript.delta`,
        event_id: crypto.randomUUID(),
        delta,
        start_ms: Math.max(0, end - 100),
        end_ms: end,
      });
    }
    function play(frequency) {
      // 実サービスと同じく音声deltaにはevent_idを付けない。
      send({ type: 'session.output_audio.delta', delta: tone(frequency) });
    }
    peer.on('error', () => {});
    peer.on('message', (raw) => {
      const event = JSON.parse(raw.toString());
      if (event.type === 'session.start') {
        turnState.startedAt = Math.floor(performance.now());
        send({ type: 'session.started', event_id: crypto.randomUUID(), session: { id: session } });
        transcript('output', '取り組んだことを教えてください。');
        play(330);
      } else if (event.type === 'session.input_audio.append') {
        const pcm = Buffer.from(event.audio, 'base64');
        for (const index of pcm.keys().take(Math.floor(pcm.length / 2))) {
          if (Math.abs(pcm.readInt16LE(index * 2)) > 300) {
            turnState.quiet = 0;
            turnState.voiced++;
          } else if (++turnState.quiet >= sampleRate / 5) {
            turnState.answered = false;
            turnState.voiced = 0;
          }
          if (!turnState.answered && turnState.voiced >= sampleRate / 10) {
            turnState.answered = true;
            provider.turn++;
            transcript('input', `架空の経験についての回答${provider.turn}です。`);
            transcript('output', `回答${provider.turn}についてもう少し教えてください。`);
            play(660 + (provider.turn - 1) * 110);
          }
        }
      } else if (event.type === 'session.close') {
        send({
          type: 'session.closed',
          event_id: crypto.randomUUID(),
          usage: { seconds: (Math.floor(performance.now()) - turnState.startedAt) / 1000 },
          reason: 'close_requested',
        });
      }
    });
  });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  return {
    url: `http://127.0.0.1:${http.address().port}/voice`,
    rejectDials(value) {
      provider.refused = value;
    },
    async stop() {
      for (const peer of ws.clients) {
        peer.terminate();
      }
      ws.close();
      await new Promise((resolve, reject) =>
        http.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
