import { ReviewFailure } from './failure.ts';
import type MarkdownIt from 'markdown-it';
import type * as TypeScript from 'typescript-parser';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { isMaterialPath } from './material.ts';

export const digest = (text: string): string => createHash('sha256').update(text).digest('hex');
export interface Source {
  id: string;
  path: string;
  revisions: string[];
  start: number;
  end: number;
  content: string;
}
export interface SourceFile {
  path: string;
  revisions: string[];
  sources: Source[];
  references: string[];
  unresolved: string[];
}
export interface SourceIndex {
  files: SourceFile[];
  excluded: string[];
}

function parse(
  path: string,
  content: string,
): { ends: number[]; references: string[]; unresolved: string[] } {
  const references: string[] = [],
    unresolved: string[] = [],
    ends: number[] = [];
  if (/\.[cm]?[jt]sx?$/.test(path)) {
    const ts: typeof TypeScript = createRequire(import.meta.url)('typescript-parser');
    const file = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true);
    for (const statement of file.statements) ends.push(statement.end);
    const visit = (node: TypeScript.Node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
        if (ts.isStringLiteral(node.moduleSpecifier)) references.push(node.moduleSpecifier.text);
      }
      if (
        ts.isImportTypeNode(node) &&
        ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteral(node.argument.literal)
      )
        references.push(node.argument.literal.text);
      if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference) &&
        node.moduleReference.expression &&
        ts.isStringLiteral(node.moduleReference.expression)
      )
        references.push(node.moduleReference.expression.text);
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
      ) {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteral(arg)) references.push(arg.text);
        else unresolved.push('dynamic-import');
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  } else if (path.endsWith('.md')) {
    const Parser: typeof MarkdownIt = createRequire(import.meta.url)('markdown-it');
    const markdown = new Parser();
    const tokens = markdown.parse(content, {});
    const lineOffsets = [0];
    for (const match of content.matchAll(/\n/g)) lineOffsets.push(match.index + 1);
    const visit = (items: ReturnType<typeof markdown.parse>) => {
      for (const token of items) {
        if (token.type === 'heading_open' && token.map && token.map[0] > 0)
          ends.push(lineOffsets[token.map[0]] - 1);
        const href =
          token.type === 'link_open'
            ? token.attrGet('href')
            : token.type === 'image'
              ? token.attrGet('src')
              : null;
        if (typeof href === 'string' && href && !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href)) {
          const ref = decodeURIComponent(href.split('#')[0]);
          if (ref) references.push(ref.startsWith('.') || ref.startsWith('/') ? ref : `./${ref}`);
        }
        if (token.children) visit(token.children);
      }
    };
    visit(tokens);
  } else {
    for (const match of content.matchAll(/\bnode\s+((?:\.\/)?[\w./-]+\.[cm]?[jt]s)\b/g)) {
      const ref = match[1];
      references.push(
        path.startsWith('.github/')
          ? `/${ref.replace(/^\.\//, '')}`
          : ref.startsWith('.')
            ? ref
            : `./${ref}`,
      );
    }
    for (const match of content.matchAll(/pnpm\s+--dir\s+([\w./-]+)/g))
      references.push(`/${match[1]}/package.json`);
    if (path.startsWith('.github/')) {
      for (const command of content.matchAll(/\bpnpm\s+([^\n\r]+)/g)) {
        const script = /^(?:--dir\s+([\w./-]+)\s+)?(?:run\s+)?([a-zA-Z][\w:-]*)(?=\s|["']|$)/.exec(
          command[1],
        );
        if (script) references.push(`/${script[1] ? script[1] + '/' : ''}package.json`);
        else unresolved.push('dynamic-script');
      }
    }
    // 設定を評価せず、明記されたリポジトリ内のスクリプト・設定パスだけを索引化する。
    for (const match of content.matchAll(
      /(?:["'\s:=]|^)((?:\.\/)?(?:tools|src|docs|\.github)\/[\w./-]+\.(?:[cm]?[jt]s|json|ya?ml|md))/g,
    ))
      references.push(`/${match[1].replace(/^\.\//, '')}`);
  }
  ends.push(content.length);
  return { ends: [...new Set(ends)].sort((a, b) => a - b), references, unresolved };
}

export function indexSources(
  git: (...args: string[]) => string,
  revisions: string[],
  limits = { files: 5000, bytes: 20_000_000 },
): SourceIndex {
  const started = Date.now();
  const blobs = new Map<string, SourceFile>();
  const excluded = new Set<string>();
  let bytes = 0,
    count = 0;
  for (const revision of new Set(revisions)) {
    const entries = git('ls-tree', '-r', '-z', revision).split('\0').filter(Boolean);
    if (entries.length > limits.files)
      throw new ReviewFailure('BUDGET_EXCEEDED', '索引のファイル上限を超えました');
    for (const entry of entries) {
      const match = /^(100644|100755) blob ([a-f0-9]{40})\t([\s\S]+)$/.exec(entry);
      if (!match || !isMaterialPath(match[3])) {
        excluded.add(entry.slice(entry.indexOf('\t') + 1));
        continue;
      }
      const [, , blob, path] = match;
      const key = `${blob}:${path}`;
      const existing = blobs.get(key);
      if (existing) {
        existing.revisions.push(revision);
        continue;
      }
      if (++count > limits.files)
        throw new ReviewFailure('BUDGET_EXCEEDED', '索引のファイル上限を超えました');
      const content = git('cat-file', 'blob', blob);
      if (Date.now() - started > 120_000)
        throw new ReviewFailure('BUDGET_EXCEEDED', '索引の時間上限を超えました');
      bytes += Buffer.byteLength(content);
      if (bytes > limits.bytes)
        throw new ReviewFailure('BUDGET_EXCEEDED', '索引のバイト上限を超えました');
      if (content.includes('\0')) {
        excluded.add(path);
        continue;
      }
      const parsed = parse(path, content);
      const file: SourceFile = {
        path,
        revisions: [revision],
        sources: [],
        references: parsed.references,
        unresolved: parsed.unresolved,
      };
      let offset = 0,
        start = 1;
      for (const end of parsed.ends) {
        // 原文の行を途中で切らない。巨大な単一宣言は後段の容量検証で停止する。
        let boundary = content.indexOf('\n', end);
        boundary = boundary < 0 ? content.length : boundary + 1;
        if (boundary <= offset) continue;
        const text = content.slice(offset, boundary);
        const lines = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
        file.sources.push({
          id: digest(`${path}:${start}:${text}`),
          path,
          revisions: file.revisions,
          start,
          end: start + lines - 1,
          content: text,
        });
        start += lines;
        offset = boundary;
      }
      const compact: Source[] = [];
      for (const source of file.sources) {
        const previous = compact.at(-1);
        if (
          previous &&
          Buffer.byteLength(previous.content) + Buffer.byteLength(source.content) <= 80_000
        ) {
          previous.content += source.content;
          previous.end = source.end;
          previous.id = digest(`${path}:${previous.start}:${previous.content}`);
        } else compact.push({ ...source });
      }
      file.sources = compact;
      blobs.set(key, file);
    }
  }
  return { files: [...blobs.values()], excluded: [...excluded].sort() };
}

export function resolveReference(
  path: string,
  ref: string,
  files: SourceFile[],
  revision: string,
): string | null {
  if (!ref.startsWith('.') && !ref.startsWith('/')) return null;
  const resolved = posix.normalize(
    ref.startsWith('/') ? ref.slice(1) : posix.join(posix.dirname(path), ref),
  );
  if (resolved.startsWith('../')) return null;
  const candidates = [
    resolved,
    ...['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js'].map(
      (ext) => resolved + ext,
    ),
  ];
  if (/\.[cm]?js$/.test(resolved)) candidates.push(resolved.replace(/\.[cm]?js$/, '.ts'));
  return (
    candidates.find((candidate) =>
      files.some((f) => f.path === candidate && f.revisions.includes(revision)),
    ) ?? null
  );
}
