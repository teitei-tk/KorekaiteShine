import { createFileRoute } from '@tanstack/react-router';
import { live } from '../server/interview-runtime';
export const Route = createFileRoute('/api/interviews/$interviewId/live')({
  server: { handlers: { GET: ({ request, params }) => live(request, params.interviewId) } },
});
