import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { expect, test } from 'vitest';
import { readWorkerCoverage } from '../src/worker.ts';
import { instrumentSource } from '../src/instrument.ts';
import { createMergeFixture } from './fixtures/measurement.ts';

test('WorkerのInspectorから停止前の実行回数を回収する', async () => {
  const { target, path } = createMergeFixture();
  const source = target.coverage.inputSourceMap!.sourcesContent![0]!;
  const { code } = instrumentSource(path, source);
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: 'coverage-worker',
          modules: true,
          compatibilityDate: '2026-10-19',
          script: code + '\nexport default {fetch(){choose(false);return new Response("ok");}}',
        },
      ],
      inspectorPort: 0,
    }),
  );
  try {
    await mf.dispatchFetch('http://localhost');
    const url = await mf.getInspectorURL();
    url.protocol = 'http:';
    const endpoints = (await (await fetch(new URL('/json/list', url))).json()) as {
      id: string;
      webSocketDebuggerUrl: string;
    }[];
    const data = await readWorkerCoverage(
      endpoints.find((entry) => entry.id.includes('coverage-worker'))!.webSocketDebuggerUrl,
    );
    expect(data[path].fnMap).toEqual(target.coverage.fnMap);
    expect(data[path].f['0']).toBe(1);
    expect(data[path].b['0']).toEqual([0, 1]);
  } finally {
    await mf.dispose();
  }
});

test('Worker再生成で失われたカウンターを完了扱いしない', async () => {
  const options = (text: string) =>
    convertV4MiniflareOptions({
      workers: [
        {
          name: 'epoch-worker',
          modules: true,
          compatibilityDate: '2026-10-19',
          script: `export default {fetch(){return new Response(${JSON.stringify(text)});}}`,
        },
      ],
      inspectorPort: 0,
    });
  const mf = new Miniflare(options('before'));
  const endpoint = async () => {
    await mf.ready;
    const url = await mf.getInspectorURL();
    url.protocol = 'http:';
    const entries = (await (await fetch(new URL('/json/list', url))).json()) as {
      id: string;
      webSocketDebuggerUrl: string;
    }[];
    return entries.find((entry) => entry.id === 'core:user:epoch-worker')!.webSocketDebuggerUrl;
  };
  try {
    await readWorkerCoverage(await endpoint(), { value: 'epoch', start: true });
    await mf.setOptions(options('after'));
    await expect(readWorkerCoverage(await endpoint(), { value: 'epoch' })).rejects.toThrow(
      '再生成',
    );
  } finally {
    await mf.dispose();
  }
});
