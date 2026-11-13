import { fileURLToPath } from 'node:url';

const answer = fileURLToPath(new URL('./fixtures/answer.wav', import.meta.url));
export const fakeMediaArgs = [
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
  `--use-file-for-fake-audio-capture=${answer}`,
];

// 実デバイスと同じ取得経路に仮想マイクを渡す。発話操作までトラックを消音する。
export async function installMediaProbe(context) {
  await context.addInitScript(() => {
    if (!navigator.mediaDevices) {
      return;
    }
    const meter = {
      count: 0,
      lastSound: 0,
      speaking: false,
      audibleSeconds: 0,
      completedSeconds: 0,
      playedFrequencies: [],
    };
    const tracks = new Set();
    const acquire = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const stream = await acquire(constraints);
      for (const track of stream.getAudioTracks()) {
        track.enabled = false;
        tracks.add(track);
      }
      return stream;
    };
    meter.speak = () => {
      const live = [...tracks].filter((track) => track.readyState === 'live');
      if (!live.length) {
        throw Error('発話に使えるマイクがありません。');
      }
      meter.speaking = true;
      for (const track of live) {
        track.enabled = true;
      }
      setTimeout(() => {
        for (const track of live) {
          track.enabled = false;
        }
        meter.speaking = false;
      }, 3900);
    };
    // スピーカーへ接続された実際のグラフを分岐し、再生時計が進む間の振幅を測る。
    const graphs = new WeakMap();
    const connect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (destination, ...options) {
      const result = connect.call(this, destination, ...options);
      if (destination === this.context.destination) {
        if (this instanceof AudioBufferSourceNode && this.buffer) {
          const buffer = this.buffer;
          const start = this.start.bind(this);
          const playback = { startedAt: undefined };
          this.start = (when = 0, ...args) => {
            playback.startedAt = Math.max(this.context.currentTime, when);
            return start(when, ...args);
          };
          this.addEventListener(
            'ended',
            () => {
              const samples = buffer.getChannelData(0);
              const rendered = Math.min(
                samples.length,
                Math.max(
                  0,
                  Math.round((this.context.currentTime - playback.startedAt) * buffer.sampleRate),
                ),
              );
              meter.completedSeconds += rendered / buffer.sampleRate;
              // 模擬AIは質問と遅延音声を別の周波数で返す。実際に再生した区間だけを識別する。
              if (rendered >= buffer.sampleRate / 10) {
                const crossings = samples
                  .subarray(0, rendered)
                  .reduce(
                    (count, sample, index) =>
                      count + Number(index > 0 && samples[index - 1] <= 0 && sample > 0),
                    0,
                  );
                meter.playedFrequencies.push((crossings * buffer.sampleRate) / rendered);
              }
              // 主スレッドの測定間隔が長引いても、再生済み区間の無音を発音時間に含めない。
              for (const frameIndex of samples.keys().take(Math.ceil(rendered / 480))) {
                const i = frameIndex * 480;
                const frame = samples.subarray(i, Math.min(i + 480, rendered));
                if (frame.some((sample) => Math.abs(sample) > 0.002)) {
                  meter.audibleSeconds += frame.length / buffer.sampleRate;
                }
              }
            },
            { once: true },
          );
        }
        const analyserState = { analyser: graphs.get(this.context) };
        if (!analyserState.analyser) {
          const ctx = this.context;
          analyserState.analyser = ctx.createAnalyser();
          graphs.set(ctx, analyserState.analyser);
          const samples = new Float32Array(analyserState.analyser.fftSize);
          const previousState = { previous: ctx.currentTime };
          const timer = setInterval(() => {
            if (ctx.state === 'closed') {
              return clearInterval(timer);
            }
            analyserState.analyser.getFloatTimeDomainData(samples);
            if (
              ctx.currentTime > previousState.previous &&
              samples.some((v) => Math.abs(v) > 0.002)
            ) {
              meter.count++;
              meter.lastSound = performance.now();
            }
            previousState.previous = ctx.currentTime;
          }, 20);
        }
        connect.call(this, analyserState.analyser);
      }
      return result;
    };
    window.voiceE2e = meter;
  });
}
export function playbackCount(page) {
  return page.evaluate(() => window.voiceE2e.count);
}
export async function waitForQuiet(page) {
  await page.waitForFunction(
    () => !window.voiceE2e.speaking && performance.now() - window.voiceE2e.lastSound > 800,
    undefined,
    { timeout: 45_000 },
  );
}
export async function speak(page) {
  await waitForQuiet(page);
  await page.evaluate(() => window.voiceE2e.speak());
}
export async function waitForPlayback(page, previousCount) {
  await page.waitForFunction((n) => window.voiceE2e.count > n, previousCount, { timeout: 40_000 });
  return playbackCount(page);
}

export async function waitForOpening(page, previousCount) {
  await waitForPlayback(page, previousCount);
  // 模擬質問は500msの発音。立ち上がりだけで次へ進まず、出力グラフの再生時間も照合する。
  const minimum = process.env.E2E_PROFILE === 'live' ? 0.4 : 0.5;
  await page.waitForFunction(
    (seconds) =>
      window.voiceE2e.audibleSeconds >= 0.4 && window.voiceE2e.completedSeconds >= seconds,
    minimum,
    { timeout: 40_000 },
  );
  await waitForQuiet(page);
}
