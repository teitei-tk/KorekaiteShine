import { lifecycleBootstrap } from './lifecycle-cli.ts';

export function modelCliFixture(directory: string, scenario = 'normal') {
  const claims = {
    iss: 'https://token.actions.githubusercontent.com',
    aud: 'https://api.openai.com/v1',
    repository: 'teitei-tk/KorekaiteShine',
    repository_id: '1426899426',
    repository_owner_id: '1324680',
    ref: 'refs/heads/main',
    event_name: 'workflow_run',
    workflow_ref: 'teitei-tk/KorekaiteShine/.github/workflows/ai-review.yml@refs/heads/main',
  };
  const token =
    'fixture.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.signature';
  return {
    env: {
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'fixture',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.invalid/request',
      OPENAI_WIF_AUDIENCE: claims.aud,
      OPENAI_IDENTITY_PROVIDER_ID: 'idp_fixture',
      OPENAI_SERVICE_ACCOUNT_ID: 'account-fixture',
      GITHUB_STEP_SUMMARY: directory + '/summary',
      MODEL_OUTPUT: '{"status":"ok"}',
    },
    replies: { fetch: { body: { value: token } } },
    bootstrap:
      `const authFetch = globalThis.fetch;\n` +
      lifecycleBootstrap(scenario) +
      `
const modelDir = root + '/model', dumpDir = modelDir + '/dump';
const modelSchema = { type: 'object', properties: { status: { type: 'string', enum: ['ok'] } }, required: ['status'], additionalProperties: false };
files.set(modelDir + '/state.json', JSON.stringify({ proxy: { pid: 32102, start: '99' }, infoPath: home + '/20.json', startedAt: '0', hash: digest('trusted config'), rejected: scenario !== 'not-rejected' }));
if (scenario === 'finish-pid') files.set(home + '/20.json', JSON.stringify({ pid: 1, port: 43210 }));
const infoRead = fs.readFileSync;
fs.readFileSync = (path, ...args) => { const value = infoRead(path, ...args); if (scenario === 'expired-proxy' && path === home + '/20.json') alive.delete(32102); return value; };
files.set(dumpDir + '/2-request.json', JSON.stringify({ body: { model: 'gpt-6-luna', text: { format: { type: 'json_schema', schema: modelSchema } } } }));
files.set(dumpDir + '/2-response.json', JSON.stringify({ status: 200, body: 'data: ' + JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [{ content: [{ type: 'output_text', text: '{"status":"ok"}' }] }], usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } } }) + '\\n' }));
let elapsedNs = process.argv[2] === 'wait' ? 0n : 3660000000000n;
process.hrtime.bigint = () => elapsedNs;
timers.setTimeout = async ms => { elapsedNs += BigInt(ms) * 1000000n; };
const mkdir = fs.mkdirSync; fs.mkdirSync = (path, ...args) => managed(path) ? undefined : mkdir(path, ...args);
const readdir = fs.readdirSync;
fs.readdirSync = (path, ...args) => {
 if (path !== dumpDir) return readdir(path, ...args);
 if (scenario === 'bad-dumps') return [];
 if (process.argv[2] === 'wait') return scenario === 'unexpected-response' ? ['1-request.json', '1-response.json'] : ['1-request.json'];
 return ['1-request.json', '2-request.json', '2-response.json'];
};
const spawnBoundary = cp.spawnSync;
cp.spawnSync = (command, args, ...rest) => {
 if (['/usr/sbin/iptables', '/usr/sbin/ip6tables'].includes(command)) { console.log('fixture firewall ' + command + ' ' + args[0]); return { status: scenario === 'firewall-failure' && command.endsWith('ip6tables') && args[0] === '-I' ? 1 : 0 }; }
 return spawnBoundary(command, args, ...rest);
};
const shutdownFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
 if (String(url).startsWith('https://oidc.invalid/')) return authFetch(url, options);
 if (String(url) === 'http://127.0.0.1:43210/v1/responses') return new Response(null, { status: scenario === 'renewal-open' ? 200 : 502 });
 return shutdownFetch(url, options);
};
syncBuiltinESMExports();
`,
  };
}
