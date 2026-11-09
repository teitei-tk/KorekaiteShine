/** 公式実行ファイル・rootのファイル操作だけを子プロセス内で制御する。 */
export const wifCliBootstrap = `
import fs from 'node:fs';
import cp from 'node:child_process';
import { PassThrough } from 'node:stream';
import { syncBuiltinESMExports } from 'node:module';
Object.defineProperty(process, 'platform', { value: 'linux' });
process.getuid = () => 0;
const infoPath = '/home/ai-review/.codex/wif-authentication.json';
const inputPath = '/opt/ai-review-probe/input.json';
let input;
const child = new cp.ChildProcess();
Object.defineProperty(child, 'pid', { value: 12345 });
child.stdin = new PassThrough();
cp.spawn = (command) => { if (command !== '/usr/local/bin/codex-responses-api-proxy') throw new Error('unexpected fixture command'); return child; };
const readlink = fs.readlinkSync;
fs.readlinkSync = (path, ...args) => path === '/proc/self/ns/pid' ? 'pid:[100]' : readlink(path, ...args);
const read = fs.readFileSync;
fs.readFileSync = (path, ...args) => path === infoPath ? JSON.stringify({ pid: 12345, port: 43210 }) : read(path, ...args);
const write = fs.writeFileSync;
fs.writeFileSync = (path, text, ...args) => { if (path === inputPath) { input = JSON.parse(text); return; } return write(path, text, ...args); };
for (const name of ['chmodSync', 'rmSync']) {
 const original = fs[name]; fs[name] = (path, ...args) => path === infoPath ? undefined : original(path, ...args);
}
cp.spawnSync = (command, ...args) => {
 if (command !== '/usr/bin/sudo') throw new Error('unexpected fixture command');
 const names = ['uid', 'groups', 'credential-environment', 'protected-file-0', 'parent-environ', 'parent-mem', 'read-only-file-0', 'read-only-file-1', 'sudo', ...input.protectedProcesses.flatMap((_, index) => ['runner-process-' + index + '-environ', 'runner-process-' + index + '-mem'])];
 return { status: 0, stdout: JSON.stringify({ stage: 'sandbox', passed: true, pidNamespace: input.parentPidNamespace, checks: names.map(name => ({ name, passed: true })) }), stderr: '' };
};
const fetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
 if (String(url) === 'http://127.0.0.1:43210/shutdown') {
  Object.defineProperty(child, 'exitCode', { value: 0 });
  return new Response(null, { status: 200 });
 }
 return fetch(url, options);
};
syncBuiltinESMExports();
`;
