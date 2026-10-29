import { readFileSync, writeSync } from 'node:fs';
import { probeIsolation, type IsolationInput } from '../isolation-probe.js';
const input: IsolationInput = JSON.parse(readFileSync('/opt/ai-review-probe/input.json', 'utf8'));
input.env = process.env;
// fixtureは子shellから呼び出される。PRスクリプト実行自体が許可されることも確認する。
const report = await probeIsolation(input);
writeSync(1, JSON.stringify({ stage: 'sandbox', ...report }) + '\n');
process.exitCode = report.passed ? 0 : 1;
