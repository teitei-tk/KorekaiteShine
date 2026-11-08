import standaloneCode from 'ajv/dist/standalone/index.js';

/** Ajvの文字数helperのCommonJS参照を、Workerでも動く独立したESMへ変換する。 */
export function standaloneValidator(...args: Parameters<typeof standaloneCode>): string {
  let code = standaloneCode(...args);
  const unicodeLength = 'require("ajv/dist/runtime/ucs2length").default';
  if (code.includes(unicodeLength)) {
    code = `const unicodeCodePointLength = value => Array.from(value).length;\n${code.replaceAll(unicodeLength, 'unicodeCodePointLength')}`;
  }
  if (/\brequire\s*\(/u.test(code)) {
    throw new Error('未対応のCommonJS参照がvalidatorへ生成されました。');
  }
  return code;
}
