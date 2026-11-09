import { createFileRoute } from '@tanstack/react-router';
import { start } from '../server/interview-runtime';
import { listInterviews } from '../server/interviews';

export const Route = createFileRoute('/api/interviews')({
  server: {
    handlers: {
      GET: ({ request }) => listInterviews(request),
      POST: ({ request }) => start(request),
    },
  },
});
