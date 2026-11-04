import { createFileRoute } from '@tanstack/react-router';
import { validateJobNotification } from '@korekaite/api-contracts/messages/validators';

export const Route = createFileRoute('/api/queue-contract-topology')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const body = await request.json();
        return Response.json({ body, valid: validateJobNotification(body) });
      },
    },
  },
});
