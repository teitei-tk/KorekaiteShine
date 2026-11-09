export function lifecycleBootstrap(scenario = 'normal'): string {
  return `
import fs from 'node:fs';
import cp from 'node:child_process';
import http from 'node:http';
import timers from 'node:timers/promises';
import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
const scenario = ${JSON.stringify(scenario)};
const home = '/home/ai-review/.codex', root = '/opt/ai-review-probe/private';
const files = new Map();
const alive = new Set([32101, 32102]);
const digest = text => createHash('sha256').update(text).digest('hex');
files.set(home + '/config.toml', 'trusted config');
files.set(home + '/20.json', JSON.stringify({ pid: 32102, port: 43210 }));
files.set(root + '/upstream-report.json', JSON.stringify({ count: 1, authOk: true }));
files.set(root + '/lifecycle.json', JSON.stringify({ proxy: { pid: 32102, start: '99' }, backend: { pid: 32101, start: '99' }, infoPath: home + '/20.json', configHash: digest('trusted config'), startedAt: '0' }));
if (scenario === 'changed-config') files.set(home + '/config.toml', 'changed');
if (scenario === 'missing-report') files.delete(root + '/upstream-report.json');
Object.defineProperty(process, 'platform', { value: 'linux' });
process.getuid = () => 0;
process.hrtime.bigint = () => 1000000000n;
process.kill = (pid) => { if (![32101, 32102].includes(pid)) throw new Error('unexpected PID'); alive.delete(pid); return true; };
let clock = 0;
Temporal.Now.instant = () => Temporal.Instant.fromEpochMilliseconds(clock += 100);
timers.setTimeout = async () => {};
const managed = path => typeof path === 'string' && (path.startsWith('/home/ai-review') || path.startsWith('/opt/ai-review-probe'));
const read = fs.readFileSync;
fs.readFileSync = (path, ...args) => {
 const match = /^\\/proc\\/(32101|32102)\\/stat$/.exec(String(path));
 if (match) {
   if (!alive.has(Number(match[1]))) throw new Error('fixture process stopped');
   if (scenario === 'invalid-stat') return 'invalid';
   return match[1] + ' (fixture) ' + [scenario === 'zombie' ? 'Z' : 'S', ...Array(18).fill('0'), '99'].join(' ');
 }
 if (!managed(path)) return read(path, ...args);
 if (scenario === 'missing-info' && path.endsWith('.json') && !path.endsWith('lifecycle.json')) throw new Error('fixture missing info');
 if (!files.has(path)) throw new Error('fixture missing file');
 return files.get(path);
};
const write = fs.writeFileSync;
fs.writeFileSync = (path, text, ...args) => managed(path) ? files.set(path, String(text)) : write(path, text, ...args);
const exists = fs.existsSync;
fs.existsSync = path => managed(path) ? files.has(path) : exists(path);
const stat = fs.statSync;
fs.statSync = (path, ...args) => managed(path) ? { uid: scenario === 'wrong-owner' ? 1000 : 0, mode: 0o644 } : stat(path, ...args);
for (const name of ['chmodSync', 'rmSync']) {
 const original = fs[name]; fs[name] = (path, ...args) => managed(path) ? undefined : original(path, ...args);
}
const readlink = fs.readlinkSync;
fs.readlinkSync = (path, ...args) => path === '/proc/self/ns/pid' ? 'pid:[100]' : readlink(path, ...args);
cp.spawn = (command) => {
 if (!['/usr/local/bin/node', '/usr/local/bin/codex-responses-api-proxy'].includes(command)) throw new Error('unexpected spawn');
 const pid = command === '/usr/local/bin/node' ? 32101 : 32102;
 const child = new cp.ChildProcess(); Object.defineProperty(child, 'pid', { value: scenario === 'missing-pid' ? undefined : pid });
 child.stdin = new PassThrough(); child.unref = () => {};
 if (scenario === 'spawn-error') child.stdin.end = () => { child.emit('error', new Error('fixture')); return child.stdin; };
 if (scenario === 'stdin-error') child.stdin.end = () => { child.stdin.emit('error', new Error('fixture')); return child.stdin; };
 const path = pid === 32101 ? root + '/backend.json' : home + '/20.json';
 const mismatch = (scenario === 'backend-pid' && pid === 32101) || (scenario === 'proxy-pid' && pid === 32102);
 files.set(path, JSON.stringify({ pid: mismatch ? 1 : pid, port: scenario === 'invalid-port' ? 0 : 43210 }));
 return child;
};
cp.spawnSync = (command, args) => {
 if (command !== '/usr/bin/sudo') throw new Error('unexpected synchronous spawn');
 const input = JSON.parse(files.get('/opt/ai-review-probe/input.json'));
 const checks = ['uid', 'groups', 'credential-environment', 'protected-file-0', 'parent-environ', 'parent-mem', 'read-only-file-0', 'read-only-file-1', 'sudo', ...input.protectedProcesses.flatMap((_, i) => ['runner-process-' + i + '-environ', 'runner-process-' + i + '-mem'])].map(name => ({ name, passed: true }));
 if (scenario === 'outside-error') return { status: null, stdout: '', stderr: '' };
 if (scenario === 'bad-isolation') checks[0].passed = false;
 if (scenario === 'inside-error' && args.includes('sandbox')) return { status: 1, stdout: '', stderr: '' };
 if (scenario === 'probe-stops-proxy') alive.delete(32102);
 return { status: 0, stdout: JSON.stringify({ stage: 'sandbox', passed: true, pidNamespace: 'pid:[100]', checks }), stderr: '' };
};
globalThis.fetch = async url => {
 if (String(url) !== 'http://127.0.0.1:43210/shutdown') throw new Error('unexpected fixture request');
 if (scenario !== 'shutdown-failure') alive.delete(32102);
 return new Response(null, { status: scenario === 'shutdown-failure' ? 500 : 200 });
};
http.createServer = handler => ({
 listen(_port, _host, callback) {
   const req = { url: '/responses', method: 'POST', headers: { authorization: 'Bearer dummy-only' }, resume() {} };
   const res = { writeHead(status) { console.log('fixture HTTP status=' + status); }, end(body) { console.log(body); } };
   handler(req, res); callback();
 },
 address() { return scenario === 'bad-address' ? null : { port: 43210 }; },
});
syncBuiltinESMExports();
`;
}
