import { createFileRoute } from '@tanstack/react-router';
import { db, eq } from 'void/db';
import { connectionChecks } from '@korekaite/database';

export const Route = createFileRoute('/api/batch-topology')({
  server: {
    handlers: {
      GET: async () => {
        let rejected = false;
        try {
          await db.batch([
            db.insert(connectionChecks).values({ writer: 'atomic', value: 'first' }),
            db.insert(connectionChecks).values({ writer: 'atomic', value: 'duplicate' }),
          ]);
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !String(error.cause ?? error).includes('UNIQUE constraint failed')
          ) {
            throw error;
          }
          rejected = true;
        }
        const rows = await db
          .select()
          .from(connectionChecks)
          .where(eq(connectionChecks.writer, 'atomic'));
        return Response.json({ rejected, rows });
      },
    },
  },
});
