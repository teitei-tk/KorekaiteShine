import type { components } from '@korekaite/api-contracts/http';
import { validateApplicationError } from '@korekaite/api-contracts/http/application-validators';

type Code = components['schemas']['ApplicationError']['error']['code'];
const errors: Record<Code, readonly [number, string]> = {
  FORBIDDEN: [403, 'この要求は許可されていません。'],
  NOT_FOUND: [404, '面接が見つかりません。'],
  CONFLICT: [409, '現在の状態では操作できません。記録を更新してください。'],
  INVALID_REQUEST: [400, '要求の内容を確認してください。'],
  UNAVAILABLE: [503, '記録を取得できませんでした。再度お試しください。'],
};
export function applicationFailure(code: Code): Response {
  const [status, message] = errors[code];
  const body = { error: { code, message } };
  if (!validateApplicationError(body)) {
    throw new Error('アプリケーションエラー契約が不正です。');
  }
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}
