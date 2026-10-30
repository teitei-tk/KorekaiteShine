import { execFileSync } from 'node:child_process';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import MarkdownIt from 'markdown-it';
import GithubSlugger from 'github-slugger';
import { lint } from 'markdownlint/promise';

const markdown = new MarkdownIt();
type Token = ReturnType<typeof markdown.parse>[number];
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function plainText(tokens: Token[] | null | undefined = []): string {
  return (tokens ?? [])
    .map((token) => {
      if (token.type === 'image') return plainText(token.children);
      if (token.type === 'text' || token.type === 'code_inline') return token.content;
      if (token.type === 'softbreak' || token.type === 'hardbreak') return ' ';
      return '';
    })
    .join('');
}

function parse(source: string) {
  const tokens = markdown.parse(source, {});
  const slugger = new GithubSlugger();
  const anchors = new Set<string>();
  const links: { url: string; line: number }[] = [];
  let line = 1;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    // 表のセルにはmapがないため、直近の行トークンの位置を使う。
    if (token.map) line = token.map[0] + 1;
    if (token.type === 'heading_open') {
      anchors.add(slugger.slug(plainText(tokens[index + 1]?.children)));
    }
    if (token.type === 'inline') {
      for (const child of token.children ?? []) {
        const url =
          child.type === 'link_open'
            ? child.attrGet('href')
            : child.type === 'image'
              ? child.attrGet('src')
              : null;
        if (typeof url === 'string' && url) links.push({ url, line });
      }
    }
  }
  return { anchors, links };
}

