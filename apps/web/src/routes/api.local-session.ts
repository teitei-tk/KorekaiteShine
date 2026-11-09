import { createFileRoute } from '@tanstack/react-router';
import { bootstrap } from '../server/interview-runtime';
export const Route = createFileRoute('/api/local-session')({
  server: { handlers: { GET: ({ request }) => bootstrap(request) } },
});
