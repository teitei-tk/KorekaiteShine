import { parseJson, isJsonObject } from './json.ts';
import type { JsonInput } from './json.ts';
import { requireValue } from './required.ts';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { digest, normalizeSnapshot, snapshotRevision } from './snapshot.ts';
import type { Snapshot } from './snapshot.ts';
import { reviewHistory, historyMarker } from './history.ts';
import { latestFollowupStatus } from './followup.ts';
import { REPOSITORY, MARKER, safe, validReview, renderReview } from './policy.ts';
import type { Review } from './policy.ts';
export type GenerationOrigin = {
  run: string;
  attempt: string;
  sha: string;
};
export type Metadata = {
  version: 2;
  repository: string;
  number: number;
  head: string;
  base: string;
  sourceRun: string;
  lines: Record<string, number[]>;
  history: Snapshot;
};
export type Operation = {
  id: string;
  kind: 'finding' | 'reply' | 'summary';
  body: string;
  bodyHash: string;
  replyTo?: number;
  path?: string;
  line?: number;
};
export type ReviewArtifact = {
  version: 2;
  origin: GenerationOrigin;
  metadata: Metadata;
  historyRevision: string;
  resultHash: string;
  review: Review;
  operations: Operation[];
  usage: { input: number; output: number; total: number } | null;
  cost: null;
};
export const generationMarker = (m: Metadata, o: GenerationOrigin) =>
  `<!-- generation:v2:${o.run}:${o.attempt}:${m.head}:${m.base} -->`;
