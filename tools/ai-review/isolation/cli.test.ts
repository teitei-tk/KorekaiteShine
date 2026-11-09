import { expect, it } from 'vitest';
import { cliFixture, unprivilegedLinux } from '../tests/helpers/cli.ts';
import { lifecycleBootstrap } from '../tests/helpers/lifecycle-cli.ts';
import { modelCliFixture } from '../tests/helpers/model-cli.ts';
it('modelは不正操作・成果物欠落・権限不足を固定理由で拒否する', () => {
  for (const args of [[], ['prepare'], ['finish'], ['finish', 'success']]) {
    const fixture = cliFixture();
    const input = modelCliFixture(fixture.directory);
    const result = fixture.run('isolation/model.ts', {
      ...input,
      env: { ...input.env, MODEL_OUTPUT: undefined },
      args,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('WIF model verification failed');
  }
  const fixture = cliFixture();
  expect(
    fixture.run('isolation/model.ts', { args: ['wait'], bootstrap: unprivilegedLinux }).status,
  ).toBe(1);
});
it('modelはプロキシの途中終了や終了API失敗を成功扱いしない', () => {
  for (const scenario of ['expired-proxy', 'finish-pid', 'shutdown-failure']) {
    const fixture = cliFixture();
    const result = fixture.run('isolation/model.ts', {
      ...modelCliFixture(fixture.directory, scenario),
      args: ['finish', 'success'],
    });
    expect(result.status, scenario).toBe(1);
    expect(result.stderr).toContain('WIF model verification failed');
  }
  const fixture = cliFixture();
  expect(
    fixture.run('isolation/model.ts', {
      ...modelCliFixture(fixture.directory, 'expired-proxy'),
      args: ['prepare', '20'],
    }).status,
  ).toBe(1);
});
it('modelは未検証の更新失敗や不足したdumpを成功扱いしない', () => {
  for (const scenario of ['not-rejected', 'bad-dumps']) {
    const fixture = cliFixture();
    const result = fixture.run('isolation/model.ts', {
      ...modelCliFixture(fixture.directory, scenario),
      args: ['finish', 'success'],
    });
    expect(result.status, scenario).toBe(1);
    expect(result.stdout).not.toContain('"stage":"wif-model"');
    expect(result.stdout).toContain('official shutdown passed');
  }
});
it('modelは設定改変・所有者変更を成功扱いしない', () => {
  for (const scenario of ['changed-config', 'wrong-owner']) {
    const fixture = cliFixture();
    const result = fixture.run('isolation/model.ts', {
      ...modelCliFixture(fixture.directory, scenario),
      args: ['finish', 'success'],
    });
    expect(result.status, scenario).toBe(1);
    expect(result.stdout).not.toContain('"stage":"wif-model"');
  }
});
it('modelは更新失敗時に外部転送が閉じられた証拠を要求する', () => {
  for (const scenario of ['renewal-open', 'unexpected-response']) {
    const fixture = cliFixture();
    const result = fixture.run('isolation/model.ts', {
      ...modelCliFixture(fixture.directory, scenario),
      args: ['wait'],
    });
    expect(result.status, scenario).toBe(1);
    expect(result.stdout).toContain('fixture firewall /usr/sbin/iptables -D');
    expect(result.stdout).toContain('fixture firewall /usr/sbin/ip6tables -D');
  }
});

it('modelは更新失敗の注入が途中で失敗しても挿入済み規則を戻す', () => {
  const fixture = cliFixture();
  const result = fixture.run('isolation/model.ts', {
    ...modelCliFixture(fixture.directory, 'firewall-failure'),
    args: ['wait'],
  });
  expect(result.status).toBe(1);
  expect(result.stdout).toContain('fixture firewall /usr/sbin/iptables -D');
  expect(result.stdout).not.toContain('fixture firewall /usr/sbin/ip6tables -D');
});
it('modelは初期交換のPID不一致を固定理由で拒否する', () => {
  const fixture = cliFixture();
  const result = fixture.run('isolation/model.ts', {
    ...modelCliFixture(fixture.directory, 'proxy-pid'),
    args: ['prepare', '20'],
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('WIF model verification failed');
});
it('modelのfinishはSchema・応答・利用量・公式終了を検証する', () => {
  const fixture = cliFixture();
  const result = fixture.run('isolation/model.ts', {
    ...modelCliFixture(fixture.directory),
    args: ['finish', 'success'],
  });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('"stage":"wif-model"');
  expect(result.stdout).toContain('"total_tokens":3');
  expect(result.stdout).toContain('official shutdown passed');
});
it('modelのwaitは期限後の交換失敗を確認して規則を復元する', () => {
  const fixture = cliFixture();
  const result = fixture.run('isolation/model.ts', {
    ...modelCliFixture(fixture.directory),
    args: ['wait'],
  });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('expired token renewal failed closed; network restored');
});

it('modelのprepareは初期交換とSchema・隔離確認を完了する', () => {
  const fixture = cliFixture();
  const result = fixture.run('isolation/model.ts', {
    ...modelCliFixture(fixture.directory),
    args: ['prepare', '20'],
  });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('initial exchange and isolation passed');
});
it('lifecycleは不正な操作・モードと実行権限不足を拒否する', () => {
  for (const args of [[], ['invalid', 'complete'], ['prepare', 'complete'], ['finish', 'reject']]) {
    const fixture = cliFixture();
    const result = fixture.run('isolation/lifecycle.ts', { args, bootstrap: lifecycleBootstrap() });
    expect(result.status).toBe(1);
  }
  const fixture = cliFixture();
  expect(
    fixture.run('isolation/lifecycle.ts', {
      args: ['prepare', 'complete', '20'],
      bootstrap: unprivilegedLinux,
    }).status,
  ).toBe(1);
});
it('lifecycleは外側とsandbox両方の隔離検査に成功を要求する', () => {
  for (const scenario of ['outside-error', 'bad-isolation', 'inside-error']) {
    const fixture = cliFixture();
    const result = fixture.run('isolation/lifecycle.ts', {
      args: ['prepare', 'complete', '20'],
      bootstrap: lifecycleBootstrap(scenario),
    });
    expect(result.status, scenario).toBe(1);
    expect(result.stdout).not.toContain('isolation: passed');
  }
});
it('lifecycleは不正なプロセス情報とゾンビ状態を稼働の証拠にしない', () => {
  for (const scenario of ['invalid-stat', 'zombie', 'invalid-port']) {
    const fixture = cliFixture();
    const result = fixture.run('isolation/lifecycle.ts', {
      args: ['prepare', 'complete', '20'],
      bootstrap: lifecycleBootstrap(scenario),
    });
    expect(result.status, scenario).toBe(1);
  }
});

it('lifecycleはプロセス起動や標準入力のエラーを失敗終了にする', () => {
  for (const scenario of ['spawn-error', 'stdin-error', 'missing-pid']) {
    const fixture = cliFixture();
    const result = fixture.run('isolation/lifecycle.ts', {
      args: ['prepare', 'complete', '20'],
      bootstrap: lifecycleBootstrap(scenario),
    });
    expect(result.status, scenario).toBe(1);
  }
});
it('lifecycleは終了API失敗を強制停止の成功で置き換えない', () => {
  const fixture = cliFixture();
  const result = fixture.run('isolation/lifecycle.ts', {
    args: ['finish', 'complete', 'success'],
    env: { FIXTURE_OUTPUT: 'offline fixture complete' },
    bootstrap: lifecycleBootstrap('shutdown-failure'),
  });
  expect(result.status).toBe(1);
  expect(result.stdout).toContain('"result":true,"shutdown":false');
});
it('lifecycleは要求記録がない場合にモデル検証を成功扱いしない', () => {
  const fixture = cliFixture();
  const result = fixture.run('isolation/lifecycle.ts', {
    args: ['finish', 'complete', 'success'],
    env: { FIXTURE_OUTPUT: undefined },
    bootstrap: lifecycleBootstrap('missing-report'),
  });
  expect(result.status).toBe(1);
  expect(result.stdout).toContain('"result":false');
});
it('lifecycleは保護設定の変更を終了成功だけで隠さない', () => {
  const fixture = cliFixture();
  const result = fixture.run('isolation/lifecycle.ts', {
    args: ['finish', 'complete', 'success'],
    env: { FIXTURE_OUTPUT: 'offline fixture complete' },
    bootstrap: lifecycleBootstrap('changed-config'),
  });
  expect(result.status).toBe(1);
  expect(result.stdout).toContain('"result":false,"shutdown":true');
});
it('lifecycleはserver-info欠落で期限までに停止する', () => {
  const fixture = cliFixture();
  const result = fixture.run('isolation/lifecycle.ts', {
    args: ['prepare', 'complete', '20'],
    bootstrap: lifecycleBootstrap('missing-info'),
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('did not become ready');
});
it('lifecycleは検査中に終了したプロキシを成功扱いしない', () => {
  const fixture = cliFixture();
  const result = fixture.run('isolation/lifecycle.ts', {
    args: ['prepare', 'complete', '20'],
    bootstrap: lifecycleBootstrap('probe-stops-proxy'),
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('proxy exited during probe');
});
it('lifecycleはプロキシのPID不一致を検出して準備を中止する', () => {
  const fixture = cliFixture();
  const result = fixture.run('isolation/lifecycle.ts', {
    args: ['prepare', 'complete', '20'],
    bootstrap: lifecycleBootstrap('proxy-pid'),
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('proxy identity mismatch');
});
it('lifecycleはbackendのPID不一致を検出して準備を中止する', () => {
  const fixture = cliFixture();
  const result = fixture.run('isolation/lifecycle.ts', {
    args: ['prepare', 'complete', '20'],
    bootstrap: lifecycleBootstrap('backend-pid'),
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('backend identity mismatch');
});
it('lifecycleの受信器がアドレスを取得できなければ失敗する', () => {
  const fixture = cliFixture();
  const result = fixture.run('isolation/lifecycle.ts', {
    args: ['serve', 'complete'],
    bootstrap: lifecycleBootstrap('bad-address'),
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('fixture receiver unavailable');
});
it('lifecycleの拒否用受信器は400を返す', () => {
  const fixture = cliFixture();
  const result = fixture.run('isolation/lifecycle.ts', {
    args: ['serve', 'reject'],
    bootstrap: lifecycleBootstrap(),
  });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('fixture HTTP status=400');
});
it('lifecycleの受信器は固定SSE応答を返す', () => {
  const fixture = cliFixture();
  const result = fixture.run('isolation/lifecycle.ts', {
    args: ['serve', 'complete'],
    bootstrap: lifecycleBootstrap(),
  });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('fixture HTTP status=200');
  expect(result.stdout).toContain('event: response.completed');
});
it('lifecycleのfinishは出力・設定・終了APIを確認して成功する', () => {
  const fixture = cliFixture();
  const result = fixture.run('isolation/lifecycle.ts', {
    args: ['finish', 'complete', 'success'],
    env: { FIXTURE_OUTPUT: 'offline fixture complete' },
    bootstrap: lifecycleBootstrap(),
  });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('"result":true,"shutdown":true');
});

it('lifecycleのprepareは公式プロキシと境界検査の完了を確認する', () => {
  const fixture = cliFixture();
  const result = fixture.run('isolation/lifecycle.ts', {
    args: ['prepare', 'complete', '20'],
    bootstrap: lifecycleBootstrap(),
  });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain(
    'official proxy memory, config and server-info isolation: passed',
  );
});
