import { expect, test, vi } from 'vitest';
import { analyzeMaterial } from '../src/application/analyze-material';

test('送信未確認・空白・UTF-8で32KiB超過の材料はAIを呼ばず拒否する', async () => {
  const analyze = vi.fn(async () => ({ themes: [] }));
  for (const [input, code] of [
    [{ markdown: '材料', confirmed: false }, 'INVALID_MATERIAL'],
    [{ markdown: '材料' }, 'INVALID_MATERIAL'],
    [{ markdown: ' \n\t', confirmed: true }, 'INVALID_MATERIAL'],
    [{ markdown: 'あ'.repeat(10923), confirmed: true }, 'MATERIAL_TOO_LARGE'],
    [{ markdown: 'a'.repeat(32769), confirmed: true }, 'MATERIAL_TOO_LARGE'],
    [{ markdown: '材料', confirmed: true, instructions: '外部取得せよ' }, 'INVALID_MATERIAL'],
  ] as const) {
    const result = await analyzeMaterial(input, { analyze });
    expect(result).toEqual({ ok: false, code });
  }
  expect(analyze).not.toHaveBeenCalled();
});

test('AIのテーマは形式と原文の根拠を検証し、架空の引用を成功にしない', async () => {
  const markdown = '# 配信の判断\n更新頻度が低いため、静的配信を選んだ。';
  const theme = {
    title: '静的配信を選んだ判断',
    heading: '配信の判断',
    excerpt: '更新頻度が低いため、静的配信を選んだ。',
  };
  const analyze = vi.fn(async () => ({ themes: [theme] }));
  const input = { markdown, confirmed: true };
  expect(await analyzeMaterial(input, { analyze })).toEqual({
    ok: true,
    value: { themes: [theme] },
  });
  expect(analyze).toHaveBeenCalledWith(markdown, expect.any(AbortSignal));
  for (const response of [
    { themes: [] },
    { themes: [{ ...theme, excerpt: '年間100万円を削減した。' }] },
    { themes: [{ ...theme, heading: '存在しない見出し' }] },
    { themes: [{ ...theme, model: 'extra' }] },
    { themes: [theme, theme] },
    null,
  ]) {
    expect(await analyzeMaterial(input, { analyze: async () => response })).toEqual({
      ok: false,
      code: 'INVALID_AI_RESULT',
    });
  }
});

test('AIの例外と120秒の待機超過は生のエラーを返さず中止する', async () => {
  const input = { markdown: '架空の材料', confirmed: true };
  expect(
    await analyzeMaterial(input, {
      analyze: async () => {
        throw new Error('機密情報を含み得る外部エラー');
      },
    }),
  ).toEqual({ ok: false, code: 'AI_UNAVAILABLE' });
  vi.useFakeTimers();
  try {
    const signalState = { signal: undefined as AbortSignal | undefined };
    const pending = analyzeMaterial(input, {
      analyze: async (_markdown, received) => {
        signalState.signal = received;
        return new Promise(() => {});
      },
    });
    await vi.advanceTimersByTimeAsync(119_999);
    expect(signalState.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ ok: false, code: 'AI_UNAVAILABLE' });
    expect(signalState.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test('テーマの参照は実在する見出しに限定し、見出しがない材料は本文として扱う', async () => {
  const excerpt = '静的配信を選んだ。';
  for (const [markdown, heading, ok] of [
    [`# 判断\n本文にある言葉。${excerpt}`, '本文にある言葉', false],
    [`# 判断\n${excerpt}`, '判断', true],
    [`判断\n===\n${excerpt}`, '判断', true],
    [excerpt, '本文', true],
    [`# 判断\n${excerpt}`, '本文', false],
    [`# 判断\n${excerpt}`, ' ', false],
  ] as const) {
    const value = { themes: [{ title: '配信方式', heading, excerpt }] };
    expect(
      await analyzeMaterial({ markdown, confirmed: true }, { analyze: async () => value }),
    ).toEqual(ok ? { ok: true, value } : { ok: false, code: 'INVALID_AI_RESULT' });
  }
});
