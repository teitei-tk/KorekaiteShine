import { loadConfiguration, loadSources } from '@cucumber/cucumber/api';

const cwd = import.meta.dirname;
const { runConfiguration } = await loadConfiguration(
  {
    file: false,
    provided: { paths: ['features/**/*.feature'], tags: '@pr' },
  },
  { cwd },
);
const { plan, errors } = await loadSources(runConfiguration.sources, { cwd });
if (errors.length > 0 || plan.length === 0) {
  throw new Error('E2Eシナリオの検出に失敗しました。');
}
const locations = plan.map(({ uri, location }) => `${uri}:${location.line}`);
if (new Set(locations).size !== locations.length) {
  throw new Error('E2Eシナリオの位置が重複しています。');
}
console.log(JSON.stringify(locations));
