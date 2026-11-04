import { createFileRoute } from '@tanstack/react-router';
import { env } from 'cloudflare:workers';

export const Route = createFileRoute('/api/check-object-test')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const query = new URL(request.url).searchParams;
        if (query.get('view') === 'initialization') {
          const object = env.CHECK_OBJECT.getByName(
            `${env.APP_ENV}:diagnostics:${query.get('objectId')}`,
          );
          return Response.json(await object.readInitializationForTest());
        }
        if (query.get('view') === 'ack-stop') {
          return Response.json(await env.EVALUATION_PROBE.readAckStopHistory(query.get('jobId')));
        }
        if (query.get('view') === 'dispatch') {
          return Response.json(await env.EVALUATION_PROBE.readDispatchState(query.get('jobId')));
        }
        if (query.get('view') === 'persistence') {
          return Response.json(
            await env.EVALUATION_PROBE.readInitializationPersistence(query.get('jobId')),
          );
        }
        if (query.get('view') === 'acceptance-counts') {
          return Response.json(await env.EVALUATION_PROBE.readAcceptanceCounts());
        }
        return Response.json(
          query.get('view') === 'attempts'
            ? await env.EVALUATION_PROBE.readJobAttempts(query.get('jobId'))
            : await env.EVALUATION_PROBE.readQueueReceipt(query.get('jobId')),
        );
      },
      POST: async ({ request }) => {
        const body = await request.json();
        const object = env.CHECK_OBJECT.getByName(
          `${env.APP_ENV}:diagnostics:${body.objectId ?? body.jobId}`,
        );
        try {
          return Response.json(await object.initializeCheck(body.jobId));
        } catch (error) {
          return Response.json(
            { error: error instanceof Error ? error.message : 'non_error' },
            { status: 500 },
          );
        }
      },
    },
  },
});
