import { parseExplorationOptions } from './options.ts';
import { runExploration } from './runner.ts';

export async function executeCommand(
  args: readonly string[],
  execute: typeof runExploration = runExploration,
): Promise<number> {
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  try {
    const reproduction = args[0] === 'reproduce';
    const options = parseExplorationOptions(reproduction ? args.slice(1) : args);
    if (reproduction && !options.reproduce) {
      throw new Error('再現元を --reproduce で指定してください。');
    }
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', interrupt);
    const result = await execute(options, controller.signal);
    console.log(JSON.stringify(result));
    return { passed: 0, violated: 2, incomplete: 3, infrastructure_error: 1 }[result.status];
  } catch {
    console.error(
      '探索を開始できませんでした。引数と出力先を確認してください。再現には --reproduce が必要です。',
    );
    return 1;
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
  }
}

if (import.meta.main) {
  process.exitCode = await executeCommand(process.argv.slice(2));
}
