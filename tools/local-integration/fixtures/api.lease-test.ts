import { createFileRoute } from '@tanstack/react-router';
import { env } from 'cloudflare:workers';

export const Route = createFileRoute('/api/lease-test')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const body = await request.json();
        if (!Number.isSafeInteger(body.now)) return new Response(null, { status: 400 });
        switch (body.operation) {
          case 'acquire':
            return Response.json(
              await env.EVALUATION_PROBE.acquireForTest(body.notification, body.now),
            );
          case 'recover':
            return Response.json(
              await env.EVALUATION_PROBE.recoverForTest(body.notification, body.now),
            );
          case 'renew':
            return Response.json(await env.EVALUATION_PROBE.renewForTest(body.lease, body.now));
          case 'complete':
            return Response.json(await env.EVALUATION_PROBE.completeForTest(body.lease, body.now));
          default:
            return new Response(null, { status: 400 });
        }
      },
    },
  },
});
