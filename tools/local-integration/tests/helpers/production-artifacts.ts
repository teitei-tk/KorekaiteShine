import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { onTestFinished } from 'vitest';
import { resolveRuntime } from '@korekaite/runtime-config';
import type { BuildAudit } from '../../src/build-audit.ts';

export async function productionFixture() {
  const project = await realpath(await mkdtemp(join(tmpdir(), 'production-audit-')));
  onTestFinished(() => rm(project, { recursive: true, force: true }));
  const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));
  const production = resolveRuntime({ repositoryRoot, appEnv: 'production' });
  const content = 'export default {};';
  const audits: Record<string, BuildAudit> = {};
  const configs: Record<
    string,
    {
      name: string;
      workersDev: boolean;
      previewUrls: boolean;
      env: Record<
        string,
        {
          type: string;
          value?: string;
          id?: string;
          name?: string;
          worker?: string;
          exportName?: string;
        }
      >;
      triggers?: { type: string; name: string; deadLetterQueue?: string }[];
    }
  > = {};
  const configPaths: Record<string, string> = {};
  await mkdir(join(project, 'build-audit'));
  for (const environment of ['client', 'ssr', 'interview', 'evaluation'] as const) {
    const worker = environment === 'client' || environment === 'ssr' ? 'web' : environment;
    const directory = join(
      project,
      '.cloudflare/output/v0/workers',
      worker === 'web' ? 'default' : production.workers[worker],
    );
    const outputDirectory = join(directory, environment === 'client' ? 'assets' : 'bundle');
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(join(outputDirectory, 'index.js'), content);
    audits[environment] = {
      environment,
      outputDirectory,
      modules: [
        {
          id: join(repositoryRoot, `apps/${worker}/src/worker.ts`),
          imports: [],
          dynamicImports: [],
          isEntry: true,
        },
      ],
      outputs: [
        {
          fileName: 'index.js',
          sha256: createHash('sha256').update(content).digest('hex'),
          modules: [],
        },
      ],
    };
    if (environment !== 'client') {
      configPaths[environment] = join(directory, 'worker.config.json');
      configs[environment] = {
        name: production.workers[worker],
        workersDev: false,
        previewUrls: false,
        env: {
          APP_ENV: { type: 'text', value: 'production' },
          DB: { type: 'd1', id: production.d1.id },
        },
      };
    }
  }
  configs.interview.env.INTERVIEW_SESSION = {
    type: 'durable-object',
    worker: production.workers.interview,
    exportName: 'InterviewObject',
  };
  const routes = [
    '__root.tsx',
    'api.interview-history.ts',
    'api.interviews.$interviewId.live.ts',
    'api.interviews.$interviewId.retry.ts',
    'api.interviews.$interviewId.ts',
    'api.interviews.ts',
    'api.local-session.ts',
    'api.materials.analyze.ts',
    'index.tsx',
    'practice.tsx',
  ];
  await mkdir(join(project, 'src/routes'), { recursive: true });
  for (const route of routes) {
    await writeFile(join(project, 'src/routes', route), '');
  }
  await writeFile(
    join(project, 'src/routeTree.gen.ts'),
    routes.map((route) => `import './routes/${route.replace(/\.tsx?$/u, '')}'`).join('\n'),
  );
  const save = async () => {
    for (const [name, audit] of Object.entries(audits)) {
      await writeFile(join(project, 'build-audit', `${name}.json`), JSON.stringify(audit));
    }
    for (const [name, config] of Object.entries(configs)) {
      await writeFile(configPaths[name], JSON.stringify(config));
    }
  };
  await save();
  return { project, routes, audits, configs, save, production };
}
