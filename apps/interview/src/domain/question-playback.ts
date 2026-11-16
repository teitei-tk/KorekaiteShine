// 新接続の最初の質問について、文字と250ms以上の可聴PCMの再生完了を照合する。
export function questionPlayback() {
  const playback = { audibleSamples: 0, audibleEndMs: null as number | null, playedThroughMs: 0 };
  return {
    hasText: false,
    output(bytes: Uint8Array, endOffsetMs: number) {
      if (playback.audibleEndMs !== null) {
        return;
      }
      const samples = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const block = { offset: 0 };
      while (block.offset < bytes.byteLength) {
        const offset = block.offset;
        const end = Math.min(offset + 960, bytes.byteLength);
        const window = { power: 0, index: offset };
        while (window.index < end) {
          window.power += samples.getInt16(window.index, true) ** 2;
          window.index += 2;
        }
        const count = (end - offset) / 2;
        block.offset = end;
        if (window.power >= count * 32 ** 2) {
          playback.audibleSamples += count;
        }
      }
      if (playback.audibleSamples >= 6000) {
        playback.audibleEndMs = endOffsetMs;
      }
    },
    played(endOffsetMs: number) {
      playback.playedThroughMs = Math.max(playback.playedThroughMs, endOffsetMs);
    },
    confirmed() {
      return (
        this.hasText &&
        playback.audibleEndMs !== null &&
        playback.playedThroughMs >= playback.audibleEndMs
      );
    },
  };
}
