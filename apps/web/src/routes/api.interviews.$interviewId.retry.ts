import { createFileRoute } from '@tanstack/react-router';
import { retry } from '../server/interview-runtime';
export const Route = createFileRoute('/api/interviews/$interviewId/retry')({
  server: { handlers: { POST: ({ request, params }) => retry(request, params.interviewId) } },
});
