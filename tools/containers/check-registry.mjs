import assert from 'node:assert/strict';

const denied = await fetch('http://registry-proxy:3128/@panda-guard%2ftest-malicious', {
  signal: AbortSignal.timeout(30_000),
});
assert.equal(denied.status, 403, 'Guardの拒否ステータスが一致しません。');
assert.equal((await denied.json()).error, 'Package blocked by security policy');
