import { createFileRoute } from '@tanstack/react-router';
import { env } from 'cloudflare:workers';

export const Route = createFileRoute('/api/evaluation-test')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const query = new URL(request.url).searchParams;
        if (query.get('transport') === 'queue') {
          return Response.json(
            await env.EVALUATION_PROBE.enqueueForTest(
              await request.json(),
              query.get('kind') === 'dlq' ? 'dlq' : 'normal',
            ),
            { status: 202 },
          );
        }
        const now = query.has('now') ? Number(query.get('now')) : undefined;
        if (now !== undefined && !Number.isSafeInteger(now)) {
          return new Response(null, { status: 400 });
        }
        if (query.get('action') === 'dispatch') {
          if (now === undefined) {
            return new Response(null, { status: 400 });
          }
          return Response.json(
            await env.EVALUATION_PROBE.dispatchForTest(now, query.get('failJobId') ?? undefined),
          );
        }
        return Response.json(
          await env.EVALUATION_PROBE.evaluate(
            await request.json(),
            query.get('hold') === 'true',
            now,
            query.get('messageId') ?? undefined,
            query.get('kind') === 'dlq' ? 'dlq' : 'normal',
            query.get('rejectEvaluation') === 'true',
          ),
        );
      },
    },
  },
});
