import { localProcessEnvironment, localAiEnvironment } from '../src/local-environment.ts';

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const command = fileURLToPath(new URL('../src/run.ts', import.meta.url));

test('ローカル操作入口はremoteオプションを起動前に拒否する', () => {
  const result = spawnSync(process.execPath, [command, 'db:migrate', '--remote'], {
    encoding: 'utf8',
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('追加引数は受け付けません');
});

test('統合検証モジュールをNode.jsの直接実行で読み込める', () => {
  const moduleUrl = new URL('../src/integration.ts', import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `await import(${JSON.stringify(moduleUrl)})`],
    {
      encoding: 'utf8',
    },
  );
  expect(result.status, result.stderr).toBe(0);
});

test('ローカル起動に必要な環境だけを引き継ぎ、AI値は開発用の明示した名前だけで取得する', () => {
  const source = {
    PATH: '/bin',
    OPENAI_API_KEY: 'fixture-api-key',
    MATERIAL_MODEL: 'fixture-model',
    OTHER_SECRET: 'other',
    VITE_PUBLIC_SECRET: 'public',
  };
  expect(localProcessEnvironment(source)).toEqual({ PATH: '/bin' });
  expect(localAiEnvironment('development', 'dev', source)).toEqual({
    OPENAI_API_KEY: 'fixture-api-key',
    MATERIAL_MODEL: 'fixture-model',
  });
  expect(localAiEnvironment('development', 'preview', source)).toEqual({});
  expect(localAiEnvironment('test', 'dev', source)).toEqual({});
});

test('架空のAI設定は独立テストのdevに限定し、設定名を制限する', () => {
  const fixture = {
    OPENAI_API_KEY: 'fixture-test-key',
    RESPONSES_MODEL: 'test-model',
    UNRELATED: 'value',
  };
  expect(localAiEnvironment('test', 'dev', {}, fixture)).toEqual({
    OPENAI_API_KEY: 'fixture-test-key',
    RESPONSES_MODEL: 'test-model',
  });
  for (const [environment, mode, bindings] of [
    ['development', 'dev', fixture],
    ['test', 'preview', fixture],
    ['test', 'dev', {}],
    ['test', 'dev', { OPENAI_API_KEY: 'invalid' }],
  ] as const) {
    expect(() => localAiEnvironment(environment, mode, {}, bindings)).toThrow('架空のAI設定');
  }
});
