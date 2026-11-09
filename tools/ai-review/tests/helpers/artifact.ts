import { createArtifact, type Metadata, type GenerationOrigin } from '../../artifact.ts';
import type { ReviewInput } from '../../policy.ts';

export function artifactFixture() {
  const metadata: Metadata = {
    version: 2,
    repository: 'teitei-tk/KorekaiteShine',
    number: 7,
    head: 'a'.repeat(40),
    base: 'b'.repeat(40),
    sourceRun: '12',
    lines: { 'a.ts': [1] },
    history: { issues: [], inline: [], threads: [] },
  };
  const review: ReviewInput = {
    status: 'complete',
    summary: 'summary',
    uncertainties: [],
    findings: [],
  };
  const origin: GenerationOrigin = { run: '20', attempt: '1', sha: 'c'.repeat(40) };
  return { metadata, review, origin, create: () => createArtifact(metadata, review, origin, null) };
}
