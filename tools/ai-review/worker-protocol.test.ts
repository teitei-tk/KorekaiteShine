import { expect, it, vi } from 'vitest';
import { fork, ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetLedger, maximumCost } from './budget.ts';
import { callWorker } from './orchestrate.ts';
import type { ReviewPlan, ReviewTask } from './partition.ts';
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  fork: vi.fn(),
}));
const task: ReviewTask = { id: 'task-1', kind: 'unit', sources: [], obligations: [], priorIds: [] };
const target = { number: 25, head: 'a'.repeat(40), base: 'b'.repeat(40) };
const plan: ReviewPlan = {
  version: 1,
  metadata: { ...target, lines: {} },
  sources: [],
  tasks: [task],
  obligations: [],
  excluded: [],
};
const input = { task, prompt: 'fixture', candidates: [], priorChecks: [] };
it.each(['invalid-json', 'exit', 'budget', 'timeout'])(
  '子の生成・検証より先に親が費用を保存する: %s',
  async (scenario) => {
    const path = join(mkdtempSync(join(tmpdir(), 'budget-ipc-')), 'budget.json');
    const ledger = new BudgetLedger(
      path,
      { run: '1', attempt: '1', sha: 'c'.repeat(40) },
      target,
      scenario === 'budget' ? maximumCost(100) - 1 : undefined,
    );
    const saved: object[] = [];
    const child = new ChildProcess();
    vi.spyOn(child, 'kill').mockReturnValue(true);
    child.send = (message) => {
      if (
        typeof message === 'object' &&
        message !== null &&
        'approved' in message &&
        message.approved
      )
        saved.push(JSON.parse(readFileSync(path, 'utf8')));
      return true;
    };
    vi.mocked(fork).mockReturnValue(child);
    const controller = new AbortController();
    const result = callWorker(input, 'TOKEN', plan, ledger, controller.signal);
    const rejected = expect(result).rejects.toThrow();
    child.emit('message', { kind: 'reserve', input: 100, hash: 'd'.repeat(64) });
    if (scenario === 'budget') expect(saved).toHaveLength(0);
    else {
      expect(saved[0]).toMatchObject({ entries: [{ input: 100, actual: null }] });
      if (scenario === 'timeout') controller.abort();
      else if (scenario === 'exit') child.emit('exit', 1);
      else {
        child.emit('message', {
          kind: 'settle',
          usage: { input: 100, cached: 0, written: 0, output: 20, total: 120 },
        });
        expect(saved[1]).toMatchObject({ entries: [{ actual: 20000 }] });
        child.emit('message', {
          kind: 'result',
          result: { failure: 'OUTPUT_INVALID', detail: { subcode: 'INVALID_JSON', missing: [] } },
        });
      }
    }
    await rejected;
    expect(child.kill).toHaveBeenCalled();
    expect(readFileSync(path, 'utf8')).not.toContain('TOKEN');
    if (scenario === 'exit' || scenario === 'timeout')
      expect(ledger.snapshot().entries[0].actual).toBeNull();
  },
);

it.each([false, true])(
  '出力不足の回復を許すのは親がusageを精算した場合だけ: %s',
  async (settled) => {
    const ledger = new BudgetLedger(
      join(mkdtempSync(join(tmpdir(), 'recovery-ipc-')), 'budget.json'),
      { run: '1', attempt: '1', sha: 'c'.repeat(40) },
      target,
    );
    const child = new ChildProcess();
    vi.spyOn(child, 'kill').mockReturnValue(true);
    child.send = () => true;
    vi.mocked(fork).mockReturnValue(child);
    const result = callWorker({ ...input, outputLimit: 32000 }, 'TOKEN', plan, ledger);
    const rejected = expect(result).rejects.toMatchObject({
      reason: settled ? 'INCOMPLETE' : 'USAGE_INVALID',
    });
    child.emit('message', {
      kind: 'reserve',
      input: 100,
      hash: 'd'.repeat(64),
      outputLimit: 32000,
    });
    if (settled)
      child.emit('message', {
        kind: 'settle',
        usage: { input: 100, cached: 0, written: 0, output: 32000, total: 32100, reasoning: 31000 },
      });
    child.emit('message', {
      kind: 'result',
      result: { failure: 'INCOMPLETE', detail: { subcode: 'TOKEN_LIMIT', missing: [] } },
    });
    await rejected;
    expect(ledger.snapshot().entries[0].actual === null).toBe(!settled);
  },
);
