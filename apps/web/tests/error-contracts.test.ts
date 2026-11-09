import { expect, test, vi } from 'vitest';
import * as application from '@korekaite/api-contracts/http/application-validators';
import * as materials from '@korekaite/api-contracts/http/materials-validators';
import * as interviews from '@korekaite/api-contracts/http/interviews-validators';
import { applicationFailure } from '../src/server/application-response';
import { localSessionRequest } from '../src/server/local-session';
import { createLocalAccess } from '../src/server/local-access';
import { analyzeMaterialRequest } from '../src/server/materials';
import { createInterviewRequest } from '../src/server/create-interview';
import { createTestDatabase } from '../../../packages/database/testing/sqlite';

vi.mock('@korekaite/api-contracts/http/application-validators', { spy: true });
vi.mock('@korekaite/api-contracts/http/materials-validators', { spy: true });
vi.mock('@korekaite/api-contracts/http/interviews-validators', { spy: true });

test('生成済み契約がエラー応答を拒否したら不正な応答を送らない', async () => {
  const request = new Request('http://localhost/api/local-session');
  const access = createLocalAccess('production', 'a'.repeat(64));
  vi.mocked(application.validateApplicationError)
    .mockReturnValueOnce(false)
    .mockReturnValueOnce(false);
  expect(() => applicationFailure('UNAVAILABLE')).toThrow('エラー契約');
  expect(() => localSessionRequest(request, access)).toThrow('エラー契約');
  expect(() =>
    localSessionRequest(request, {
      ...createLocalAccess('test', 'a'.repeat(64)),
      operationToken: 'invalid',
    }),
  ).toThrow('セッション契約');
  vi.mocked(materials.validateMaterialErrorBody).mockReturnValueOnce(false);
  await expect(
    analyzeMaterialRequest(request, {
      authorize: () => false,
      analyze: vi.fn(),
      reserveAnalysis: vi.fn(),
      saveAnalysis: vi.fn(),
    }),
  ).rejects.toThrow('エラー契約');
  vi.mocked(interviews.validateInterviewErrorBody).mockReturnValueOnce(false);
  const database = createTestDatabase();
  try {
    await expect(
      createInterviewRequest(request, { actor: () => null, db: database.db, now: () => 1 }),
    ).rejects.toThrow('エラー契約');
  } finally {
    database.close();
  }
});
