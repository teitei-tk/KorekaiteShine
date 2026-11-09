import { ChildProcess } from 'node:child_process';
import { afterEach, expect, test, vi } from 'vitest';
import { stopProcessGroup } from '../src/process.ts';

afterEach(() => vi.restoreAllMocks());

test('猶予終了後の強制停止時に消えたプロセスを正常停止として扱う', async () => {
  const child = new ChildProcess();
  Object.defineProperty(child, 'pid', { value: 12345 });
  vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
    if (signal === 'SIGKILL') {
      throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    }
    return true;
  });
  await expect(stopProcessGroup(child, { graceMs: 0 })).resolves.toBeUndefined();
});

test('停止時の非Error例外も隠さず呼出し元へ返す', async () => {
  const child = new ChildProcess();
  Object.defineProperty(child, 'pid', { value: 12345 });
  vi.spyOn(process, 'kill').mockImplementation(() => {
    throw 'private failure';
  });
  await expect(stopProcessGroup(child)).rejects.toBe('private failure');
});

test('停止シグナル自体が拒否されたら終了済みとして扱わない', async () => {
  const child = new ChildProcess();
  Object.defineProperty(child, 'pid', { value: 12345 });
  const error = Object.assign(new Error('denied'), { code: 'EPERM' });
  vi.spyOn(process, 'kill').mockImplementation(() => {
    throw error;
  });
  await expect(stopProcessGroup(child)).rejects.toBe(error);
});

test('生存確認のEPERMを終了済みと判断せず強制停止の期限まで確認する', async () => {
  const child = new ChildProcess();
  Object.defineProperty(child, 'pid', { value: 12345 });
  const kill = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
    if (signal === 0) {
      throw Object.assign(new Error('denied'), { code: 'EPERM' });
    }
    return true;
  });
  await expect(stopProcessGroup(child, { graceMs: 0, killMs: 0 })).rejects.toThrow('期限内に停止');
  expect(kill.mock.calls).toEqual([
    [-12345, 'SIGTERM'],
    [-12345, 0],
    [-12345, 'SIGKILL'],
    [-12345, 0],
  ]);
});

test('PIDを持たない起動失敗プロセスには停止シグナルを送らない', async () => {
  const kill = vi.spyOn(process, 'kill');
  await stopProcessGroup(new ChildProcess());
  expect(kill).not.toHaveBeenCalled();
});
