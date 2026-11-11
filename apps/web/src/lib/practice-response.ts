// マイクと再生PCMは24 kHz・16 bit。内容は保存せず、音量とサンプル数だけを使う。
const sampleRate = 24000;

function meanSquare(samples: Int16Array) {
  let power = 0;
  for (const sample of samples) {
    power += sample * sample;
  }
  return power / samples.length;
}

export function createResponseMonitor() {
  let waitingSince: number | null = null;
  let version = 0;
  let inputPower = 0;
  let inputSamples = 0;
  let audibleSamples = 0;

  function reset() {
    waitingSince = null;
    version++;
    inputPower = 0;
    inputSamples = 0;
    audibleSamples = 0;
  }

  return {
    expectOpening(now: number) {
      reset();
      waitingSince = now;
    },
    capture(bytes: ArrayBuffer, now: number) {
      const samples = new Int16Array(bytes);
      const power = samples.length ? meanSquare(samples) : 0;
      if (power < 4 ** 2) {
        inputPower = 0;
        inputSamples = 0;
        return;
      }
      inputSamples += samples.length;
      // 回答の強弱（音量が2倍以上変化）で待機を延ばし、一定の背景音では延ばさない。
      if (inputSamples >= sampleRate / 10 && (power > inputPower * 4 || power < inputPower / 4)) {
        version++;
        audibleSamples = 0;
        inputPower = power;
        waitingSince = now;
      }
    },
    playbackVersion: () => version,
    played(bytes: ArrayBuffer, receivedVersion = version) {
      if (waitingSince === null || receivedVersion !== version) {
        return;
      }
      const samples = new Int16Array(bytes);
      for (let i = 0; i < samples.length; i += 480) {
        const frame = samples.subarray(i, i + 480);
        if (meanSquare(frame) >= 32 ** 2) {
          audibleSamples += frame.length;
        }
      }
      if (audibleSamples >= sampleRate / 4) {
        reset();
        return true;
      }
      return false;
    },
    isWaitingTooLong(now: number) {
      return waitingSince !== null && now - waitingSince >= 20_000;
    },
    reset,
  };
}
