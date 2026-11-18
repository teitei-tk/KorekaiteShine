import { afterEach, expect, test, vi } from 'vitest';
import { loadConfiguration, runCucumber } from '@cucumber/cucumber/api';

vi.mock('@cucumber/cucumber/api', () => ({ loadConfiguration: vi.fn(), runCucumber: vi.fn() }));
const originalArgs = process.argv;
const originalExit = process.exitCode;
afterEach(() => {
  process.argv = originalArgs;
  process.exitCode = originalExit;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

test.each([
  ['pr', 'PASSED', true, 0],
  ['live', 'FAILED', true, 1],
  ['pr', 'PASSED', false, 1],
  ['pr', null, true, 1],
])('%sで実行結果 %s / %s を終了コードへ反映する', async (profile, status, success, expected) => {
  process.argv = ['node', 'run.mjs', profile, ...(profile === 'live' ? ['再開'] : [])];
  process.exitCode = 0;
  for (const key of ['OPENAI_API_KEY', 'RESPONSES_MODEL', 'MATERIAL_MODEL', 'EVALUATION_MODEL']) {
    vi.stubEnv(key, 'fixture');
  }
  vi.stubEnv('E2E_PROFILE', undefined);
  vi.stubEnv('E2E_APP_ROOT', profile === 'live' ? '/example' : '');
  const log = vi.spyOn(console, 'log').mockImplementation(() => {
    /* この実装では追加の処理を行わない。 */
  });
  const error = vi.spyOn(console, 'error').mockImplementation(() => {
    /* この実装では追加の処理を行わない。 */
  });
  loadConfiguration.mockResolvedValue({ runConfiguration: {} });
  runCucumber.mockImplementation(async (_config, _context, emit) => {
    if (status) {
      emit({ pickle: { id: 'p', name: '面接' } });
      emit({ testCase: { id: 'c', pickleId: 'p' } });
      emit({ testCaseStarted: { testCaseId: 'c' } });
      emit({ testStepFinished: { testStepResult: { status } } });
    }
    return { success };
  });
  await import('../run.mjs');
  expect(loadConfiguration.mock.lastCall[0].provided).toMatchObject({
    tags: `@${profile}`,
    name: profile === 'live' ? ['再開'] : [],
    retry: 0,
    strict: true,
  });
  expect(process.exitCode).toBe(expected);
  if (status) {
    expect(log).toHaveBeenCalledWith(`[${profile}] 面接`);
  } else {
    expect(error).toHaveBeenCalledWith('対象シナリオが0件です。');
  }
});

test.each([
  ['unknown', 'pr または live'],
  ['live', '実AIの設定が不足'],
])('不正な起動設定 %s は実行前に拒否する', async (profile, message) => {
  process.argv = ['node', 'run.mjs', profile];
  vi.stubEnv('E2E_PROFILE', undefined);
  vi.stubEnv('E2E_APP_ROOT', undefined);
  vi.stubEnv('OPENAI_API_KEY', undefined);
  await expect(import('../run.mjs')).rejects.toThrow(message);
});

test('CIの完全一致指定ではfeatureの行を選び名前の正規表現を使わない', async () => {
  process.argv = ['node', 'run.mjs', 'pr', '--location=features/voice-interview.feature:7'];
  process.exitCode = 0;
  loadConfiguration.mockResolvedValue({ runConfiguration: {} });
  runCucumber.mockImplementation(async (_config, _context, emit) => {
    emit({ testCaseStarted: { testCaseId: 'only' } });
    return { success: true };
  });
  await import('../run.mjs');
  expect(loadConfiguration.mock.lastCall[0].provided).toMatchObject({
    paths: ['features/voice-interview.feature:7'],
    name: [],
  });
  expect(process.exitCode).toBe(0);
});

test.each([0, 2])('行指定が%s件を実行した場合は成功扱いしない', async (count) => {
  process.argv = ['node', 'run.mjs', 'pr', '--location=features/voice-interview.feature:7'];
  process.exitCode = 0;
  loadConfiguration.mockResolvedValue({ runConfiguration: {} });
  runCucumber.mockImplementation(async (_config, _context, emit) => {
    for (const index of Array.from({ length: count }, (_, index) => index)) {
      emit({ testCaseStarted: { testCaseId: `case-${index}` } });
    }
    return { success: true };
  });
  await import('../run.mjs');
  expect(process.exitCode).toBe(1);
});

test.each(['../outside.feature:1', 'features/voice.feature:0', 'features/*.feature:1'])(
  '不正な位置%sは実行前に拒否する',
  async (location) => {
    process.argv = ['node', 'run.mjs', 'pr', `--location=${location}`];
    await expect(import('../run.mjs')).rejects.toThrow('位置が不正');
  },
);
