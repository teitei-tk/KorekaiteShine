import { execFileSync } from 'node:child_process';
import { REPOSITORY } from './policy.ts';

const checks = {
  OPENAI_WIF_AUDIENCE: (value: string) => value === 'https://api.openai.com/v1',
  OPENAI_IDENTITY_PROVIDER_ID: (value: string) => /^idp_[A-Za-z0-9]+$/.test(value),
  OPENAI_SERVICE_ACCOUNT_ID: (value: string) => /^user-[A-Za-z0-9]+$/.test(value),
  AI_REVIEW_MODE: (value: string) => ['claims', 'review', 'off'].includes(value),
};
type Name = keyof typeof checks;
type Expected = Partial<Record<Name, string>>;

function readVariables(): string {
  return execFileSync('gh', ['variable', 'list', '--repo', REPOSITORY, '--json', 'name,value'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
    maxBuffer: 1_000_000,
    env: { ...process.env, GH_DEBUG: '', GH_PROMPT_DISABLED: '1' },
  });
}

// 未信頼の名前・値・エラーを返さず、固定の診断文字列だけを返す。
export function checkSettings(
  read: () => string = readVariables,
  expected: Expected = {},
): { ok: boolean; output: string } {
  try {
    const data: { name: string; value: string }[] = JSON.parse(read());
    if (
      !Array.isArray(data) ||
      !data.every((row) => row && typeof row.name === 'string' && typeof row.value === 'string')
    ) {
      throw new Error('Invalid response');
    }
    let ok = true;
    const lines = (Object.keys(checks) as Name[]).map((name) => {
      const matches = data.filter((row) => row.name === name);
      let status: string;
      if (!matches.length || (matches.length === 1 && !matches[0].value)) {
        status = '未設定';
        ok = false;
      } else if (matches.length !== 1 || !checks[name](matches[0].value)) {
        status = '形式不正';
        ok = false;
      } else if (expected[name] !== undefined) {
        const equal = matches[0].value === expected[name];
        status = equal ? '一致' : '不一致';
        if (!equal) ok = false;
      } else {
        status = '形式OK・期待値未指定';
      }
      return `${name}: ${status}`;
    });
    return { ok, output: lines.join('\n') };
  } catch {
    return {
      ok: false,
      output: '設定を取得・解析できませんでした。権限・接続・応答形式を確認してください。',
    };
  }
}

if (import.meta.main) {
  const expected: Expected = {};
  for (const name of Object.keys(checks) as Name[]) {
    const value = process.env[`EXPECTED_${name}`];
    if (value !== undefined) expected[name] = value;
  }
  const result = checkSettings(readVariables, expected);
  console.log(result.output);
  process.exitCode = result.ok ? 0 : 1;
}
