import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

export function requiresRealtimeTests(paths: readonly string[] | null): boolean {
  return paths === null || paths.some((path) => !path.endsWith('.md'));
}

function detect(): boolean {
  if (process.env.EVENT_NAME !== 'pull_request') {
    return true;
  }
  const base = process.env.BASE_SHA ?? '';
  const head = process.env.HEAD_SHA ?? '';
  if (![base, head].every((sha) => /^[a-f0-9]{40}$/.test(sha))) {
    return true;
  }
  try {
    const ancestor = execFileSync('git', ['merge-base', base, head], { encoding: 'utf8' }).trim();
    const output = execFileSync(
      'git',
      ['diff', '--no-renames', '--name-only', '-z', ancestor, head, '--'],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
    );
    return requiresRealtimeTests(output.split('\0').filter(Boolean));
  } catch {
    return true;
  }
}

if (import.meta.main) {
  if (process.argv[2] === 'result') {
    const required =
      process.env.DETECTION_RESULT === 'success'
        ? process.env.REQUIRED === 'true'
          ? true
          : process.env.REQUIRED === 'false'
            ? false
            : null
        : null;
    const result = process.env.TEST_RESULT ?? '';
    const code = realtimeExitCode(required, result);
    const status =
      required === false ? '対象外（文書のみ、または変更なし）' : `対象: ${result || '結果なし'}`;
    const summary = `長時間検査: ${status}\n\nPR head: ${process.env.HEAD_SHA || '対象外'}\n\n実行commit: ${process.env.GITHUB_SHA ?? '不明'}\n\n通常CIとは独立した結果です。\n`;
    console.log(summary);
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
    }
    process.exitCode = code;
  } else if (process.argv.length === 2) {
    console.log(`required=${detect()}`);
  } else {
    throw new Error('引数が不明です。');
  }
}

export function realtimeExitCode(required: boolean | null, result: string): number {
  return (required === false && result === 'skipped') || (required === true && result === 'success')
    ? 0
    : 1;
}
