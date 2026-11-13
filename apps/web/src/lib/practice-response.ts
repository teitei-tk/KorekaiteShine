// マイクと再生PCMは24 kHz・16 bit。内容は保存せず、音量とサンプル数だけを使う。
const sampleRate = 24000;

function meanSquare(samples: Int16Array) {
  return samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length;
}

export function createResponseMonitor() {
  const state = {
    waitingSince: null as number | null,
    version: 0,
    inputPower: 0,
    inputSamples: 0,
    audibleSamples: 0,
  };

  function reset() {
    state.waitingSince = null;
    state.version++;
    state.inputPower = 0;
    state.inputSamples = 0;
    state.audibleSamples = 0;
  }

  return {
    expectOpening(now: number) {
      reset();
      state.waitingSince = now;
    },
    capture(bytes: ArrayBuffer, now: number) {
      const samples = new Int16Array(bytes);
      const power = samples.length ? meanSquare(samples) : 0;
      if (power < 4 ** 2) {
        state.inputPower = 0;
        state.inputSamples = 0;
        return;
      }
      state.inputSamples += samples.length;
      // 回答の強弱（音量が2倍以上変化）で待機を延ばし、一定の背景音では延ばさない。
      if (
        state.inputSamples >= sampleRate / 10 &&
        (power > state.inputPower * 4 || power < state.inputPower / 4)
      ) {
        state.version++;
        state.audibleSamples = 0;
        state.inputPower = power;
        state.waitingSince = now;
      }
    },
    playbackVersion: () => state.version,
    played(bytes: ArrayBuffer, receivedVersion = state.version) {
      if (state.waitingSince === null || receivedVersion !== state.version) {
        return;
      }
      const samples = new Int16Array(bytes);
      const position = { offset: 0 };
      while (position.offset < samples.length) {
        const frame = samples.subarray(position.offset, position.offset + 480);
        position.offset += frame.length;
        if (meanSquare(frame) >= 32 ** 2) {
          state.audibleSamples += frame.length;
        }
      }
      if (state.audibleSamples >= sampleRate / 4) {
        reset();
        return true;
      }
      return false;
    },
    isWaitingTooLong(now: number) {
      return state.waitingSince !== null && now - state.waitingSince >= 20_000;
    },
    reset,
  };
}
