import { renameSync, writeFileSync } from 'node:fs';
import type { GenerationOrigin } from './artifact.ts';
import { ReviewFailure } from './failure.ts';

// 1 USD = 10^9 units。公表単価と確認日を版に固定。Standard / 30mのみ。
export const LIMIT = 1_000_000_000;
export const MODEL = 'gpt-6-luna';
export const PRICE_VERSION = 'gpt-6-luna-standard-30m-2026-10-25';
export const MAX_OUTPUT = 8000; // 旧呼び出し・旧台帳の既定
export const MODEL_MAX_OUTPUT = 128_000;
export const MAX_INPUT = 922_000;
export interface BillingUsage {
  input: number;
  cached: number;
  written: number;
  output: number;
  total: number;
  reasoning?: number;
}
export interface BillingHooks {
  reserve(input: number, hash: string, outputLimit?: number): Promise<void>;
  settle(usage: BillingUsage): Promise<void>;
}
export interface BudgetTarget {
  number: number;
  head: string;
  base: string;
}
interface Entry {
  outputLimit?: number;
  input: number;
  hash: string;
  maximum: number;
  actual: number | null;
  usage?: BillingUsage;
}
export interface BudgetRecord {
  version: 1 | 2;
  pricing: string;
  origin: GenerationOrigin;
  target: BudgetTarget;
  limit: number;
  entries: Entry[];
  denied?: { input: number; hash: string; maximum: number; outputLimit?: number };
}
const integer = (n: number | undefined, max = Number.MAX_SAFE_INTEGER): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= max;
const keys = (v: object, allowed: string[]) => Object.keys(v).every((k) => allowed.includes(k));
function rates(input: number) {
  return input > 272000
    ? { input: 200, cached: 20, written: 250, output: 750 }
    : { input: 100, cached: 10, written: 125, output: 500 };
}
export function validUsage(u: Partial<BillingUsage> | null | undefined): u is BillingUsage {
  return (
    !!u &&
    keys(u, ['input', 'cached', 'written', 'output', 'total', 'reasoning']) &&
    integer(u.input, 2_000_000) &&
    integer(u.cached, 2_000_000) &&
    integer(u.written, 2_000_000) &&
    integer(u.output, MODEL_MAX_OUTPUT) &&
    integer(u.total, 2_000_000) &&
    u.cached + u.written <= u.input &&
    u.input + u.output === u.total &&
    (u.reasoning === undefined || integer(u.reasoning, u.output))
  );
}
export function cost(u: BillingUsage): number {
  if (!validUsage(u)) throw new ReviewFailure('USAGE_INVALID', '使用量が不正です');
  const r = rates(u.input);
  return (
    (u.input - u.cached - u.written) * r.input +
    u.cached * r.cached +
    u.written * r.written +
    u.output * r.output
  );
}
export function maximumCost(input: number, outputLimit = MAX_OUTPUT): number {
  if (!integer(input)) throw new ReviewFailure('TOKEN_COUNT_FAILED', '入力計数が不正です');
  if (input > MAX_INPUT)
    throw new ReviewFailure('INPUT_TOKEN_LIMIT', '入力トークン上限を超えました');
  if (!integer(outputLimit, MODEL_MAX_OUTPUT) || outputLimit < 1)
    throw new ReviewFailure('USAGE_INVALID', '出力枠が不正です');
  const r = rates(input);
  return input * r.written + outputLimit * r.output;
}
export function spent(record: BudgetRecord): number {
  return record.entries.reduce((sum, e) => sum + (e.actual ?? e.maximum), 0);
}
export function validBudget(r: BudgetRecord): boolean {
  try {
    if (
      !r ||
      !keys(r, ['version', 'pricing', 'origin', 'target', 'limit', 'entries', 'denied']) ||
      ![1, 2].includes(r.version) ||
      r.pricing !== PRICE_VERSION ||
      !integer(r.limit, LIMIT) ||
      r.limit < 1 ||
      !r.origin ||
      !keys(r.origin, ['run', 'attempt', 'sha']) ||
      !/^[1-9]\d{0,17}$/.test(r.origin.run) ||
      !/^[1-9]\d{0,5}$/.test(r.origin.attempt) ||
      !/^[a-f0-9]{40}$/.test(r.origin.sha) ||
      !r.target ||
      !keys(r.target, ['number', 'head', 'base']) ||
      !integer(r.target.number) ||
      r.target.number < 1 ||
      !/^[a-f0-9]{40}$/.test(r.target.head) ||
      !/^[a-f0-9]{40}$/.test(r.target.base) ||
      !Array.isArray(r.entries)
    )
      return false;
    let total = 0;
    for (const [i, e] of r.entries.entries()) {
      if (
        !e ||
        !keys(e, ['input', 'hash', 'maximum', 'actual', 'usage', 'outputLimit']) ||
        !/^[a-f0-9]{64}$/.test(e.hash) ||
        (r.version === 2
          ? !integer(e.outputLimit, MODEL_MAX_OUTPUT) || e.outputLimit! < 1
          : e.outputLimit !== undefined) ||
        maximumCost(e.input, e.outputLimit) !== e.maximum ||
        total + e.maximum > r.limit
      )
        return false;
      if (e.actual === null) {
        if (e.usage !== undefined || i !== r.entries.length - 1 || r.denied) return false;
      } else if (
        !e.usage ||
        cost(e.usage) !== e.actual ||
        e.usage.output > (e.outputLimit ?? MAX_OUTPUT) ||
        e.usage.input !== e.input
      )
        return false;
      total += e.actual ?? e.maximum;
    }
    if (r.denied) {
      const d = r.denied;
      if (
        !keys(d, ['input', 'hash', 'maximum', 'outputLimit']) ||
        !/^[a-f0-9]{64}$/.test(d.hash) ||
        (r.version === 2
          ? !integer(d.outputLimit, MODEL_MAX_OUTPUT) || d.outputLimit! < 1
          : d.outputLimit !== undefined) ||
        maximumCost(d.input, d.outputLimit) !== d.maximum ||
        total + d.maximum <= r.limit
      )
        return false;
    }
    return true;
  } catch {
    return false;
  }
}
export class BudgetLedger {
  private record: BudgetRecord;
  readonly path: string;
  constructor(path: string, origin: GenerationOrigin, target: BudgetTarget, limit = LIMIT) {
    this.path = path;
    this.record = { version: 2, pricing: PRICE_VERSION, origin, target, limit, entries: [] };
    this.save();
  }
  snapshot(): BudgetRecord {
    return structuredClone(this.record);
  }
  private save(): void {
    if (!validBudget(this.record)) throw new ReviewFailure('USAGE_INVALID', '費用記録が不正です');
    const json = JSON.stringify(this.record);
    writeFileSync(this.path + '.tmp', json, { mode: 0o600 });
    renameSync(this.path + '.tmp', this.path);
  }
  reserve(input: number, hash: string, outputLimit = MAX_OUTPUT): void {
    if (this.record.denied || this.record.entries.some((e) => e.actual === null))
      throw new ReviewFailure('USAGE_INVALID', '未精算の要求があります');
    const next = { input, hash, outputLimit, maximum: maximumCost(input, outputLimit) };
    if (spent(this.record) + next.maximum > this.record.limit) {
      this.record.denied = next;
      this.save();
      throw new ReviewFailure('COST_BUDGET_EXCEEDED', '予算上限を超えます');
    }
    this.record.entries.push({ ...next, actual: null });
    this.save();
  }
  settle(usage: BillingUsage): void {
    const entry = this.record.entries.at(-1);
    if (!entry || entry.actual !== null)
      throw new ReviewFailure('USAGE_INVALID', '予約がありません');
    if (
      !validUsage(usage) ||
      usage.input !== entry.input ||
      usage.output > (entry.outputLimit ?? MAX_OUTPUT)
    )
      throw new ReviewFailure('USAGE_INVALID', '予約と使用量が一致しません');
    const actual = cost(usage);
    entry.actual = actual;
    entry.usage = { ...usage };
    this.save();
    if (spent(this.record) > this.record.limit)
      throw new ReviewFailure('COST_BUDGET_EXCEEDED', '予算上限を超過しました');
    if (usage.input !== entry.input || actual > entry.maximum)
      throw new ReviewFailure('USAGE_INVALID', '計数と使用量が一致しません');
  }
}
