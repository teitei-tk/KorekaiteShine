import { fileURLToPath } from 'node:url';
import { resolveRuntime } from '@korekaite/runtime-config';
import { buildRuntime, runDatabaseCommand, startRuntime } from './runtime.ts';

async function main(): Promise<void> {
  const [command, ...extra] = process.argv.slice(2);
  if (extra.length) throw new Error('追加引数は受け付けません。ローカル専用の操作入口です。');
  if (
    !['dev', 'build', 'preview', 'db:generate', 'db:migrate', 'db:reset-seed'].includes(
      command ?? '',
    )
  ) {
    throw new Error(
      '操作を指定してください: dev / build / preview / db:generate / db:migrate / db:reset-seed',
    );
  }
  const config = resolveRuntime({
    repositoryRoot: fileURLToPath(new URL('../../../', import.meta.url)),
    appEnv: process.env.APP_ENV ?? 'development',
    runId: process.env.LOCAL_TEST_RUN_ID,
    parallelIndex:
      process.env.LOCAL_TEST_SLOT === undefined ? undefined : Number(process.env.LOCAL_TEST_SLOT),
  });
  if (command === 'build') {
    await buildRuntime(config);
  } else if (command === 'db:reset-seed') {
    await runDatabaseCommand(config, ['reset-seed']);
  } else if (command === 'db:generate' || command === 'db:migrate') {
    await runDatabaseCommand(config, [command === 'db:generate' ? 'generate' : 'migrate']);
  } else {
    const runtime = await startRuntime(config, command === 'preview' ? 'preview' : 'dev');
    console.log(`ローカルWeb: ${runtime.baseUrl}`);
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      runtime.stop().catch((error: Error) => {
        console.error(error.message);
        process.exitCode = 1;
      });
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    console.log(`生成物とログ: ${config.artifactDirectory}`);
    if ((await runtime.closed).exitCode !== 0)
      throw new Error('ローカルランタイムが予期せず終了しました。');
    return;
  }
  console.log(`生成物とログ: ${config.artifactDirectory}`);
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
});
