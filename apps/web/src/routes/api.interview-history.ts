import { createFileRoute } from '@tanstack/react-router';
import { history } from '../server/interview-runtime';
export const Route = createFileRoute('/api/interview-history')({
  server: { handlers: { GET: ({ request }) => history(request) } },
});
