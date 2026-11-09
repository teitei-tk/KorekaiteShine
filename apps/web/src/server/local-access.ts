const cookieName = 'korekaite-local-session';

type Operation = 'read' | 'write' | 'websocket';

export function createLocalAccess(environment: string, token: string) {
  if (!/^[a-f0-9]{64}$/u.test(token)) {
    throw new Error('ローカル操作トークンが不正です。');
  }
  function local(request: Request): boolean {
    if (environment !== 'development' && environment !== 'test') {
      return false;
    }
    const url = new URL(request.url);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    ) {
      return false;
    }
    const host = request.headers.get('Host');
    if (host !== null && host.toLowerCase() !== url.host) {
      return false;
    }
    const origin = request.headers.get('Origin');
    if (origin !== null && origin !== url.origin) {
      return false;
    }
    const site = request.headers.get('Sec-Fetch-Site');
    return site === null || site === 'same-origin' || site === 'none';
  }
  return {
    operationToken: token,
    canBootstrap: (request: Request) => request.method === 'GET' && local(request),
    cookie: (request: Request) =>
      `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`,
    actor(request: Request, operation: Operation): string | null {
      if (!local(request)) {
        return null;
      }
      const values = (request.headers.get('Cookie') ?? '')
        .split(';')
        .map((part) => part.trim())
        .filter((part) => part.startsWith(`${cookieName}=`));
      if (values.length !== 1 || values[0] !== `${cookieName}=${token}`) {
        return null;
      }
      if (operation === 'read') {
        return ['GET', 'HEAD'].includes(request.method) ? 'local-developer' : null;
      }
      if (request.headers.get('Origin') !== new URL(request.url).origin) {
        return null;
      }
      if (operation === 'websocket') {
        return request.method === 'GET' &&
          request.headers.get('Upgrade')?.toLowerCase() === 'websocket'
          ? 'local-developer'
          : null;
      }
      return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) &&
        request.headers.get('X-Interview-Token') === token
        ? 'local-developer'
        : null;
    },
  };
}

// 起動中のメモリだけに保持し、再起動時は画面がbootstrapを取り直す。
let token: string | undefined;
export function localAccess(environment: string) {
  token ??= crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
  return createLocalAccess(environment, token);
}
