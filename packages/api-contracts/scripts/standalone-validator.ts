import standaloneCode from 'ajv/dist/standalone/index.js';

/** Ajvの文字数helperのCommonJS参照を、Workerでも動く独立したESMへ変換する。 */
export function standaloneValidator(...args: Parameters<typeof standaloneCode>): string {
  const source = standaloneCode(...args);
  const unicodeLength = 'require("ajv/dist/runtime/ucs2length").default';
  const code = source.includes(unicodeLength)
    ? `const unicodeCodePointLength = value => Array.from(value).length;\n${source.replaceAll(unicodeLength, 'unicodeCodePointLength')}`
    : source;
  if (/\brequire\s*\(/u.test(code)) {
    throw new Error('未対応のCommonJS参照がvalidatorへ生成されました。');
  }
  return code;
}
