import {
  validateApplicationError,
  validateLocalSession,
} from '@korekaite/api-contracts/http/application-validators';
import type { createLocalAccess } from './local-access';

export function localSessionRequest(
  request: Request,
  access: ReturnType<typeof createLocalAccess>,
): Response {
  if (!access.canBootstrap(request)) {
    const body = { error: { code: 'FORBIDDEN', message: 'この要求は許可されていません。' } };
    if (!validateApplicationError(body)) {
      throw new Error('アクセスエラー契約が不正です。');
    }
    return Response.json(body, { status: 403, headers: { 'Cache-Control': 'no-store' } });
  }
  const body = { operationToken: access.operationToken };
  if (!validateLocalSession(body)) {
    throw new Error('ローカルセッション契約が不正です。');
  }
  return Response.json(body, {
    headers: { 'Cache-Control': 'no-store', 'Set-Cookie': access.cookie(request) },
  });
}
