import * as runtime from '../../src/runtime.ts';
import * as production from '../../src/production.ts';
import { measureOperation } from './runtime-timing.ts';

export async function startRuntime(...args: Parameters<typeof runtime.startRuntime>) {
  const result = await measureOperation('startup', () => runtime.startRuntime(...args));
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
