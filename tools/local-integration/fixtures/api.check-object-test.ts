import { createFileRoute } from '@tanstack/react-router';
import { env } from 'cloudflare:workers';

export const Route = createFileRoute('/api/check-object-test')({
  server: {
    handlers: {
      GET: async ({ request }) =>
        Response.json(
          await env.EVALUATION_PROBE.readQueueReceipt(
            new URL(request.url).searchParams.get('jobId'),
          ),
        ),
      POST: async ({ request }) => {
        const body = await request.json();
        const object = env.CHECK_OBJECT.getByName(`${env.APP_ENV}:diagnostics:${body.jobId}`);
        return Response.json(await object.initializeCheck(body.jobId));
      },
    },
  },
});
