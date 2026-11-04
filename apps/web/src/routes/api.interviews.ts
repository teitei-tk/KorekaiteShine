import { createFileRoute } from '@tanstack/react-router';
import { listInterviews } from '../server/interviews';

export const Route = createFileRoute('/api/interviews')({
  server: { handlers: { GET: ({ request }) => listInterviews(request) } },
});
