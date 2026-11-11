import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startProvider } from './runtime-provider.mjs';

// ランナーの生成物・開発用認証・DO・D1はシナリオごとに破棄する。
export async function startVoiceRuntime({ profile }) {
  if (!['pr', 'live'].includes(profile) || !process.env.E2E_APP_ROOT) {
    throw new Error('実行プロファイルと E2E_APP_ROOT が必要です。');
  }
  const source = resolve(process.env.E2E_APP_ROOT);
  const root = await mkdtemp(join(tmpdir(), 'voice-e2e-'));
  const local = join(root, 'tools/local-integration');
  let provider;
  let runtime;
  async function stop() {
    try {
      await runtime?.stop();
    } finally {
      try {
        await provider?.stop();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  }
  try {
    await mkdir(local, { recursive: true });
    for (const name of ['src', 'fixtures']) {
      await cp(join(source, 'tools/local-integration', name), join(local, name), {
        recursive: true,
      });
    }
    for (const name of ['apps', 'packages', 'node_modules']) {
      await symlink(join(source, name), join(root, name), 'dir');
    }
    await symlink(
      join(source, 'tools/local-integration/node_modules'),
      join(local, 'node_modules'),
      'dir',
    );
    await cp(join(source, 'tools/local-integration/package.json'), join(local, 'package.json'));
    const runtimePath = join(local, 'src/runtime.ts');
    let options = {};
    if (profile === 'pr') {
      provider = await startProvider();
      const fixture = join(local, 'fixtures/voice-interview.ts');
      const dial = `import { InterviewObject } from '../../../apps/interview/src/server/interview-object';
import { createLiveConnection, dialLiveSocket } from '../../../apps/interview/src/server/live-connection';
export class MockInterviewObject extends InterviewObject {
  protected override connectLive(options, handlers) {
    if (this.env.APP_ENV !== 'test') throw new Error('テスト専用です。');
    return createLiveConnection(options, { ...handlers, dial: (key, signal) =>
      dialLiveSocket(key, signal, (_url, init) => fetch(${JSON.stringify(provider.url)}, init)) });
  }
}
`;
      await writeFile(fixture, dial);
      options = {
        materialAnalysisMock: true,
        interviewVoiceMock: true,
        interviewEvaluationMock: true,
        testAiBindings: {
          OPENAI_API_KEY: 'fixture-e2e',
          RESPONSES_MODEL: 'fixture',
          EVALUATION_MODEL: 'fixture',
        },
      };
    }
    const { resolveRuntime } = await import(
      pathToFileURL(join(source, 'packages/runtime-config/src/resources.ts'))
    );
    const { startRuntime } = await import(pathToFileURL(runtimePath));
    const config = resolveRuntime({
      repositoryRoot: root,
      appEnv: profile === 'pr' ? 'test' : 'development',
      runId: crypto.randomUUID(),
      parallelIndex: 0,
    });
    runtime = await startRuntime(config, 'dev', options);
    const url = runtime.baseUrl;
    return {
      url,
      extendNextOpening() {
        provider.extendNextOpening();
      },
      holdNextQuestion() {
        return provider.holdNextQuestion();
      },
      omitNextOpening() {
        provider.omitNextOpening();
      },
      muteReplies() {
        provider.muteReplies();
      },
      silenceCurrentConnections() {
        provider.silenceCurrentConnections();
      },
      async rejectDials(value) {
        if (!provider) {
          throw new Error('接続拒否はPRプロファイル専用です。');
        }
        provider.rejectDials(value);
      },
      async restart() {
        await runtime.stop();
        runtime = await startRuntime(config, 'dev', {
          ...options,
          port: Number(new URL(url).port),
        });
      },
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
