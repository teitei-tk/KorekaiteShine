import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { onTestFinished } from 'vitest';

// CI・コンテナの実行UIDに依存せず、Linuxの非特権プロセスを再現する。
export const unprivilegedLinux = `
Object.defineProperty(process, 'platform', { value: 'linux' });
process.getuid = () => 1000;
`;

/** ghとfetchの応答だけを制御し、元ソースのCLI入口を実Nodeで実行する。 */
export function cliFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'ai-review-cli-'));
  onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  const responsePath = join(directory, 'responses.json');
  const requestsPath = join(directory, 'requests.jsonl');
  writeFileSync(requestsPath, '');
  writeFileSync(
    join(directory, 'gh'),
    `#!${process.execPath}
import { readFileSync, appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.FIXTURE_REQUESTS, JSON.stringify(args) + '\\n');
const replies = JSON.parse(readFileSync(process.env.FIXTURE_RESPONSES, 'utf8'));
const key = args[0] === 'variable' ? 'variables' : args[0] === 'run' ? 'run' : args[1];
if (!(key in replies)) { process.stderr.write('private fixture failure'); process.exit(3); }
process.stdout.write(JSON.stringify(replies[key]));
`,
    { mode: 0o755 },
  );
  const preload = join(directory, 'fetch.mjs');
  writeFileSync(
    preload,
    `import { readFileSync, appendFileSync } from 'node:fs';
const counts = new Map();
globalThis.fetch = async (url, options) => {
  appendFileSync(process.env.FIXTURE_REQUESTS, JSON.stringify({ url: String(url), method: options?.method ?? 'GET' }) + '\\n');
  const replies = JSON.parse(readFileSync(process.env.FIXTURE_RESPONSES, 'utf8'));
  const key = String(url);
  const candidates = replies.http?.[key] ?? replies.fetch;
  const index = counts.get(key) ?? 0;
  counts.set(key, index + 1);
  const reply = Array.isArray(candidates) ? candidates[index] : candidates;
  if (!reply) { throw new Error('private fixture network failure'); }
  return Response.json(reply.body, { status: reply.status ?? 200 });
};
`,
  );
  writeFileSync(
    join(directory, 'git'),
    `#!${process.execPath}
import { readFileSync, appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(requestsPath)}, JSON.stringify({ git: args }) + '\\n');
const replies = JSON.parse(readFileSync(${JSON.stringify(responsePath)}, 'utf8'));
const command = ['init', 'fetch', 'checkout', 'merge-base', 'diff'].find((value) => args.includes(value));
const key = args.includes('--name-only') ? 'names' : command;
if (!replies.git || !(key in replies.git)) { process.stderr.write('private fixture git failure'); process.exit(3); }
process.stdout.write(replies.git[key]);
`,
    { mode: 0o755 },
  );
  function run(
    file: string,
    input: {
      args?: string[];
      env?: NodeJS.ProcessEnv;
      replies?: object;
      bootstrap?: string;
    } = {},
  ) {
    writeFileSync(responsePath, JSON.stringify(input.replies ?? {}));
    const bootstrap = join(directory, 'bootstrap.mjs');
    writeFileSync(bootstrap, input.bootstrap ?? '');
    return spawnSync(
      process.execPath,
      [
        '--import',
        preload,
        '--import',
        bootstrap,
        fileURLToPath(new URL(`../../${file}`, import.meta.url)),
        ...(input.args ?? []),
      ],
      {
        encoding: 'utf8',
        timeout: 10_000,
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          FIXTURE_RESPONSES: responsePath,
          FIXTURE_REQUESTS: requestsPath,
          ...input.env,
        },
      },
    );
  }
  return {
    directory,
    run,
    requests: () =>
      readFileSync(requestsPath, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
  };
}
