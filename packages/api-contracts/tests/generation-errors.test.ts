import { readFile, writeFile } from 'node:fs/promises';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile), writeFile: vi.fn() };
});
afterEach(() => {
  vi.resetAllMocks();
  vi.resetModules();
});

test('必須の冪等キーが契約にない場合は検証コードを生成せず原因を報告する', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const document = JSON.parse(
    await actual.readFile(new URL('../generated/http/openapi.json', import.meta.url), 'utf8'),
  );
  const operation = document.paths['/api/diagnostics/check-jobs'].post;
  operation.parameters = operation.parameters.filter(
    (parameter: { in: string; name: string }) => parameter.name !== 'Idempotency-Key',
  );
  vi.mocked(readFile).mockResolvedValue(JSON.stringify(document));
  await expect(import('../scripts/generate-diagnostics-validation.ts')).rejects.toThrow(
    '契約にIdempotency-Keyがありません。',
  );
  expect(writeFile).not.toHaveBeenCalled();
});

test('検証コードを書き込めなければ型宣言の出力へ進まず元のエラーを返す', async () => {
  const failure = Object.assign(new Error('fixture write failure'), { code: 'EACCES' });
  vi.mocked(writeFile).mockRejectedValueOnce(failure);
  await expect(import('../scripts/generate-diagnostics-validation.ts')).rejects.toBe(failure);
  expect(writeFile).toHaveBeenCalledTimes(1);
  expect(String(vi.mocked(writeFile).mock.calls[0][0])).toMatch(/diagnostics-validators\.mjs$/);
});

test('存在しないschemaを参照する契約から検証コードを出力しない', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const document = JSON.parse(
    await actual.readFile(new URL('../generated/http/openapi.json', import.meta.url), 'utf8'),
  );
  document.paths['/api/diagnostics/check-jobs'].post.requestBody.content[
    'application/json'
  ].schema = {
    $ref: '#/components/schemas/MissingFixture',
  };
  vi.mocked(readFile).mockResolvedValue(JSON.stringify(document));
  await expect(import('../scripts/generate-diagnostics-validation.ts')).rejects.toThrow(
    "can't resolve reference #/components/schemas/MissingFixture",
  );
  expect(writeFile).not.toHaveBeenCalled();
});
