import { createFileRoute } from '@tanstack/react-router';
import { env } from 'cloudflare:workers';
import { eq } from 'void/db';
import { connectionChecks } from '@korekaite/database';
import { createPrimaryDb } from '@korekaite/database/connection';

export const Route = createFileRoute('/api/primary-topology')({
  server: {
    handlers: {
      GET: async () => {
        const constraints: string[] = [];
        // 実bindingに渡る制約を観測する。セッションやDB実行は置き換えない。
        const observed = new Proxy(env.DB, {
          get(target, property, receiver) {
            if (property === 'withSession') {
              return (constraint: string) => {
                constraints.push(constraint);
                return target.withSession(constraint);
              };
            }
            return Reflect.get(target, property, receiver);
          },
        });
        const db = createPrimaryDb(observed);
        await db.insert(connectionChecks).values({ writer: 'primary', value: 'saved' });
        const rows = await db
          .select()
          .from(connectionChecks)
          .where(eq(connectionChecks.writer, 'primary'));
        return Response.json({ constraints, rows });
      },
    },
  },
});
