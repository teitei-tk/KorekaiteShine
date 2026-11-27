import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runSessionCommand } from './session.mjs';

const sessionId = '216982b0-dead-4784-82b1-1e2e660459a3';
const socket = 'unix:///tmp/local-docker.sock';
const labelKey = 'io.github.teitei-tk.korekaite-shine.codex-session';

test('指定したローカルコンテキストからセッションのラベル付きコンテナを起動する', () => {
  const calls = [];
  const output = runSessionCommand(['run', 'alpine', 'sleep', '60'], {
    threadId: sessionId,
    readContext: () => 'orbstack\n',
    docker: (args) => {
      calls.push(args);
      return calls.length === 1 ? `${socket}\n` : 'container-id\n';
    },
  });

  assert.equal(output, 'container-id\n');
  assert.deepEqual(calls, [
    ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}', '--', 'orbstack'],
    [
      '--host',
      socket,
      'run',
      '--detach',
      '--label',
      `${labelKey}=${sessionId}`,
      '--',
      'alpine',
      'sleep',
      '60',
    ],
  ]);
});

test('終了したセッションの起動済み・停止済みコンテナだけを削除する', () => {
  const running = 'a'.repeat(64);
  const stopped = 'b'.repeat(64);
  const containers = [
    { id: running, owner: sessionId, running: true },
    { id: stopped, owner: sessionId, running: false },
    { id: 'c'.repeat(64), owner: 'a72224e8-7f41-4dcf-a963-1aea0766d9e1', running: true },
    { id: 'd'.repeat(64), running: true },
  ];
  const docker = test.mock.fn((args) => {
    if (args[0] === 'context') {
      return socket;
    }
    if (args[2] === 'ps') {
      const label = args[args.indexOf('--filter') + 1];
      return containers
        .filter(
          ({ owner, running }) =>
            owner && label === `label=${labelKey}=${owner}` && (running || args.includes('--all')),
        )
        .map(({ id }) => id)
        .join('\n');
    }
    return '';
  });

  runSessionCommand(['cleanup'], {
    readInput: () => JSON.stringify({ hook_event_name: 'SessionEnd', session_id: sessionId }),
    readContext: () => 'orbstack',
    docker,
  });

  assert.deepEqual(docker.mock.calls.map(({ arguments: [args] }) => args).slice(1), [
    [
      '--host',
      socket,
      'ps',
      '--all',
      '--quiet',
      '--no-trunc',
      '--filter',
      `label=${labelKey}=${sessionId}`,
    ],
    ['--host', socket, 'rm', '--force', '--', running, stopped],
  ]);
  const timeouts = docker.mock.calls.map(({ arguments: [, timeout] }) => timeout);
  assert.ok(
    timeouts.every((timeout) => Number.isInteger(timeout) && timeout > 0 && timeout <= 2500),
  );
  assert.deepEqual(
    timeouts,
    timeouts.toSorted((first, second) => second - first),
  );
});

test('空または不正な起動用セッション ID では Docker を呼び出さない', () => {
  const docker = test.mock.fn();
  for (const threadId of ['', '*', 'session=foreign']) {
    assert.throws(
      () => runSessionCommand(['run', 'alpine'], { threadId, docker }),
      /有効な Codex セッション ID/u,
    );
  }
  assert.equal(docker.mock.callCount(), 0);
});

test('コンテキストが未指定・存在しない・リモートの場合にコンテナ操作を行わない', () => {
  const docker = test.mock.fn(([command]) => {
    assert.equal(command, 'context');
    return 'ssh://remote.example';
  });
  for (const args of [
    ['run', 'alpine'],
    ['cleanup', '--session', sessionId],
  ]) {
    assert.throws(
      () => runSessionCommand(args, { threadId: sessionId, readContext: () => '', docker }),
      /Docker コンテキスト名/u,
    );
    assert.throws(
      () => runSessionCommand(args, { threadId: sessionId, readContext: () => 'remote', docker }),
      /Unix ソケット/u,
    );
  }
  assert.equal(docker.mock.callCount(), 2);

  const missing = new Error('context not found');
  const missingDocker = test.mock.fn(() => {
    throw missing;
  });
  assert.throws(
    () =>
      runSessionCommand(['run', 'alpine'], {
        threadId: sessionId,
        readContext: () => 'missing',
        docker: missingDocker,
      }),
    missing,
  );
  assert.equal(missingDocker.mock.callCount(), 1);
});

test('SessionEnd の入力が不正な場合は Docker を呼び出さない', () => {
  const docker = test.mock.fn();
  for (const input of [
    '{',
    'null',
    '{"hook_event_name":"Stop"}',
    '{"hook_event_name":"SessionEnd"}',
  ]) {
    assert.throws(() => runSessionCommand(['cleanup'], { readInput: () => input, docker }));
  }
  assert.equal(docker.mock.callCount(), 0);
});

test('対象が空または Docker の応答に完全な ID が含まれない場合は削除を呼び出さない', () => {
  for (const response of ['', `${'a'.repeat(64)}\nnot-a-container`]) {
    const docker = test.mock.fn((args) => (args[0] === 'context' ? socket : response));
    const cleanup = () =>
      runSessionCommand(['cleanup', '--session', sessionId], {
        readContext: () => 'orbstack',
        docker,
      });
    if (response) {
      assert.throws(cleanup, /完全なコンテナ ID/u);
    } else {
      assert.equal(cleanup(), '');
    }
    assert.deepEqual(
      docker.mock.calls.map(({ arguments: [args] }) => (args[0] === 'context' ? args[0] : args[2])),
      ['context', 'ps'],
    );
  }
});

test('一部の削除が失敗した後の手動再実行では残っている ID だけを削除する', () => {
  const first = 'a'.repeat(64);
  const second = 'b'.repeat(64);
  const remaining = new Set([first, second]);
  const rmCalls = [];
  const docker = (args) => {
    if (args[0] === 'context') {
      return socket;
    }
    if (args[2] === 'ps') {
      return [...remaining].join('\n');
    }
    const ids = args.slice(5);
    rmCalls.push(ids);
    if (ids.includes(first)) {
      remaining.delete(first);
      throw new Error('部分失敗');
    }
    remaining.delete(second);
    return second;
  };
  const cleanup = () =>
    runSessionCommand(['cleanup', '--session', sessionId], {
      readContext: () => 'orbstack',
      docker,
    });

  assert.throws(cleanup, /部分失敗/u);
  assert.equal(cleanup(), second);
  assert.equal(cleanup(), '');
  assert.deepEqual(rmCalls, [[first, second], [second]]);
});
