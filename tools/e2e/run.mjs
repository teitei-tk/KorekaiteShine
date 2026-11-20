import { isScenarioLocation } from './location.ts';
import { loadConfiguration, runCucumber } from '@cucumber/cucumber/api';
import { resolve } from 'node:path';

const [profile, scenario] = process.argv.slice(2);
const location = scenario?.startsWith('--location=') ? scenario.slice(11) : undefined;
if (location !== undefined && !isScenarioLocation(location)) {
  throw new Error('E2Eシナリオの位置が不正です。');
}
if (!['pr', 'live'].includes(profile)) {
  throw new Error('pr または live を指定してください。');
}
process.env.E2E_PROFILE = profile;
process.env.E2E_APP_ROOT = resolve(process.env.E2E_APP_ROOT || '.');
if (profile === 'live') {
  for (const key of ['OPENAI_API_KEY', 'RESPONSES_MODEL', 'MATERIAL_MODEL', 'EVALUATION_MODEL']) {
    if (!process.env[key]?.trim()) {
      throw new Error(`実AIの設定が不足しています: ${key}`);
    }
  }
}
const cwd = import.meta.dirname;
const { runConfiguration } = await loadConfiguration(
  {
    file: false,
    provided: {
      paths: location ? [location] : ['features/**/*.feature'],
      import: ['steps.mjs'],
      tags: `@${profile}`,
      name: scenario && !location ? [scenario] : [],
      format: ['summary'],
      retry: 0,
      strict: true,
    },
  },
  { cwd },
);
const countContext = { count: 0, incomplete: false };
const names = new Map();
const cases = new Map();
const result = await runCucumber(runConfiguration, { cwd }, (message) => {
  if (message.pickle) {
    names.set(message.pickle.id, message.pickle.name);
  }
  if (message.testCase) {
    cases.set(message.testCase.id, names.get(message.testCase.pickleId));
  }
  if (message.testCaseStarted) {
    countContext.count++;
    const { testCaseId } = message.testCaseStarted;
    console.log(`[${profile}] ${cases.get(testCaseId)}`);
  }
  if (message.testStepFinished && message.testStepFinished.testStepResult.status !== 'PASSED') {
    countContext.incomplete = true;
  }
});
if (!countContext.count) {
  console.error('対象シナリオが0件です。');
}
if (
  !countContext.count ||
  (location && countContext.count !== 1) ||
  countContext.incomplete ||
  !result.success
) {
  process.exitCode = 1;
}
