import { Generator, getConfig } from '@tanstack/router-generator';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
await new Generator({ config: getConfig({}, root), root }).run();
