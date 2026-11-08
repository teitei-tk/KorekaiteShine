import { once } from 'node:events';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

const sampleRate = 24000;

function tone(frequency) {
  const pcm = Buffer.alloc((sampleRate / 2) * 2);
  for (let i = 0; i < pcm.length / 2; i++) {
    pcm.writeInt16LE(
      Math.round(8000 * Math.sin((2 * Math.PI * frequency * i) / sampleRate)),
      2 * i,
    );
  }
  return pcm.toString('base64');
}

export async function startProvider() {
  const http = createServer((_request, response) => response.writeHead(404).end());
  const ws = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 });
  let refused = false;
  let turn = 0;
  http.on('upgrade', (request, socket, head) => {
    if (refused || request.url !== '/voice') {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      return;
    }
    ws.handleUpgrade(request, socket, head, (peer) => ws.emit('connection', peer));
  });
  ws.on('connection', (peer) => {
    const session = crypto.randomUUID();
    let startedAt;
    let voiced = 0;
    let quiet = 0;
    let answered = false;
    const send = (event) => peer.send(JSON.stringify(event));
    function transcript(speaker, delta) {
      const end = Math.floor(performance.now()) - startedAt;
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
        startedAt = Math.floor(performance.now());
        send({ type: 'session.started', event_id: crypto.randomUUID(), session: { id: session } });
        transcript('output', '取り組んだことを教えてください。');
        play(330);
      } else if (event.type === 'session.input_audio.append') {
        const pcm = Buffer.from(event.audio, 'base64');
        for (let i = 0; i + 1 < pcm.length; i += 2) {
          if (Math.abs(pcm.readInt16LE(i)) > 300) {
            quiet = 0;
            voiced++;
          } else if (++quiet >= sampleRate / 5) {
            answered = false;
            voiced = 0;
          }
          if (!answered && voiced >= sampleRate / 10) {
            answered = true;
            turn++;
            transcript('input', `架空の経験についての回答${turn}です。`);
            transcript('output', `回答${turn}についてもう少し教えてください。`);
            play(660 + (turn - 1) * 110);
          }
        }
      } else if (event.type === 'session.close') {
        send({
          type: 'session.closed',
          event_id: crypto.randomUUID(),
          usage: { seconds: (Math.floor(performance.now()) - startedAt) / 1000 },
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
      refused = value;
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
