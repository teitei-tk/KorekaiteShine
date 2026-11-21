import type { Serializable } from 'node:child_process';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from 'vitest';
import { createFixtures } from '../bombadil/fixtures.ts';
import { requireValue } from '../bombadil/required.ts';
import { readJsonObject } from './bombadil-test-json.ts';
import {
  localProcessEnvironment,
  coverageEnvironment,
} from '../../local-integration/src/local-environment.ts';
import { stopProcessGroup } from '../../local-integration/src/process.ts';

type HostOptions = {
  mode?:
    | 'normal'
    | 'fail-start'
    | 'fail-sql'
    | 'bad-url'
    | 'fail-stop'
    | 'hold-start'
    | 'hold-sql'
    | 'fail-start-after-abort'
    | 'missing-fixture';
  stopAt?: 'ready' | 'starting' | 'seeding';
  stopWith?: 'disconnect' | 'SIGINT' | 'SIGTERM';
};
async function runHost({
  mode = 'normal',
  stopAt = 'ready',
  stopWith = 'disconnect',
}: HostOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'exploration-host-'));
  try {
    const host = new URL('../bombadil/runtime-host.ts', import.meta.url);
    const log = join(directory, 'calls.jsonl');
    const fixturePath = join(directory, 'fixtures.json');
    const fixtures = createFixtures(randomUUID());
    await writeFile(fixturePath, JSON.stringify(fixtures));
    const stub = join(directory, 'runtime.mjs');
    await writeFile(
      stub,
      `import {appendFileSync} from 'node:fs';
const mode=${JSON.stringify(mode)};
const record=value=>appendFileSync(${JSON.stringify(log)},JSON.stringify(value)+'\\n');
const held=signal=>new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
export async function startVoiceRuntime({profile,signal}) {
 record({type:'start',profile,aborted:signal.aborted});
 const starting=(mode==='hold-start'||mode==='fail-start-after-abort')?held(signal):undefined;
 process.send?.({type:'probe',phase:'starting'});
 await starting;
 if(mode==='fail-start'||mode==='fail-start-after-abort')throw new Error('fixture start failure');
 return {url:mode==='bad-url'?42:'http://127.0.0.1:4321',
  executeTestSql:async(sql)=>{
   record({type:'sql',sql});
   const seeding=mode==='hold-sql'?held(signal):undefined;
   process.send?.({type:'probe',phase:'seeding'});
   await seeding;
   if(mode==='fail-sql')throw new Error('fixture SQL failure');
  },
  stop:async()=>{record({type:'stop'});if(mode==='fail-stop')throw new Error('fixture stop failure');}
 };
}
`,
    );
    const hook = join(directory, 'resolve.mjs');
    await writeFile(
      hook,
      `import {registerHooks} from 'node:module';
registerHooks({resolve(specifier,context,next){
 if(context.parentURL===${JSON.stringify(host.href)}&&specifier==='../runtime.mjs')return{url:${JSON.stringify(pathToFileURL(stub).href)},shortCircuit:true};
 return next(specifier,context);
}});
`,
    );
    const child = fork(host, mode === 'missing-fixture' ? [] : [fixturePath], {
      detached: true,
      execArgv: ['--import', hook],
      env: {
        ...localProcessEnvironment(),
        ...coverageEnvironment('test'),
        NODE_OPTIONS: process.env.NODE_OPTIONS ?? '',
      },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    const diagnostics = { text: '', protocolError: '' };
    const messages: ReturnType<typeof readJsonObject>[] = [];
    requireValue(child.stderr).on('data', (chunk: Buffer) => {
      diagnostics.text += chunk.toString();
    });
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code: number | null) => {
        resolve(code);
      });
    });
    child.on('message', (message: Serializable | null) => {
      if (message === null || typeof message !== 'object' || Array.isArray(message)) {
        diagnostics.protocolError = 'IPC通知がオブジェクトではありません。';
        child.kill('SIGKILL');
        return;
      }
      const event = readJsonObject(JSON.stringify(message));
      messages.push(event);
      if (
        (event.type === 'ready' && stopAt === 'ready') ||
        (event.type === 'probe' && event.phase === stopAt)
      ) {
        if (stopWith === 'disconnect') {
          child.disconnect();
        } else {
          child.kill(stopWith);
        }
      }
    });
    const deadline = setTimeout(() => {
      diagnostics.protocolError = 'ホストが期限内に停止しませんでした。';
      child.kill('SIGKILL');
    }, 10_000);
    try {
      const code = await exited;
      const logText = await readFile(log, 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') {
          return '';
        }
        throw error;
      });
      const calls =
        logText === ''
          ? []
          : logText
              .trim()
              .split('\n')
              .map((line) => readJsonObject(line));
      expect(diagnostics.protocolError, diagnostics.text).toBe('');
      return { code, messages, calls, fixtures, stderr: diagnostics.text };
    } finally {
      clearTimeout(deadline);
      await stopProcessGroup(child);
      await exited;
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('実際のIPCホストはfixture投入後に起動を通知し、親の切断時に一度だけ停止する', async () => {
  const result = await runHost();
  expect(result.code, result.stderr).toBe(0);
  expect(result.messages.filter((message) => message.type !== 'probe')).toEqual([
    { type: 'ready', url: 'http://127.0.0.1:4321' },
  ]);
  expect(result.calls.map((call) => call.type)).toEqual(['start', 'sql', 'stop']);
  expect(result.calls[0]).toEqual({ type: 'start', profile: 'pr', aborted: false });
  const { sql } = requireValue(result.calls.find((call) => call.type === 'sql'));
  if (typeof sql !== 'string') {
    throw new TypeError('SQLがありません。');
  }
  for (const fixture of result.fixtures.interviews) {
    expect(sql).toContain(fixture.id);
  }
});

test('IPCホストは起動・投入・停止の失敗と起動途中の中断を区別し、取得したランタイムを一度だけ停止する', async () => {
  const cases: (HostOptions & { code: number; events: string[]; calls: string[] })[] = [
    { mode: 'missing-fixture', code: 1, events: ['error'], calls: [] },
    { mode: 'fail-start', code: 1, events: ['error'], calls: ['start'] },
    { mode: 'fail-sql', code: 1, events: ['error'], calls: ['start', 'sql', 'stop'] },
    { mode: 'bad-url', code: 1, events: ['error'], calls: ['start', 'sql', 'stop'] },
    {
      mode: 'fail-stop',
      stopWith: 'SIGTERM',
      code: 1,
      events: ['ready'],
      calls: ['start', 'sql', 'stop'],
    },
    {
      mode: 'hold-start',
      stopAt: 'starting',
      stopWith: 'SIGINT',
      code: 0,
      events: [],
      calls: ['start', 'stop'],
    },
    {
      mode: 'hold-sql',
      stopAt: 'seeding',
      stopWith: 'SIGTERM',
      code: 0,
      events: [],
      calls: ['start', 'sql', 'stop'],
    },
    { mode: 'fail-start-after-abort', stopAt: 'starting', code: 1, events: [], calls: ['start'] },
  ];
  for (const entry of cases) {
    const result = await runHost(entry);
    expect(result.code, `${entry.mode}: ${result.stderr}`).toBe(entry.code);
    expect(
      result.messages.filter((message) => message.type !== 'probe').map((message) => message.type),
      entry.mode,
    ).toEqual(entry.events);
    expect(
      result.calls.map((call) => call.type),
      entry.mode,
    ).toEqual(entry.calls);
  }
}, 30_000);
