import { createFileRoute } from '@tanstack/react-router';
import { analyze } from '../server/interview-runtime';
export const Route = createFileRoute('/api/materials/analyze')({
  server: { handlers: { POST: ({ request }) => analyze(request) } },
});
