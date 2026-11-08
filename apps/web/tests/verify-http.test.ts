import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { listInterviews } from '../src/server/interviews.ts';

const script = fileURLToPath(new URL('../scripts/verify-http.ts', import.meta.url));
async function run(args: string[], preload?: string) {
  const child = spawn(
    process.execPath,
    [...(preload ? ['--import', preload] : []), script, ...args],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10000,
    },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  return { code, stdout, stderr };
}

async function serve(page = '面接一覧') {
  const server = createServer((request, response) => {
    const url = new URL(request.url!, 'http://localhost');
    const result =
      url.pathname === '/api/interviews' ? listInterviews(new Request(url)) : new Response(page);
    response.writeHead(result.status, Object.fromEntries(result.headers));
    void result.text().then((body) => response.end(body));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('HTTP確認用のポートが取得できません');
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

test('HTTP確認CLIが指定URLの一覧順序・全クエリ契約・HTMLを確認して成功する', async () => {
  const server = await serve();
  try {
    const result = await run([server.url]);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('HTTP検証成功: 契約');
    expect(result.stdout).toContain('一覧順序・HTML応答');
  } finally {
    await server.close();
  }
}, 15000);

test('HTTP確認CLIはHTMLが契約と異なる場合に成功表示せず失敗終了する', async () => {
  const server = await serve('別のページ');
  try {
    const result = await run([server.url]);
    expect(result.code).toBe(1);
    expect(result.stdout).not.toContain('HTTP検証成功');
    expect(result.stderr).toContain('ERR_ASSERTION');
    expect(result.stderr).toContain('面接一覧');
  } finally {
    await server.close();
  }
}, 15000);

test('HTTP確認CLIはURL省略時に既定のローカル接続先を使う', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'verify-http-default-'));
  try {
    const preload = join(directory, 'fetch.mjs');
    const handler = new URL('../src/server/interviews.ts', import.meta.url).href;
    await writeFile(
      preload,
      `import assert from 'node:assert/strict';
import { listInterviews } from ${JSON.stringify(handler)};
globalThis.fetch = async (input) => {
  const request = new Request(input);
  const url = new URL(request.url);
  assert.equal(url.origin, 'http://127.0.0.1:4327');
  return url.pathname === '/api/interviews' ? listInterviews(request) : new Response('面接一覧');
};
`,
    );
    const result = await run([], preload);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('HTTP検証成功');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 15000);
