import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, readlinkSync } from 'node:fs';

interface InspectorEndpoint {
  id: string;
  webSocketDebuggerUrl: string;
}

/** Linux上の自分の子workerdが所有するソケットだけから直接Inspectorを探す。 */
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
  for (let previous = -1; previous !== children.size;) {
    previous = children.size;
    for (const row of rows) {
      if (children.has(row.parent)) {
        children.add(row.pid);
      }
    }
  }
  const inodes = new Set<string>();
  for (const row of rows.filter((row) => children.has(row.pid) && row.command === 'workerd')) {
    for (const fd of readdirSync(`/proc/${row.pid}/fd`)) {
      try {
        const socket = readlinkSync(`/proc/${row.pid}/fd/${fd}`).match(/^socket:\[(\d+)\]$/u);
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
  const ports = readFileSync('/proc/net/tcp', 'utf8')
    .trim()
    .split('\n')
    .slice(1)
    .map((row) => row.trim().split(/\s+/u))
    .filter((row) => row[3] === '0A' && inodes.has(row[9]))
    .map((row) => Number.parseInt(row[1].split(':')[1], 16));
  for (const port of ports) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(1000),
      });
      if (!response.ok) {
        continue;
      }
      const endpoints: InspectorEndpoint[] = await response.json();
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
