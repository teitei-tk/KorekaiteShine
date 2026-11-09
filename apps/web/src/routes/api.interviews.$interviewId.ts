import { createFileRoute } from '@tanstack/react-router';
import { detail, removeInterview } from '../server/interview-runtime';
export const Route = createFileRoute('/api/interviews/$interviewId')({
  server: {
    handlers: {
      GET: ({ request, params }) => detail(request, params.interviewId),
      DELETE: ({ request, params }) => removeInterview(request, params.interviewId),
    },
  },
});
