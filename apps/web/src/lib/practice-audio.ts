import workletUrl from './microphone-worklet.js?url';

const sampleRate = 24_000;
export function encodeMicrophoneFrame(generation: number, pcm: ArrayBuffer): ArrayBuffer {
  if (
    !Number.isSafeInteger(generation) ||
    generation < 1 ||
    pcm.byteLength < 2 ||
    pcm.byteLength > 9600 ||
    pcm.byteLength % 2 !== 0
  ) {
    throw new Error('送信音声の形式が不正です。');
  }
  const result = new ArrayBuffer(8 + pcm.byteLength);
  new DataView(result).setFloat64(0, generation);
  new Uint8Array(result, 8).set(new Uint8Array(pcm));
  return result;
}

export function createPlayback(context: AudioContext) {
  const sources = new Set<AudioBufferSourceNode>();
  const nextState = { next: 0 };
  return {
    play(bytes: ArrayBuffer, complete: () => void) {
      if (!bytes.byteLength || bytes.byteLength % 2 || bytes.byteLength > 98_304) {
        throw new Error('受信音声の形式が不正です。');
      }
      const length = bytes.byteLength / 2;
      const start = Math.max(context.currentTime, nextState.next);
      if (start + length / sampleRate - context.currentTime > 5 || sources.size >= 256) {
        throw new Error('音声の再生が追いついていません。');
      }
      const buffer = context.createBuffer(1, length, sampleRate);
      const samples = buffer.getChannelData(0);
      const view = new DataView(bytes);
      for (const i of samples.keys()) {
        samples[i] = view.getInt16(i * 2, true) / 32_768;
      }
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      sources.add(source);
      // oxlint-disable-next-line unicorn/prefer-add-event-listener -- 単一の接続所有者がハンドラーを置換し、停止時にnullで解除する。
      source.onended = () => {
        if (sources.delete(source)) {
          source.disconnect();
          complete();
        }
      };
      source.start(start);
      nextState.next = start + length / sampleRate;
    },
    stop() {
      for (const source of sources) {
        // oxlint-disable-next-line unicorn/prefer-add-event-listener -- 単一の接続所有者がハンドラーを置換し、停止時にnullで解除する。
        source.onended = null;
        source.stop();
        source.disconnect();
      }
      sources.clear();
      nextState.next = 0;
    },
  };
}

export async function openInterviewAudio(
  signal: AbortSignal,
  captured: (pcm: ArrayBuffer) => void,
  lost: () => void,
) {
  signal.throwIfAborted();
  const context = new AudioContext({ sampleRate });
  const playback = createPlayback(context);
  const streamContext = {
    stream: undefined as MediaStream | undefined,
    node: undefined as AudioWorkletNode | undefined,
    input: undefined as MediaStreamAudioSourceNode | undefined,
    disposed: false,
  };
  function close() {
    if (streamContext.disposed) {
      return;
    }
    streamContext.disposed = true;
    signal.removeEventListener('abort', close);
    playback.stop();
    if (streamContext.node) {
      // oxlint-disable-next-line unicorn/prefer-add-event-listener -- 単一の接続所有者がハンドラーを置換し、停止時にnullで解除する。
      streamContext.node.port.onmessage = null;
      streamContext.node.port.close();
      streamContext.node.disconnect();
    }
    streamContext.input?.disconnect();
    for (const track of streamContext.stream?.getTracks() ?? []) {
      track.removeEventListener('ended', lost);
      track.stop();
    }
    void context.close().catch(() => {
      /* 拒否は呼び出し元で処理済み。ここでは待機列だけを解放する。 */
    });
  }
  signal.addEventListener('abort', close, { once: true });
  try {
    await Promise.all([
      context.resume(),
      context.audioWorklet.addModule(workletUrl),
      navigator.mediaDevices
        .getUserMedia({ audio: { channelCount: 1, echoCancellation: true }, video: false })
        // oxlint-disable-next-line promise/always-return -- 終端の副作用コールバックであり、値は後続へ渡さない。
        .then((acquired) => {
          if (streamContext.disposed) {
            for (const track of acquired.getTracks()) {
              track.stop();
            }
            return;
          }
          streamContext.stream = acquired;
        }),
    ]);
    signal.throwIfAborted();
    if (!streamContext.stream || context.sampleRate !== sampleRate) {
      throw new Error('24 kHzの音声入力を準備できませんでした。');
    }
    streamContext.input = context.createMediaStreamSource(streamContext.stream);
    streamContext.node = new AudioWorkletNode(context, 'interview-microphone', {
      channelCount: 1,
      channelCountMode: 'explicit',
      outputChannelCount: [1],
    });
    // oxlint-disable-next-line unicorn/prefer-add-event-listener -- 単一の接続所有者がハンドラーを置換し、停止時にnullで解除する。
    streamContext.node.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      if (!streamContext.disposed) {
        captured(event.data);
      }
    };
    streamContext.node.onprocessorerror = lost;
    for (const track of streamContext.stream.getAudioTracks()) {
      track.addEventListener('ended', lost);
    }
    streamContext.input.connect(streamContext.node);
    streamContext.node.connect(context.destination);
    return {
      play: (bytes: ArrayBuffer, complete: () => void) => {
        playback.play(bytes, complete);
      },
      stopPlayback: () => {
        playback.stop();
      },
      close,
    };
  } catch (error) {
    close();
    throw error;
  }
}
