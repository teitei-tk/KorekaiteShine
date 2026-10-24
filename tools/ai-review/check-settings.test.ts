import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSettings } from './check-settings.ts';

const variables = [
  { name: 'OPENAI_WIF_AUDIENCE', value: 'https://api.openai.com/v1' },
  { name: 'OPENAI_IDENTITY_PROVIDER_ID', value: 'idp_fixture123' },
  { name: 'OPENAI_SERVICE_ACCOUNT_ID', value: 'user-fixture456' },
  { name: 'AI_REVIEW_MODE', value: 'claims' },
];
const read = (value: unknown) => () => JSON.stringify(value);

it('CLI経由でもghの標準出力・エラー出力を漏らさず、終了コードを返す', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ai-settings-test-'));
  try {
    writeFileSync(
      join(directory, 'gh'),
      '#!/bin/sh\nprintf \'%s\' "$SETTINGS_TEST_RESPONSE"\nprintf \'%s\' "$SETTINGS_TEST_ERROR" >&2\nexit "$SETTINGS_TEST_EXIT"\n',
      { mode: 0o700 },
    );
    for (const code of ['0', '1']) {
      const result = spawnSync(
        process.execPath,
        [fileURLToPath(new URL('./check-settings.ts', import.meta.url))],
        {
          encoding: 'utf8',
          timeout: 5000,
          env: {
            PATH: `${directory}${delimiter}${process.env.PATH ?? ''}`,
            SETTINGS_TEST_RESPONSE: JSON.stringify(variables),
            SETTINGS_TEST_ERROR: 'private-stderr-fixture',
            SETTINGS_TEST_EXIT: code,
            EXPECTED_OPENAI_SERVICE_ACCOUNT_ID: 'user-fixture456',
          },
        },
      );
      expect(result.status).toBe(Number(code));
      expect(result.stderr).toBe('');
      expect(result.stdout).not.toMatch(/fixture|https:\/\/api/);
      if (code === '0') expect(result.stdout).toContain('OPENAI_SERVICE_ACCOUNT_ID: 一致');
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it('正しい形式でも実値を出さず、期待値未指定のIDを確認済みと扱わない', () => {
  const result = checkSettings(read(variables));
  expect(result.ok).toBe(true);
  expect(result.output).toContain('OPENAI_SERVICE_ACCOUNT_ID: 形式OK・期待値未指定');
  for (const item of variables) expect(result.output).not.toContain(item.value);
});

it('期待値との一致と不一致を、どちらの値も出さずに報告する', () => {
  const good = checkSettings(read(variables), { OPENAI_SERVICE_ACCOUNT_ID: 'user-fixture456' });
  expect(good.ok).toBe(true);
  expect(good.output).toContain('OPENAI_SERVICE_ACCOUNT_ID: 一致');
  const bad = checkSettings(read(variables), { OPENAI_SERVICE_ACCOUNT_ID: 'user-different789' });
  expect(bad.ok).toBe(false);
  expect(bad.output).toContain('OPENAI_SERVICE_ACCOUNT_ID: 不一致');
  expect(bad.output).not.toMatch(/fixture456|different789/);
});

it('誤登録したキー・改行・未知の変数名を出力しない', () => {
  const secret = ['sk', 'svcacct', 'privateFixture'].join('-');
  const input = variables.map((item) =>
    item.name === 'OPENAI_SERVICE_ACCOUNT_ID'
      ? { ...item, value: `${secret}\n::warning::leak` }
      : item,
  );
  input.push({ name: secret, value: secret });
  const result = checkSettings(read(input));
  expect(result.ok).toBe(false);
  expect(result.output).toContain('OPENAI_SERVICE_ACCOUNT_ID: 形式不正');
  expect(result.output).not.toMatch(/privateFixture|warning|leak/);
});

it('欠落・空値・重複・不正なAudience・モードを拒否する', () => {
  for (const input of [
    variables.slice(1),
    variables.map((item) => ({ ...item, value: '' })),
    [...variables, variables[0]],
    variables.map((item) =>
      item.name === 'OPENAI_WIF_AUDIENCE' ? { ...item, value: 'https://wrong.test' } : item,
    ),
    variables.map((item) =>
      item.name === 'AI_REVIEW_MODE' ? { ...item, value: 'unexpected-mode' } : item,
    ),
  ])
    expect(checkSettings(read(input)).ok).toBe(false);
});

it('取得失敗や壊れたJSONを、stdout・stderr・例外を漏らさず報告する', () => {
  const sensitive = 'private-response-fixture';
  const readers = [
    () => {
      throw Object.assign(new Error(sensitive), { stdout: sensitive, stderr: sensitive });
    },
    () => sensitive,
    read({ [sensitive]: sensitive }),
    read([null]),
  ];
  for (const reader of readers) {
    const result = checkSettings(reader);
    expect(result.ok).toBe(false);
    expect(result.output).toBe(
      '設定を取得・解析できませんでした。権限・接続・応答形式を確認してください。',
    );
  }
});
