import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// CI依存解析と同じCompiler APIでコメントを解析し、文字列やテンプレートを区別する。
const ts = createRequire(new URL('../ci/package.json', import.meta.url))('typescript-compiler-api');

const files = (
  process.argv.length > 2
    ? process.argv.slice(2)
    : execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0')
).filter((file) => /\.(?:[cm]?[jt]sx?)$/u.test(file));
const directive =
  /(?:oxlint|eslint)-(?:disable|enable)(?:-next-line|-line)?\b|biome-ignore\b|@ts-(?:ignore|nocheck)\b/u;
const errors = files.flatMap((file) => {
  const source = readFileSync(file, 'utf8');
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const comments = new Map();
  const textRanges = [];
  const collect = (ranges) => {
    for (const range of ranges ?? []) {
      comments.set(range.pos, range.end);
    }
  };
  const visit = (node) => {
    if (node.kind === ts.SyntaxKind.JsxText || ts.isLiteralExpression(node)) {
      textRanges.push([node.getStart(parsed), node.end]);
    }
    collect(ts.getLeadingCommentRanges(source, node.pos));
    collect(ts.getTrailingCommentRanges(source, node.end));
    for (const child of node.getChildren(parsed)) {
      visit(child);
    }
  };
  visit(parsed);
  return [...comments].flatMap(([start, end]) => {
    if (textRanges.some(([textStart, textEnd]) => start >= textStart && start < textEnd)) {
      return [];
    }
    const text = source.slice(start, end);
    const line = parsed.getLineAndCharacterOfPosition(start).line + 1;
    return directive.test(text) ? [`${file}:${line}: inline検査抑制は禁止です。`] : [];
  });
});
if (errors.length > 0) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log('inline検査抑制: 0件');
}
