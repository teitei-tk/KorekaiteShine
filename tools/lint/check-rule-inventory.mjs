import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const rules = JSON.parse(
  execFileSync(
    process.execPath,
    ['node_modules/oxlint/bin/oxlint', '--rules', '--format', 'json'],
    {
      encoding: 'utf8',
    },
  ),
);
const configuration = JSON.parse(readFileSync('.oxlintrc.json', 'utf8'));
const exceptions = JSON.parse(readFileSync('tools/lint/rule-exceptions.json', 'utf8'));
const inventory = JSON.parse(
  readFileSync(process.argv[2] ?? 'tools/lint/rule-inventory.json', 'utf8'),
);
const key = (rule) => `${rule.scope}/${rule.value}`;
const current = new Map(rules.map((rule) => [key(rule), rule]));
const recorded = new Map(inventory.map((rule) => [rule.rule, rule]));
const severity = (value) => (Array.isArray(value) ? value[0] : value);
const errors = [
  ...Object.entries(configuration.rules).flatMap(([rule, value]) =>
    severity(value) === 'off' && !exceptions[rule] ? [`例外理由がありません: ${rule}`] : [],
  ),
  ...rules.flatMap((rule) => {
    const entry = recorded.get(key(rule));
    if (!entry) {
      return [`未分類のoxlint規則: ${key(rule)}`];
    }
    const configuredName =
      rule.scope === 'eslint' ? rule.value : `${rule.scope.replaceAll('_', '-')}/${rule.value}`;
    const disabled = severity(configuration.rules[configuredName]) === 'off';
    if (disabled !== (entry.status === 'exception')) {
      return [`有効設定と分類が一致しません: ${key(rule)}`];
    }
    if (entry.category !== rule.category || entry.typeAware !== rule.type_aware) {
      return [`oxlint規則の仕様変更: ${key(rule)}`];
    }
    if (!['enabled', 'scoped', 'exception', 'not-applicable'].includes(entry.status)) {
      return [`不正な分類: ${key(rule)}`];
    }
    if (entry.status !== 'enabled' && !entry.reason) {
      return [`分類理由がありません: ${key(rule)}`];
    }
    return [];
  }),
  ...inventory.flatMap((entry) =>
    current.has(entry.rule) ? [] : [`削除されたoxlint規則: ${entry.rule}`],
  ),
  ...(recorded.size === inventory.length ? [] : ['規則台帳に重複があります']),
];
if (errors.length > 0) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`oxlint規則台帳: ${rules.length}件を確認しました。`);
}
