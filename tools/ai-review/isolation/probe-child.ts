import { readFileSync, writeSync } from 'node:fs';
import { probeIsolation } from '../isolation-probe.ts';
import { isolationInput } from './input.ts';
const input = isolationInput(readFileSync('/opt/ai-review-probe/input.json', 'utf8'));
input.env = process.env;
// fixtureは子shellから呼び出される。PRスクリプト実行自体が許可されることも確認する。
const report = await probeIsolation(input);
writeSync(1, `${JSON.stringify({ stage: 'sandbox', ...report })}\n`);
process.exitCode = report.passed ? 0 : 1;
