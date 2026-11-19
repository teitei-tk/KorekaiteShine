import type { Plugin, PluginOption } from 'vite';
export type ViteSpan = { name: string; hook: string; category: string; start: number; end: number };
export type ViteSummary = {
  totalMs: number;
  pluginOnlyMs: number;
  workerOnlyMs: number;
  moduleOnlyMs: number;
  workerAndModuleMs: number;
  otherMs: number;
  hooks: {
    name: string;
    hook: string;
    category: string;
    count: number;
    inclusiveMs: number;
    maxMs: number;
  }[];
};
export function summarizeViteSpans(spans: ViteSpan[], start: number, end: number): ViteSummary;
export function createViteProfiler(): {
  instrument: <T extends { name: string }>(plugin: T) => T;
  instrumentEnvironment: (environment: { name: string; plugins: { name: string }[] }) => void;
  plugin: Plugin;
  snapshot: (start: number, end: number) => ViteSummary & { dropped: number; pending: number };
  stop: () => void;
};
export function profileVitePlugins(
  options: PluginOption[],
  outputPath: string,
): Promise<PluginOption[]>;
