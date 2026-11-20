import { createServer } from 'node:http';
import { appendFileSync, readFileSync } from 'node:fs';
import { isRecord, parseJson } from '../../src/json.ts';

const input = parseJson(readFileSync(process.argv[2], 'utf8'));
if (
  !isRecord(input) ||
  typeof input.name !== 'string' ||
  typeof input.tarball !== 'string' ||
  typeof input.integrity !== 'string' ||
  typeof input.mode !== 'string' ||
  typeof input.requests !== 'string' ||
  typeof input.published !== 'string'
) {
  throw new TypeError('registry fixture設定が不正です。');
}
const config = {
  name: input.name,
  tarball: input.tarball,
  integrity: input.integrity,
  mode: input.mode,
  requests: input.requests,
  published: input.published,
};
const server = createServer((request, response) => {
  const mode = readFileSync(config.mode, 'utf8');
  const path = request.url ?? '/';
  appendFileSync(config.requests, `${JSON.stringify({ mode, path })}\n`);
  if (mode === 'deny') {
    response.writeHead(403, { 'Content-Type': 'application/json' });
    response.end('{"error":"fixture registry denied"}');
    return;
  }
  if (path.startsWith(`/${config.name}/-/`)) {
    response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    response.end(readFileSync(config.tarball));
    return;
  }
  if (path === `/${config.name}`) {
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new TypeError('registry fixture addressが不正です。');
    }
    const { published } = config;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify({
        name: config.name,
        'dist-tags': { latest: '1.0.0' },
        versions: {
          '1.0.0': {
            name: config.name,
            version: '1.0.0',
            dist: {
              tarball: `http://127.0.0.1:${address.port}/${config.name}/-/fixture.tgz`,
              integrity: config.integrity,
            },
          },
        },
        time: { created: config.published, modified: published, '1.0.0': published },
      }),
    );
    return;
  }
  response.writeHead(404);
  response.end('{}');
});
server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (address !== null && typeof address !== 'string') {
    console.log(`http://127.0.0.1:${address.port}`);
  }
});
