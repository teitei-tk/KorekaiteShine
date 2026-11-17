import type { D1Database } from '@cloudflare/workers-types';
import { createDb } from 'void/db';

/** ジョブの不在判定・実行権判断はprimaryから始まる新しいセッションで行う。 */
export function createPrimaryDb(binding: D1Database): ReturnType<typeof createDb> {
  // Void 1.4.0の公開createDbはfirst-unconstrained固定のため、binding境界で上書きする。
  // 接続済みインスタンスを共有せず、呼び出しごとに独立したセッションを作る。
  return createDb(
    new Proxy(binding, {
      get(target, property, receiver) {
        if (property === 'withSession') {
          return () => target.withSession('first-primary');
        }
        return Reflect.get(target, property, receiver);
      },
    }),
  );
}
