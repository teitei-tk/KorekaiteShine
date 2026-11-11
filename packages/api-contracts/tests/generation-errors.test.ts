import { SystemError } from '../../../tools/testing/system-error.mts';
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
  const failure = new SystemError('fixture write failure', 'EACCES');
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

async function applicationDocument() {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return JSON.parse(
    await actual.readFile(new URL('../generated/http/openapi.json', import.meta.url), 'utf8'),
  );
}

test.each([
  ['https://fixture.invalid/parameter', '未対応の引数参照です。'],
  ['#/components/parameters/missing', '引数の参照先がありません。'],
])('履歴の引数参照 %s を解決できない場合は生成を停止する', async (reference, message) => {
  const document = await applicationDocument();
  document.paths['/api/interview-history'].get.parameters = [{ $ref: reference }];
  vi.mocked(readFile).mockResolvedValue(JSON.stringify(document));
  await expect(import('../scripts/generate-application-validation.ts')).rejects.toThrow(message);
  expect(writeFile).not.toHaveBeenCalled();
});

test('面接IDのパス引数がない場合はアプリのvalidatorを生成しない', async () => {
  const document = await applicationDocument();
  document.paths['/api/interviews/{interviewId}'].get.parameters = [{ in: 'header', name: 'id' }];
  vi.mocked(readFile).mockResolvedValue(JSON.stringify(document));
  await expect(import('../scripts/generate-application-validation.ts')).rejects.toThrow(
    '面接IDの契約がありません。',
  );
  expect(writeFile).not.toHaveBeenCalled();
});

test('履歴のインライン引数と参照付きの必須引数からvalidatorを生成する', async () => {
  const document = await applicationDocument();
  document.components.parameters['key/alias~'] = {
    in: 'query',
    name: 'cursor',
    required: true,
    schema: { type: 'string' },
  };
  document.paths['/api/interview-history'].get.parameters = [
    { $ref: '#/components/parameters/key~1alias~0' },
    { in: 'header', name: 'ignored' },
  ];
  vi.mocked(readFile).mockResolvedValue(JSON.stringify(document));
  await import('../scripts/generate-application-validation.ts');
  const code = String(vi.mocked(writeFile).mock.calls[0][1]);
  const { validateInterviewHistoryQuery } = await import(
    /* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
  );
  expect(validateInterviewHistoryQuery({ cursor: 'page' })).toBe(true);
  expect(validateInterviewHistoryQuery({})).toBe(false);
  expect(validateInterviewHistoryQuery({ cursor: 'page', ignored: true })).toBe(false);
});

test.each([
  [
    'evaluation',
    'InterviewEvaluation',
    '評価',
    () => import('../scripts/generate-evaluation-validation.ts'),
  ],
  [
    'materials',
    'MaterialAnalysisResult',
    '材料',
    () => import('../scripts/generate-materials-validation.ts'),
  ],
] as const)(
  '%s のAI用Schemaに外部・欠損参照があれば部分的な出力を残さない',
  async (_scope, model, label, generate) => {
    for (const [reference, message] of [
      ['other.json', '未対応の' + label + 'Schema参照です。'],
      ['#/components/schemas/Missing', label + 'Schema参照先がありません。'],
    ]) {
      vi.resetModules();
      const document = await applicationDocument();
      document.components.schemas[model].properties.fixture = { $ref: reference };
      vi.mocked(readFile).mockResolvedValue(JSON.stringify(document));
      await expect(generate()).rejects.toThrow(message);
      expect(writeFile).not.toHaveBeenCalled();
    }
  },
);

test('イベント契約の再生成では前回のvalidator・型宣言をSchemaとして読み込まない', async () => {
  await import('../scripts/generate-events.ts');
  const readPaths = vi.mocked(readFile).mock.calls.map(([path]) => String(path));
  expect(readPaths).toContainEqual(expect.stringMatching(/LiveStartEvent\.json$/u));
  expect(readPaths.every((path) => path.endsWith('.json'))).toBe(true);
  expect(writeFile).toHaveBeenCalledWith(
    expect.any(URL),
    expect.stringContaining('export const validateLiveStartEvent'),
  );
});
