import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const [directory, cause] = process.argv.slice(2);
const causes = [
  'audio-event',
  'upgrade',
  'failed-reservation',
  'active-usage',
  'manual-reconnect',
  'restart-credentials',
];
if (!directory || !causes.includes(cause)) {
  throw new Error(`対象の一時コピーと原因名を指定してください（${causes.join('、')}）。`);
}

const cwd = realpathSync(directory);
const tempRoots = [tmpdir(), '/tmp'].filter(existsSync).map((path) => realpathSync(path) + sep);
if (!tempRoots.some((root) => cwd.startsWith(root)) || existsSync(join(cwd, '.git'))) {
  throw new Error('一時ディレクトリ内の、.git を含まないソースコピーを指定してください。');
}
const patch = fileURLToPath(new URL(`./${cause}.patch`, import.meta.url));
execFileSync('git', ['apply', '--check', patch], { cwd, stdio: 'inherit' });
execFileSync('git', ['apply', patch], { cwd, stdio: 'inherit' });
