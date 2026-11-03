import { createFileRoute } from '@tanstack/react-router';
import { env } from 'cloudflare:workers';

export const Route = createFileRoute('/api/isolation-test')({
  server: {
    handlers: {
      GET: async () => {
        if (env.APP_ENV !== 'test') return new Response(null, { status: 404 });
        return Response.json(await env.INTERVIEW.getByName('test:isolation').readIsolationMarker());
      },
      POST: async ({ request }) => {
        if (env.APP_ENV !== 'test') return new Response(null, { status: 404 });
        const body = await request.json();
        await env.INTERVIEW.getByName('test:isolation').writeIsolationMarker(body.marker);
        return Response.json({ saved: true });
      },
    },
  },
});
