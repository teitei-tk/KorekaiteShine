import { describe, it } from 'vitest';
import { RuleTester } from 'oxlint/plugins-dev';
import immutable from '../lint/immutable.mjs';

RuleTester.describe = describe;
RuleTester.it = it;
const tester = new RuleTester({
  languageOptions: { globals: { Object: 'readonly', globalThis: 'readonly' } },
});

tester.run('no-let', immutable.rules['no-let'], {
  valid: ['const count = 1;'],
  invalid: [{ code: 'let count = 1;', errors: 1 }],
});

tester.run('no-param-reassign', immutable.rules['no-param-reassign'], {
  valid: ['function read(value = 1) { return value; }'],
  invalid: [{ code: 'const f = (value) => value++;', errors: 1 }],
});

tester.run('no-object-assign', immutable.rules['no-object-assign'], {
  valid: [
    'Object.keys({});',
    'function local(Object) { return Object.assign({}, {}); }',
    'function local(globalThis) { return globalThis.Object.assign({}, {}); }',
    'other.assign({}, {});',
    'other.Object.assign({}, {});',
    'globalThis.other.assign({}, {});',
    'getObject().assign({}, {});',
    'getScope().Object.assign({}, {});',
  ],
  invalid: [
    { code: 'Object["assign"]({}, {});', errors: 1 },
    { code: 'globalThis.Object.assign({}, {});', errors: 1 },
  ],
});