export const operationMarker = (id: string) => `<!-- operation:v2:${id} -->`;
export function validOrigin(o: JsonInput): o is GenerationOrigin {
  return (
    isJsonObject(o) &&
    typeof o.run === 'string' &&
    /^[1-9]\d*$/u.test(o.run) &&
    typeof o.attempt === 'string' &&
    /^[1-9]\d*$/u.test(o.attempt) &&
    typeof o.sha === 'string' &&
    /^[a-f0-9]{40}$/u.test(o.sha)
  );
}
export function validateMetadata(m: JsonInput): Metadata {
  if (
    !isJsonObject(m) ||
    m.version !== 2 ||
    m.repository !== REPOSITORY ||
    typeof m.number !== 'number' ||
    !Number.isSafeInteger(m.number) ||
    m.number < 1 ||
    typeof m.head !== 'string' ||
    !/^[a-f0-9]{40}$/u.test(m.head) ||
    typeof m.base !== 'string' ||
    !/^[a-f0-9]{40}$/u.test(m.base) ||
    typeof m.sourceRun !== 'string' ||
    !/^[1-9]\d*$/u.test(m.sourceRun) ||
    !isJsonObject(m.lines)
  ) {
    throw new Error('成果物の対象が不正です');
  }
  const lines: Record<string, number[]> = {};
  for (const [path, values] of Object.entries(m.lines)) {
    if (
      path.length === 0 ||
      !Array.isArray(values) ||
      !values.every((n): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 1)
    ) {
      throw new Error('成果物の対象が不正です');
    }
    lines[path] = values;
  }
  return {
    ...m,
    version: m.version,
    repository: m.repository,
    number: m.number,
    head: m.head,
    base: m.base,
    sourceRun: m.sourceRun,
    lines,
    history: normalizeSnapshot(m.history),
  };
}
export function createArtifact(
  metadata: JsonInput,
  input: JsonInput,
  origin: GenerationOrigin,
  usage: JsonInput,
): ReviewArtifact {
  const m = validateMetadata(metadata);
  if (!validOrigin(origin)) {
    throw new Error('生成元が不正です');
  }
  const prior = reviewHistory(m.history.issues, m.history.inline, m.head, m.base);
  const review = validReview(input, m.lines, prior);
  if (review.status !== 'complete') {
    throw new Error('未完了の結果は投稿できません');
  }
  const validUsage = (value: JsonInput): value is ReviewArtifact['usage'] =>
    value === null ||
    (isJsonObject(value) &&
      typeof value.input === 'number' &&
      typeof value.output === 'number' &&
      typeof value.total === 'number' &&
      [value.input, value.output, value.total].every((n) => Number.isSafeInteger(n) && n >= 0) &&
      value.total === value.input + value.output);
  if (!validUsage(usage)) {
    throw new Error('利用量が不正です');
  }
  const checkedUsage = usage;
  const resultHash = digest(JSON.stringify(review));
  const operations: Operation[] = [];
  function add(
    kind: Operation['kind'],
    target: string,
    body: string,
    extra?: Partial<Pick<Operation, 'path' | 'line' | 'replyTo'>>,
  ) {
    const id = digest(JSON.stringify([origin, resultHash, kind, target]));
    const text = [body, generationMarker(m, origin), operationMarker(id)].join('\n\n');
    if (text.length > 60_000) {
      throw new Error('GitHubコメント上限を超えました');
    }
    operations.push({ id, kind, body: text, bodyHash: digest(text), ...extra });
  }
  for (const [index, f] of review.findings.entries()) {
    add(
      'finding',
      String(index),
      [
        renderReview({ ...review, findings: [f], checks: [] }, m.head, m.base),
        historyMarker([f]),
      ].join('\n\n'),
      { path: f.path, line: f.line },
    );
  }
  for (const check of review.checks ?? []) {
    const original = requireValue(prior.find((f) => f.id === check.id));
    if (
      (latestFollowupStatus(original, m.history.issues, m.history.inline) ?? 'unfixed') ===
      check.status
    ) {
      continue;
    }
    const label = check.status === 'fixed' ? '☑️: 修正を確認しました' : '修正が確認できません';
    const reason =
      check.status === 'fixed' ? '修正済み' : check.status === 'unfixed' ? '未修正' : '確認不能';
    const anchor = original.replyTo
      ? `discussion_r${original.replyTo}`
      : `issuecomment-${check.id.split(':')[0]}`;
    add(
      'reply',
      check.id,
      [
        MARKER,
        `<!-- followup:${check.id}:${m.head}:${m.base} -->`,
        `<!-- followup-state:v1:${check.status} -->`,
        `対象: ${m.head} / base: ${m.base}`,
        `### ${label}`,
        `[元の指摘](https://github.com/${REPOSITORY}/pull/${m.number}#${anchor}) — ${safe(original.path)}:${original.line}`,
        `${reason}: ${safe(check.evidence)}`,
      ].join('\n\n'),
      original.replyTo ? { replyTo: original.replyTo } : {},
    );
  }
  const checks = review.checks ?? [];
  add(
    'summary',
    'complete',
    [
      renderReview({ ...review, findings: [], checks: [] }, m.head, m.base),
      `新規指摘${review.findings.length}件。修正済み${checks.filter((c) => c.status === 'fixed').length}件・未修正${checks.filter((c) => c.status === 'unfixed').length}件・確認不能${checks.filter((c) => c.status === 'unverified').length}件。`,
      '指摘は該当行、修正確認は元スレッド（旧指摘はリンク付きコメント）を参照してください。',
      historyMarker([]),
    ].join('\n\n'),
  );
  return {
    version: 2,
    origin,
    metadata: m,
    historyRevision: snapshotRevision(m.history),
    resultHash,
    review,
    operations,
    usage: checkedUsage,
    cost: null,
  };
}
export function validateArtifact(value: JsonInput, expected: GenerationOrigin): ReviewArtifact {
  if (
    !isJsonObject(value) ||
    value.version !== 2 ||
    !validOrigin(expected) ||
    JSON.stringify(value.origin) !== JSON.stringify(expected)
  ) {
    throw new Error('旧形式・生成元不一致のArtifactです');
  }
  const rebuilt = createArtifact(value.metadata, value.review, expected, value.usage);
  if (JSON.stringify(value) !== JSON.stringify(rebuilt)) {
    throw new Error('Artifactの改訂値・結果・投稿操作が不正です');
  }
  return rebuilt;
}
export function readArtifact(directory: string, expected: GenerationOrigin): ReviewArtifact {
  return validateArtifact(
    parseJson(readFileSync(join(directory, 'review-v2.json'), 'utf8')),
    expected,
  );
}
export function saveArtifact(directory: string, value: ReviewArtifact): void {
  writeFileSync(
    join(directory, 'review-v2.json'),
    JSON.stringify(validateArtifact(value, value.origin)),
  );
}
