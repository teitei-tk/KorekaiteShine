import { readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';

const document = JSON.parse(
  await readFile(new URL('../generated/http/openapi.json', import.meta.url), 'utf8'),
);

test('診断の開始と状態取得で成功・エラー・必須ヘッダーを定義する', () => {
  const start = document.paths['/api/diagnostics/check-jobs']?.post;
  const get = document.paths['/api/diagnostics/check-jobs/{jobId}']?.get;
  expect(start).toBeDefined();
  expect(get).toBeDefined();
  expect(Object.keys(start.responses).sort()).toEqual(['202', '400', '409', '415', '500', '503']);
  expect(Object.keys(get.responses).sort()).toEqual(['200', '400', '404', '500', '503']);
  expect(start.parameters).toContainEqual(
    expect.objectContaining({ in: 'header', name: 'Idempotency-Key', required: true }),
  );
  expect(start.requestBody.required).toBe(true);
  expect(start.requestBody.content['application/json']).toBeDefined();
  expect(start.responses['202'].headers.Location.required).toBe(true);
  for (const operation of [start, get]) {
    for (const status of Object.keys(operation.responses)) {
      expect(operation.responses[status].headers['Cache-Control']).toMatchObject({
        required: true,
        schema: { type: 'string', enum: ['no-store'] },
      });
    }
  }
});
