import { readEndpoints } from './schema.ts';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { platform } from 'node:os';
import { basename } from 'node:path';

type InspectorEndpoint = {
  id: string;
  webSocketDebuggerUrl: string;
};

/** 自分の子workerdが所有するソケットだけから直接Inspectorを探す。 */
export async function findWorkerdInspector(
  parentPid: number,
  names: readonly string[],
): Promise<InspectorEndpoint[]> {
  const rows = execFileSync('ps', ['-eo', 'pid=,ppid=,comm='], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .map((row) => {
      const [pid, parent, command] = row.trim().split(/\s+/u);
      return { pid: Number(pid), parent: Number(parent), command };
    });
  const children = new Set([parentPid]);
  while (true) {
    const previous = children.size;
    for (const row of rows) {
      if (children.has(row.parent)) {
        children.add(row.pid);
      }
    }
    if (children.size === previous) {
      break;
    }
  }
  const workerdPids = rows
    .filter((row) => children.has(row.pid) && basename(row.command) === 'workerd')
    .map((row) => row.pid);
  const ports =
    workerdPids.length === 0
      ? []
      : platform() === 'darwin'
        ? darwinPorts(workerdPids)
        : linuxPorts(workerdPids);
  for (const port of ports) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(1000),
      });
      if (!response.ok) {
        continue;
      }
      const endpoints = readEndpoints(await response.json());
      if (
        Array.isArray(endpoints) &&
        names.every((name) => endpoints.some((endpoint) => endpoint.id === `core:user:${name}`))
      ) {
        return endpoints;
      }
    } catch {
      /* Inspector以外の所有ソケットは候補から外す。 */
    }
  }
  throw new Error('子workerdの直接Inspectorが見つかりません');
}

function darwinPorts(pids: readonly number[]): number[] {
  const output = execFileSync(
    'lsof',
    ['-nP', '-a', '-p', pids.join(','), '-iTCP', '-sTCP:LISTEN', '-Fn'],
    { encoding: 'utf8' },
  );
  return [
    ...new Set(
      output.split('\n').flatMap((line) => {
        const match = /^n.+:(?<port>\d+)$/u.exec(line);
        return match ? [Number(match[1])] : [];
      }),
    ),
  ];
}

function linuxPorts(pids: readonly number[]): number[] {
  const inodes = new Set<string>();
  for (const pid of pids) {
    for (const fd of readdirSync(`/proc/${pid}/fd`)) {
      try {
        const socket = /^socket:\[(?<inode>\d+)\]$/u.exec(readlinkSync(`/proc/${pid}/fd/${fd}`));
        if (socket) {
          inodes.add(socket[1]);
        }
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
          throw error;
        }
      }
    }
  }
  return readFileSync('/proc/net/tcp', 'utf8')
    .trim()
    .split('\n')
    .slice(1)
    .map((row) => row.trim().split(/\s+/u))
    .filter((row) => row[3] === '0A' && inodes.has(row[9]))
    .map((row) => Number.parseInt(row[1].split(':')[1], 16));
}
