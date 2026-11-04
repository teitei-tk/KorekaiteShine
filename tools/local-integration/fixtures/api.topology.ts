import { createFileRoute } from '@tanstack/react-router';
import { env } from 'cloudflare:workers';

export const Route = createFileRoute('/api/topology')({
  server: {
    handlers: {
      GET: async () => Response.json(await env.INTERVIEW.getByName('diagnostics:topology').probe()),
    },
  },
});
