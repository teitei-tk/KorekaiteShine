import { beforeAll, afterAll } from 'vitest';
import { createBoundaryBundle } from '../../src/boundary-bundle.ts';
import { startRuntime as measuredStart } from './measured-runtime.ts';
export { runDatabaseCommand } from './measured-runtime.ts';

const bundle = { directory: '', dispose: undefined as (() => Promise<void>) | undefined };
beforeAll(async () => {
  const prepared = process.env.KOREKAITE_BOUNDARY_BUNDLE;
  if (prepared) {
    bundle.directory = prepared;
    return;
  }
  const created = await createBoundaryBundle();
  bundle.directory = created.directory;
  bundle.dispose = created.dispose;
}, 120_000);
afterAll(async () => {
  await bundle.dispose?.();
});

export async function startRuntime(...args: Parameters<typeof measuredStart>) {
  const [config, mode = 'dev', options = {}] = args;
  if (mode !== 'dev' || config.environment !== 'test' || !bundle.directory) {
    throw new Error('境界テストの事前ビルドが準備されていません。');
  }
  return measuredStart(config, 'preview', { ...options, boundaryBundle: bundle.directory });
}
