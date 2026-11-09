import workletUrl from './microphone-worklet.js?url';

const sampleRate = 24000;
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
  let next = 0;
  return {
    play(bytes: ArrayBuffer, complete: () => void) {
      if (!bytes.byteLength || bytes.byteLength % 2 || bytes.byteLength > 98304) {
        throw new Error('受信音声の形式が不正です。');
      }
      const length = bytes.byteLength / 2;
      const start = Math.max(context.currentTime, next);
      if (start + length / sampleRate - context.currentTime > 5 || sources.size >= 256) {
        throw new Error('音声の再生が追いついていません。');
      }
      const buffer = context.createBuffer(1, length, sampleRate);
      const samples = buffer.getChannelData(0);
      const view = new DataView(bytes);
      for (let i = 0; i < length; i++) {
        samples[i] = view.getInt16(i * 2, true) / 32768;
      }
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      sources.add(source);
      source.onended = () => {
        if (sources.delete(source)) {
          source.disconnect();
          complete();
        }
      };
      source.start(start);
      next = start + length / sampleRate;
    },
    stop() {
      for (const source of sources) {
        source.onended = null;
        source.stop();
        source.disconnect();
      }
      sources.clear();
      next = 0;
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
  let stream: MediaStream | undefined;
  let node: AudioWorkletNode | undefined;
  let input: MediaStreamAudioSourceNode | undefined;
  let disposed = false;
  function close() {
    if (disposed) {
      return;
    }
    disposed = true;
    signal.removeEventListener('abort', close);
    playback.stop();
    if (node) {
      node.port.onmessage = null;
      node.port.close();
      node.disconnect();
    }
    input?.disconnect();
    for (const track of stream?.getTracks() ?? []) {
      track.removeEventListener('ended', lost);
      track.stop();
    }
    void context.close().catch(() => {});
  }
  signal.addEventListener('abort', close, { once: true });
  try {
    await Promise.all([
      context.resume(),
      context.audioWorklet.addModule(workletUrl),
      navigator.mediaDevices
        .getUserMedia({ audio: { channelCount: 1, echoCancellation: true }, video: false })
        .then((acquired) => {
          if (disposed) {
            for (const track of acquired.getTracks()) {
              track.stop();
            }
            return;
          }
          stream = acquired;
        }),
    ]);
    signal.throwIfAborted();
    if (!stream || context.sampleRate !== sampleRate) {
      throw new Error('24 kHzの音声入力を準備できませんでした。');
    }
    input = context.createMediaStreamSource(stream);
    node = new AudioWorkletNode(context, 'interview-microphone', {
      channelCount: 1,
      channelCountMode: 'explicit',
      outputChannelCount: [1],
    });
    node.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      if (!disposed) {
        captured(event.data);
      }
    };
    node.onprocessorerror = lost;
    for (const track of stream.getAudioTracks()) {
      track.addEventListener('ended', lost);
    }
    input.connect(node);
    node.connect(context.destination);
    return { play: playback.play, stopPlayback: playback.stop, close };
  } catch (error) {
    close();
    throw error;
  }
}
