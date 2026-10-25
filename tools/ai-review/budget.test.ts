import { expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetLedger, cost, maximumCost, validBudget, LIMIT, PRICE_VERSION } from './budget.ts';
const origin = { run: '12', attempt: '1', sha: 'a'.repeat(40) };
const target = { number: 25, head: 'b'.repeat(40), base: 'c'.repeat(40) };
const hash = 'd'.repeat(64);
const usage = { input: 100, cached: 20, written: 30, output: 40, total: 140 };
const create = (limit = LIMIT) =>
  new BudgetLedger(
    join(mkdtempSync(join(tmpdir(), 'budget-')), 'budget.json'),
    origin,
    target,
    limit,
  );
it('キャッシュを入力の内数として計算し、長文料金の境界を適用する', () => {
  expect(cost(usage)).toBe(28950);
  expect(maximumCost(272000)).toBe(38000000);
  expect(maximumCost(272001)).toBe(74000250);
});
it('ちょうど上限を許可し、超過する要求を予約しない', () => {
  const ledger = create(maximumCost(100));
  ledger.reserve(100, hash);
  expect(ledger.snapshot().entries).toHaveLength(1);
  expect(() => ledger.reserve(1, hash)).toThrow();
  const denied = create(maximumCost(100) - 1);
  expect(() => denied.reserve(100, hash)).toThrow('予算');
  expect(denied.snapshot().entries).toHaveLength(0);
  expect(denied.snapshot().denied?.maximum).toBe(maximumCost(100));
});
it('精算を原子的に保存し、次の要求に残予算を使う', () => {
  const ledger = create(maximumCost(100) + cost(usage));
  ledger.reserve(100, hash);
  ledger.settle(usage);
  expect(ledger.snapshot().entries[0].actual).toBe(cost(usage));
  expect(JSON.parse(readFileSync(ledger.path, 'utf8')).entries[0].usage).toEqual(usage);
  expect(ledger.snapshot().pricing).toBe(PRICE_VERSION);
  ledger.reserve(50, hash);
});
it('不明・矛盾したusageでは予約を解放せず、追加要求も拒否する', () => {
  const ledger = create();
  ledger.reserve(100, hash);
  expect(() => ledger.settle({ ...usage, cached: 101 })).toThrow();
  expect(ledger.snapshot().entries[0].actual).toBeNull();
  expect(() => ledger.reserve(100, hash)).toThrow();
});
it('別実行はゼロから開始し、改ざんした金額や自由文を拒否する', () => {
  const ledger = create();
  ledger.reserve(100, hash);
  ledger.settle(usage);
  const record = ledger.snapshot();
  expect(validBudget(record)).toBe(true);
  expect(validBudget(Object.assign({}, record, { secret: 'SECRET' }))).toBe(false);
  expect(validBudget({ ...record, entries: [{ ...record.entries[0], actual: 0 }] })).toBe(false);
  const next = new BudgetLedger(ledger.path, { ...origin, attempt: '2' }, target);
  expect(next.snapshot().entries).toEqual([]);
});
it('モデルの最大入力922000を超える要求を拒否する', () => {
  expect(() => maximumCost(922000)).not.toThrow();
  expect(() => maximumCost(922001)).toThrow();
});
it('実際の1ドル境界で次の生成を止める', () => {
  const ledger = create();
  for (const input of [900000, 900000, 900000, 900000, 272000, 272000]) {
    ledger.reserve(input, hash);
    ledger.settle({ input, cached: 0, written: input, output: 8000, total: input + 8000 });
  }
  expect(ledger.snapshot().entries.reduce((n, e) => n + e.actual!, 0)).toBe(LIMIT);
  expect(() => ledger.reserve(0, hash)).toThrow('予算');
  expect(ledger.snapshot().entries).toHaveLength(6);
});
it('12回を超えても費用内なら予約と精算を継続する', () => {
  const ledger = create();
  for (let i = 0; i < 30; i++) {
    ledger.reserve(100, hash);
    ledger.settle(usage);
  }
  expect(validBudget(ledger.snapshot())).toBe(true);
  expect(ledger.snapshot().entries).toHaveLength(30);
});
