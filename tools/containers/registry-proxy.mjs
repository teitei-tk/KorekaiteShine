// すべての要求を匿名Guardに送り、Guardが指定した配布先だけを追跡する。
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const guard = 'https://npm.flatt.tech';
const distribution = 'https://registry.npmjs.org';
const statusWithLocation = new Set([301, 302, 303, 307, 308]);

async function fetchThroughGuard(url, options) {
  const upstream = await fetch(url, options);
  if (statusWithLocation.has(upstream.status)) {
    const target = new URL(upstream.headers.get('location'), url);
    await upstream.body?.cancel();
    if (target.origin !== distribution || target.username || target.password) {
      throw new Error('許可外の配布先です');
    }
    return fetch(target, options);
  }
  return upstream;
}

async function serve(request, response) {
  const url = new URL(request.url, guard);
  if (request.method !== 'GET' || url.origin !== guard) {
    response.writeHead(403).end();
    return;
  }
  const options = { redirect: 'manual', headers: { accept: request.headers.accept ?? '*/*' } };
  const upstream = await fetchThroughGuard(url, options);
  if (statusWithLocation.has(upstream.status)) {
    await upstream.body?.cancel();
    response.writeHead(502).end();
    return;
  }
  const format = upstream.headers.get('content-type') ?? 'application/octet-stream';
  response.writeHead(upstream.status, { 'content-type': format });
  if (upstream.body) {
    await pipeline(Readable.fromWeb(upstream.body), response);
  } else {
    response.end();
  }
}
createServer((request, response) => {
  serve(request, response).catch(() => {
    if (response.headersSent) {
      response.destroy();
    } else {
      response.writeHead(502).end();
    }
  });
}).listen(3128, '0.0.0.0');
