import { defineSeed } from 'void/seed';
import * as schema from './schema.ts';
import { connectionCheckFixtures } from '../fixtures/connection-checks.ts';

export default defineSeed<typeof schema>(({ db }) => {
  db.insert(schema.connectionChecks).values(connectionCheckFixtures).run();
});
