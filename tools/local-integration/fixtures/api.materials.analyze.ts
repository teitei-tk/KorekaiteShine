import { createFileRoute } from '@tanstack/react-router';
import { env } from 'cloudflare:workers';
import { Temporal } from '@js-temporal/polyfill';
import { createPrimaryDb } from '@korekaite/database/connection';
import { analyzeStoredMaterialRequest } from '../server/stored-materials';
import { localAccess } from '../server/local-access';

export const Route = createFileRoute('/api/materials/analyze')({
  server: {
    handlers: {
      POST: ({ request }) => {
        if (env.APP_ENV !== 'test') {
          return new Response(null, { status: 404 });
        }
        return analyzeStoredMaterialRequest(request, {
          db: createPrimaryDb(env.DB),
          actor: (incoming) => localAccess(env.APP_ENV).actor(incoming, 'write'),
          now: () => Temporal.Now.instant().epochMilliseconds,
          newId: () => crypto.randomUUID(),
          apiKey: 'fixture',
          model: 'mock',
          analyze: async () => ({
            themes: [{ title: '構成', heading: '本文', excerpt: '架空の経験' }],
          }),
        });
      },
    },
  },
});
