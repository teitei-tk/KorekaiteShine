import { createFileRoute } from '@tanstack/react-router';
import { env } from 'cloudflare:workers';
import { validateJobNotification } from '@korekaite/api-contracts/messages/validators';

export const Route = createFileRoute('/api/formal-queue-test')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (env.APP_ENV !== 'test') {
          return new Response(null, { status: 404 });
        }
        const query = new URL(request.url).searchParams;
        const jobId = query.get('jobId');
        if (!validateJobNotification({ schemaVersion: 1, jobId })) {
          return new Response(null, { status: 400 });
        }
        return Response.json(
          query.get('view') === 'dlq'
            ? await env.EVALUATION_PROBE.readFormalDlq(jobId)
            : await env.EVALUATION_PROBE.readFormalJob(jobId),
        );
      },
      POST: async ({ request }) => {
        if (env.APP_ENV !== 'test') {
          return new Response(null, { status: 404 });
        }
        const query = new URL(request.url).searchParams;
        const source = query.get('source');
        const dlq = source === 'evaluation' && query.get('kind') === 'dlq';
        if (!dlq && ((source !== 'web' && source !== 'interview') || query.has('kind'))) {
          return new Response(null, { status: 400 });
        }
        const body = await request.json();
        if (!validateJobNotification(body)) {
          return new Response(null, { status: 400 });
        }
        if (dlq) {
          await env.EVALUATION_PROBE.enqueueFormalDlqForTest(body);
        } else if (source === 'interview') {
          await env.INTERVIEW.getByName(
            `${env.APP_ENV}:formal-test:${body.jobId}`,
          ).enqueueFormalForTest(body);
        } else {
          await env.EVALUATION_QUEUE.send(body);
        }
        return Response.json({ enqueued: true }, { status: 202 });
      },
    },
  },
});
