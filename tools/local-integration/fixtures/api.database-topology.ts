import { createFileRoute } from '@tanstack/react-router';
import { env } from 'cloudflare:workers';
import { db, asc } from 'void/db';
import { connectionChecks } from '@korekaite/database';

export const Route = createFileRoute('/api/database-topology')({
  server: {
    handlers: {
      GET: async () => {
        await db
          .insert(connectionChecks)
          .values({ writer: 'web', value: 'shared' })
          .onConflictDoNothing();
        await env.INTERVIEW.getByName('diagnostics:topology').writeShared();
        await env.EVALUATION_PROBE.writeShared();
        return Response.json(
          await db.select().from(connectionChecks).orderBy(asc(connectionChecks.writer)),
        );
      },
    },
  },
});
