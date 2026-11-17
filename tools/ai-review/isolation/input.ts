import { isJsonObject, parseJson } from '../json.ts';
import type { JsonInput } from '../json.ts';
import type { IsolationInput } from '../isolation-probe.ts';

export function readObject(text: string): Record<string, JsonInput> {
  const value = parseJson(text);
  if (!isJsonObject(value)) {
    throw new TypeError('invalid fixture JSON object');
  }
  return value;
}
export function textField(value: JsonInput): string {
  if (typeof value !== 'string') {
    throw new TypeError('invalid fixture string');
  }
  return value;
}
export function positiveInteger(value: JsonInput): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError('invalid fixture integer');
  }
  return value;
}
export function identityField(value: JsonInput): { pid: number; start: string } {
  if (!isJsonObject(value)) {
    throw new TypeError('invalid fixture process identity');
  }
  return { pid: positiveInteger(value.pid), start: textField(value.start) };
}
function strings(value: JsonInput): string[] {
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === 'string')) {
    throw new TypeError('invalid fixture string list');
  }
  return value;
}
export function isolationInput(text: string): IsolationInput {
  const value = readObject(text);
  const processes = value.protectedProcesses;
  if (
    processes !== undefined &&
    (!Array.isArray(processes) ||
      !processes.every(
        (item) => typeof item === 'number' && Number.isSafeInteger(item) && item > 0,
      ))
  ) {
    throw new TypeError('invalid fixture process list');
  }
  const port = positiveInteger(value.port);
  if (port >= 65_536) {
    throw new TypeError('invalid fixture port');
  }
  return {
    expectedUid: positiveInteger(value.expectedUid),
    protectedFiles: strings(value.protectedFiles),
    readOnlyDirectories: strings(value.readOnlyDirectories),
    parentPid: positiveInteger(value.parentPid),
    port,
    env: process.env,
    ...(value.parentPidNamespace === undefined
      ? {}
      : { parentPidNamespace: textField(value.parentPidNamespace) }),
    ...(value.readOnlyFiles === undefined ? {} : { readOnlyFiles: strings(value.readOnlyFiles) }),
    ...(value.protectedSockets === undefined
      ? {}
      : { protectedSockets: strings(value.protectedSockets) }),
    ...(processes === undefined
      ? {}
      : { protectedProcesses: processes.map((item) => positiveInteger(item)) }),
  };
}