function within(root: string, target: string) {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export async function checkLinks(root: string, files: string[]) {
  root = await realpath(root);
  const documents = new Map<string, ReturnType<typeof parse>>();
  const errors: string[] = [];
  async function document(file: string) {
    const cached = documents.get(file);
    if (cached) return cached;
    const parsed = parse(await readFile(file, 'utf8'));
    documents.set(file, parsed);
    return parsed;
  }
  for (const file of files) {
    const source = path.resolve(root, file);
    for (const { url, line } of (await document(source)).links) {
      if (/^(?:https?:|mailto:|tel:|\/\/)/i.test(url)) continue;
      try {
        if (/^[a-z][a-z\d+.-]*:/i.test(url)) throw new Error('未対応のリンク形式');
        const hash = url.indexOf('#');
        const location = hash < 0 ? url : url.slice(0, hash);
        const fragment = hash < 0 ? '' : decodeURIComponent(url.slice(hash + 1));
        const filename = decodeURIComponent(location.split('?')[0]);
        let target = filename
          ? path.resolve(
              filename.startsWith('/') ? root : path.dirname(source),
              filename.replace(/^\//, ''),
            )
          : source;
        if (!within(root, target)) throw new Error('リポジトリ外へのリンク');
        target = await realpath(target);
        if (!within(root, target)) throw new Error('リポジトリ外を指すシンボリックリンク');
        const info = await stat(target);
        if (info.isDirectory()) {
          if (fragment) throw new Error('ディレクトリへの見出しリンクは未対応');
          continue;
        }
        if (fragment) {
          if (!/\.md$/i.test(target)) throw new Error('Markdown以外の見出しリンクは未対応');
          if (!(await document(target)).anchors.has(fragment))
            throw new Error('見出しが存在しない');
        }
      } catch (error) {
        const reason =
          error instanceof Error && 'code' in error && error.code === 'ENOENT'
            ? 'ファイルが存在しない'
            : error instanceof Error
              ? error.message
              : String(error);
        errors.push(`${file}:${line}: ${reason}: ${url}`);
      }
    }
  }
  return errors;
}

// 文書のコマンドは実行せず、明示的なpnpmスクリプト呼び出しだけを照合する。
export async function checkCommands(root: string, files: string[]) {
  root = await realpath(root);
  const errors: string[] = [];
  // pnpm 12.15.0の --help にある組み込み操作と別名。更新時に一覧を照合する。
  // runとライフサイクルのスクリプト呼び出しは除く。pmは組み込み操作の明示指定。
  const builtins = new Set([
    'access',
    'add',
    'adduser',
    'approve',
    'approve-builds',
    'audit',
    'bin',
    'bugs',
    'c',
    'cache',
    'cat-file',
    'cat-index',
    'change',
    'ci',
    'clean',
    'clean-install',
    'completion',
    'config',
    'create',
    'dedupe',
    'deploy',
    'deprecate',
    'dislink',
    'dist-tag',
    'dist-tags',
    'dlx',
    'docs',
    'doctor',
    'edit',
    'env',
    'exec',
    'fetch',
    'find',
    'find-hash',
    'get',
    'help',
    'home',
    'i',
    'ic',
    'ignored-builds',
    'import',
    'info',
    'init',
    'install',
    'install-clean',
    'install-test',
    'issues',
    'it',
    'la',
    'lane',
    'licences',
    'licenses',
    'link',
    'list',
    'll',
    'ln',
    'login',
    'logout',
    'ls',
    'm',
    'multi',
    'outdated',
    'owner',
    'owners',
    'pack',
    'pack-app',
    'patch',
    'patch-commit',
    'patch-remove',
    'peers',
    'permissions',
    'ping',
    'pipeline',
    'pkg',
    'pm',
    'prefix',
    'profile',
    'prune',
    'publish',
    'purge',
    'rb',
    'rebuild',
    'recursive',
    'remove',
    'repo',
    'rm',
    'root',
    'rt',
    'run',
    'runtime',
    's',
    'sbom',
    'se',
    'search',
    'self-update',
    'set',
    'set-script',
    'setup',
    'shim',
    'show',
    'ss',
    'stage',
    'star',
    'stars',
    'store',
    'tasks',
    'team',
    'token',
    'un',
    'undeprecate',
    'uni',
    'uninstall',
    'unlink',
    'unpublish',
    'unstar',
    'up',
    'update',
    'upgrade',
    'v',
    'version',
    'view',
    'whoami',
    'why',
    'with',
    'xmas',
  ]);
  for (const file of files) {
    const tokens = markdown.parse(await readFile(path.join(root, file), 'utf8'), {});
    const commands: { text: string; line: number }[] = [];
    let line = 1;
    for (const token of tokens) {
      if (token.map) line = token.map[0] + 1;
      if (token.type === 'inline') {
        for (const child of token.children ?? []) {
          if (child.type === 'code_inline') commands.push({ text: child.content, line });
        }
      }
      if (token.type === 'fence' && /^(sh|shell|bash|zsh)$/.test(token.info.trim())) {
        token.content.split('\n').forEach((text, index) => {
          commands.push({ text, line: line + index + 1 });
        });
      }
    }
    for (const { text, line } of commands) {
      const words = text.trim().split(/\s+/);
      if (words.shift() !== 'pnpm') continue;
      let directory = '.';
      if (words[0] === '--dir') {
        words.shift();
        const value = words.shift();
        if (!value || !/^[\w./-]+$/.test(value) || value.startsWith('-')) continue;
        directory = value;
      }
      const explicitRun = words[0] === 'run' || words[0] === 'run-script';
      if (explicitRun) words.shift();
      let script = words.shift();
      if (!explicitRun && (script === 't' || script === 'tst')) script = 'test';
      // 未対応オプション・シェル構文・説明用プレースホルダーは照合しない。
      if (!script || script.startsWith('-') || /["'`$\\;&|<>(){}*?!#[\]]/.test(script)) continue;
      if (!explicitRun && builtins.has(script)) continue;
      const manifest = path.resolve(root, directory, 'package.json');
      try {
        if (!within(root, manifest)) throw new Error('リポジトリ外のpackage.json');
        const resolved = await realpath(manifest);
        if (!within(root, resolved)) throw new Error('リポジトリ外のpackage.json');
        const data = JSON.parse(await readFile(resolved, 'utf8'));
        if (
          !data?.scripts ||
          !Object.hasOwn(data.scripts, script) ||
          typeof data.scripts[script] !== 'string'
        ) {
          throw new Error(`スクリプトが存在しない: ${script} (${path.relative(root, manifest)})`);
        }
      } catch (error) {
        const reason =
          error instanceof Error && 'code' in error && error.code === 'ENOENT'
            ? `package.jsonが存在しない: ${path.relative(root, manifest)}`
            : error instanceof SyntaxError
              ? `package.jsonのJSONが不正: ${path.relative(root, manifest)}`
              : error instanceof Error
                ? error.message
                : 'package.jsonの検査に失敗';
        errors.push(`${file}:${line}: ${reason}`);
      }
    }
  }
  return errors;
}

async function main() {
  // Git管理対象と未追跡ファイルを検査し、依存・生成物はGitの除外設定に従う。
  const files = [
    ...new Set(
      execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
        cwd: repository,
        encoding: 'utf8',
      })
        .split('\0')
        .filter((file) => /\.md$/i.test(file)),
    ),
  ].sort();
  const existing = [];
  for (const file of files) {
    try {
      await stat(path.join(repository, file));
      existing.push(file);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  }
  const config = JSON.parse(await readFile(path.join(repository, '.markdownlint.json'), 'utf8'));
  const result = await lint({ files: existing.map((file) => path.join(repository, file)), config });
  const formatting = Object.entries(result)
    .flatMap(([file, errors]) =>
      errors.map(
        (error) =>
          `${path.relative(repository, file)}:${error.lineNumber}: ${error.ruleNames[0]} ${error.ruleDescription}${error.errorDetail ? ` (${error.errorDetail})` : ''}`,
      ),
    )
    .join('\n');
  const links = await checkLinks(repository, existing);
  const commands = await checkCommands(repository, existing);
  if (formatting) console.error(formatting);
  if (links.length) console.error(links.join('\n'));
  if (commands.length) console.error(commands.join('\n'));
  if (formatting || links.length || commands.length) process.exitCode = 1;
  else
    console.log(
      `文書検査成功: Markdown ${existing.length}件（書式・相対リンク・見出しアンカー・pnpmスクリプト）`,
    );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`文書検査失敗: ${error.message}`);
    process.exitCode = 1;
  });
}
