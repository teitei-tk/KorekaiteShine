// 新接続の最初の質問について、文字と250ms以上の可聴PCMの再生完了を照合する。
export function questionPlayback() {
  let audibleSamples = 0;
  let audibleEndMs: number | null = null;
  let playedThroughMs = 0;
  return {
    hasText: false,
    output(bytes: Uint8Array, endOffsetMs: number) {
      if (audibleEndMs !== null) {
        return;
      }
      const samples = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (let offset = 0; offset < bytes.byteLength; offset += 960) {
        const end = Math.min(offset + 960, bytes.byteLength);
        let power = 0;
        for (let i = offset; i < end; i += 2) {
          power += samples.getInt16(i, true) ** 2;
        }
        const count = (end - offset) / 2;
        if (power >= count * 32 ** 2) {
          audibleSamples += count;
        }
      }
      if (audibleSamples >= 6000) {
        audibleEndMs = endOffsetMs;
      }
    },
    played(endOffsetMs: number) {
      playedThroughMs = Math.max(playedThroughMs, endOffsetMs);
    },
    confirmed() {
      return this.hasText && audibleEndMs !== null && playedThroughMs >= audibleEndMs;
    },
  };
}
