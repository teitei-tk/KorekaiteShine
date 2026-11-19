import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseJson } from '@korekaite/api-contracts/json';
import { readStartupTiming } from '../../src/startup-timing.ts';
import * as runtime from '../../src/runtime.ts';
import * as production from '../../src/production.ts';
import { measureOperation, recordStartupTiming } from './runtime-timing.ts';

export async function startRuntime(...args: Parameters<typeof runtime.startRuntime>) {
  const [config, mode = 'dev', options] = args;
  const profileStartup = config.environment === 'test';
  const started = performance.now();
  const result = await measureOperation('startup', () =>
    runtime.startRuntime(config, mode, {
      ...options,
      profileStartup,
      profileVite: profileStartup && mode === 'dev',
    }),
  );
  const outerMs = performance.now() - started;
  if (profileStartup) {
    try {
      const timing = readStartupTiming(
        parseJson(await readFile(join(config.artifactDirectory, 'startup-timing.json'), 'utf8')),
      );
      recordStartupTiming(timing, outerMs);
      if (mode === 'dev' && !options?.boundaryBundle) {
        const profile = parseJson(
          await readFile(join(config.artifactDirectory, 'vite-profile.json'), 'utf8'),
        );
        process.stdout.write(`vite-startup-timing ${JSON.stringify(profile)}\n`);
      }
    } catch (error) {
      await result.stop();
      throw error;
    }
  }
  return { ...result, stop: () => measureOperation('shutdown', () => result.stop()) };
}
export function runDatabaseCommand(...args: Parameters<typeof runtime.runDatabaseCommand>) {
  return measureOperation('database', () => runtime.runDatabaseCommand(...args));
}
export function buildRuntime(...args: Parameters<typeof runtime.buildRuntime>) {
  return measureOperation('build', () => runtime.buildRuntime(...args));
}
export function buildProductionArtifacts(
  ...args: Parameters<typeof production.buildProductionArtifacts>
) {
  return measureOperation('build', () => production.buildProductionArtifacts(...args));
}
export function runProductionBuild(...args: Parameters<typeof production.runProductionBuild>) {
  return measureOperation('build', () => production.runProductionBuild(...args));
}
export async function startProductionPreview(
  ...args: Parameters<typeof production.startProductionPreview>
) {
  const result = await measureOperation('startup', () =>
    production.startProductionPreview(...args),
  );
  return { ...result, stop: () => measureOperation('shutdown', () => result.stop()) };
}
export { verifyProductionArtifacts } from '../../src/production.ts';
