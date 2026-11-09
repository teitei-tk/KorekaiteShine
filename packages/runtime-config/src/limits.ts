/** 金額の保証ではなく、外部APIを呼ぶ前に確保する利用枠。 */
export const usageLimits = Object.freeze({
  timeZone: 'Asia/Tokyo',
  analysesPerDay: 10,
  audioSecondsPerDay: 60 * 60,
  interviewActiveMs: 20 * 60 * 1000,
  evaluationsPerDay: 10,
});
