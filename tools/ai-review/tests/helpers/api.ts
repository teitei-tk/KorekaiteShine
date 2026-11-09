export function apiFixture() {
  const head = 'a'.repeat(40),
    base = 'b'.repeat(40);
  const pr = {
    number: 7,
    user: { id: 1324680, type: 'User' },
    state: 'open',
    draft: false,
    head: { sha: head, repo: { id: 1426899426 } },
    base: { sha: base, ref: 'main', repo: { id: 1426899426 } },
  };
  const run = {
    event: 'pull_request',
    conclusion: 'success',
    path: '.github/workflows/ci.yml',
    head_sha: head,
    repository: { id: 1426899426 },
    head_repository: { id: 1426899426 },
    pull_requests: [{ number: 7, head: { sha: head }, base: { sha: base } }],
  };
  const prefix = 'https://api.github.com/repos/teitei-tk/KorekaiteShine/';
  const http: Record<string, { body: object; status?: number }> = {
    [prefix + 'actions/runs/1']: { body: run },
    [prefix + 'pulls/7']: { body: pr },
    [prefix + 'issues/7/comments?per_page=100&page=1']: { body: [] },
    [prefix + 'pulls/7/comments?per_page=100&page=1']: { body: [] },
    'https://api.github.com/graphql': {
      body: {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
            },
          },
        },
      },
    },
  };
  return {
    pr,
    run,
    http,
    prefix,
    git: {
      init: '',
      fetch: '',
      checkout: '',
      'merge-base': 'c'.repeat(40),
      names: 'a.ts\0',
      diff: '@@ -0,0 +1 @@\n+line\n',
    },
  };
}
