import { ReviewFailure } from './failure.ts';
import { builtinModules } from 'node:module';
import { posix } from 'node:path';
import { digest, resolveReference } from './source-index.ts';
import type { Source, SourceIndex } from './source-index.ts';
import type { Material } from './material.ts';

export interface Patch {
  path: string;
  patch: string;
}
export interface Obligation {
  id: string;
  kind: 'unit' | 'boundary' | 'history';
  sources: string[];
  patch?: Patch;
  priorId?: string;
}
export interface ReviewTask {
  id: string;
  kind: Obligation['kind'] | 'reconcile';
  sources: string[];
  obligations: string[];
  priorIds: string[];
  candidateIds?: string[];
}
export interface ReviewPlan {
  version: 1;
  metadata: Material;
  sources: Source[];
  obligations: Obligation[];
  tasks: ReviewTask[];
  excluded: string[];
}
const unique = <T>(values: T[]): T[] => [...new Set(values)];
export function taskData(plan: ReviewPlan, task: ReviewTask) {
  return {
    task,
    metadata: { ...plan.metadata, priorFindings: plan.metadata.priorFindings ?? [] },
    sources: plan.sources.filter((s) => task.sources.includes(s.id)),
    obligations: plan.obligations.filter((o) => task.obligations.includes(o.id)),
    excluded: plan.excluded,
  };
}
export function taskFits(plan: ReviewPlan, task: ReviewTask): boolean {
  const data = taskData(plan, task);
  const raw =
    data.sources.reduce((sum, s) => sum + Buffer.byteLength(s.content), 0) +
    data.obligations.reduce((sum, o) => sum + Buffer.byteLength(o.patch?.patch ?? ''), 0);
  return raw <= 300_000 && Buffer.byteLength(JSON.stringify(data)) <= 400_000;
}

function splitHunk(
  hunk: string,
  sources: Source[],
  metadata: Material,
): { patch: string; sources: string[] }[] {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(hunk);
  if (!match) return [{ patch: hunk, sources: sources.map((s) => s.id) }];
  let oldLine = Number(match[1]),
    newLine = Number(match[3]);
  const parts: {
    lines: string[];
    sources: string[];
    oldStart: number;
    newStart: number;
    oldCount: number;
    newCount: number;
  }[] = [];
  for (const line of hunk.split('\n').slice(1)) {
    if (!line) continue;
    const oldCount = line[0] === '-' || line[0] === ' ' ? 1 : 0;
    const newCount = line[0] === '+' || line[0] === ' ' ? 1 : 0;
    const ids = sources
      .filter(
        (s) =>
          (oldCount &&
            s.revisions.includes(metadata.ancestor ?? metadata.base) &&
            s.start <= oldLine &&
            s.end >= oldLine) ||
          (newCount &&
            s.revisions.includes(metadata.head) &&
            s.start <= newLine &&
            s.end >= newLine),
      )
      .map((s) => s.id)
      .sort();
    let part = parts.at(-1);
    if (!part || ((oldCount || newCount) && JSON.stringify(part.sources) !== JSON.stringify(ids))) {
      part = {
        lines: [],
        sources: ids,
        oldStart: oldLine,
        newStart: newLine,
        oldCount: 0,
        newCount: 0,
      };
      parts.push(part);
    }
    part.lines.push(line);
    part.oldCount += oldCount;
    part.newCount += newCount;
    oldLine += oldCount;
    newLine += newCount;
  }
  return parts.map((part) => ({
    sources: part.sources,
    patch: `@@ -${part.oldStart},${part.oldCount} +${part.newStart},${part.newCount} @@\n${part.lines.join('\n')}\n`,
  }));
}

export function planReview(metadata: Material, index: SourceIndex, patches: Patch[]): ReviewPlan {
  if ((metadata.priorFindings?.length ?? 0) > 30)
    throw new ReviewFailure('BUDGET_EXCEEDED', '履歴上限を超えました');
  const plan: ReviewPlan = {
    version: 1,
    metadata,
    sources: [],
    obligations: [],
    tasks: [],
    excluded: index.excluded,
  };
  const allSources = new Map<string, Source>();
  for (const file of index.files)
    for (const source of file.sources) {
      const existing = allSources.get(source.id);
      allSources.set(source.id, {
        ...source,
        revisions: unique([...(existing?.revisions ?? []), ...source.revisions]),
      });
    }
  const sourcesFor = (path: string) =>
    unique(index.files.filter((f) => f.path === path).flatMap((f) => f.sources.map((s) => s.id)));
  const add = (
    kind: Obligation['kind'],
    sources: string[],
    extra: Pick<Obligation, 'patch' | 'priorId'> = {},
  ) => {
    sources = unique(sources).sort();
    const id = digest(JSON.stringify({ kind, sources, ...extra })).slice(0, 16);
    if (plan.obligations.length >= 5000)
      throw new ReviewFailure('BUDGET_EXCEEDED', '確認対象の索引上限を超えました');
    if (!plan.obligations.some((o) => o.id === id))
      plan.obligations.push({ id, kind, sources, ...extra });
  };
  const roots = unique([
    ...patches.map((p) => p.path),
    ...(metadata.priorFindings ?? []).map((p) => p.path),
  ]);
  const relevant = new Set(roots);
  const edges: { from: string; to: string; revision: string }[] = [];
  const allEdges: typeof edges = [];
  const unresolved = new Set<string>();
  const packages = new Set<string>();
  for (const file of index.files.filter((f) => /(^|\/)package\.json$/.test(f.path))) {
    const data = JSON.parse(file.sources.map((s) => s.content).join('')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    for (const [name, version] of Object.entries({ ...data.dependencies, ...data.devDependencies }))
      if (
        typeof version === 'string' &&
        !version.startsWith('workspace:') &&
        !version.startsWith('file:')
      )
        packages.add(name);
  }
  for (const file of index.files)
    for (const revision of file.revisions) {
      if (file.unresolved.length) unresolved.add(file.path);
      for (const ref of file.references) {
        if (!ref.startsWith('.') && !ref.startsWith('/')) {
          const name = ref.startsWith('@')
            ? ref.split('/').slice(0, 2).join('/')
            : ref.split('/')[0];
          if (!ref.startsWith('node:') && !builtinModules.includes(ref) && !packages.has(name))
            unresolved.add(file.path);
          continue; // npm / node: の外部パッケージ本文は取得しない。
        }
        const resolved = resolveReference(file.path, ref, index.files, revision);
        if (!resolved) {
          const excludedPath = posix.normalize(
            ref.startsWith('/') ? ref.slice(1) : posix.join(posix.dirname(file.path), ref),
          );
          if (!(file.path.endsWith('.md') && index.excluded.includes(excludedPath)))
            unresolved.add(file.path);
          continue;
        }
        allEdges.push({ from: file.path, to: resolved, revision });
        if (roots.includes(file.path) || roots.includes(resolved)) {
          edges.push({ from: file.path, to: resolved, revision });
          relevant.add(file.path);
          relevant.add(resolved);
        }
      }
    }
  // 規約は信頼済みの固定パス。PR内設定から対象や容量を緩められない。
  const contracts = ['AGENTS.md', 'CODING_STANDARDS.md', 'GLOSSARY.md'];
  if (
    roots.some((p) => p.startsWith('tools/ai-review/') || p === '.github/workflows/ai-review.yml')
  )
    contracts.push('docs/spec/ai-review.md', 'docs/spec/ai-review-partitioning.md');
  else if (roots.some((p) => p.startsWith('src/')))
    contracts.push(
      'docs/spec/mvp.md',
      ...index.files.filter((f) => f.path.startsWith('docs/adr/')).map((f) => f.path),
    );
  for (const path of unique(contracts))
    if (sourcesFor(path).length) {
      relevant.add(path);
      for (const root of roots)
        if (root !== path) edges.push({ from: root, to: path, revision: metadata.head });
    }
  // Workflow → package script → CLIは一つの明示的な呼び出しとして追う。
  // 一般のコード依存を無制限に再帰展開しない。
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const edge of allEdges) {
      if (
        /(^|\/)package\.json$/.test(edge.from) &&
        relevant.has(edge.from) &&
        !edges.some((e) => e.from === edge.from && e.to === edge.to && e.revision === edge.revision)
      ) {
        edges.push(edge);
        if (!relevant.has(edge.to)) {
          relevant.add(edge.to);
          expanded = true;
        }
      }
    }
  }
  if ([...relevant].some((p) => unresolved.has(p)))
    throw new ReviewFailure('UNRESOLVED_REFERENCE', '関連資料に未解決の参照があります');
  for (const path of roots) {
    if (!sourcesFor(path).length && index.excluded.includes(path))
      throw new ReviewFailure('MISSING_EVIDENCE', '必須資料が除外されています');
  }
  for (const patch of [...patches].sort((a, b) => a.path.localeCompare(b.path))) {
    const sources = sourcesFor(patch.path);
    const hunks = patch.patch.split(/(?=^@@ )/m).filter((p) => p.startsWith('@@'));
    if (!hunks.length) hunks.push(patch.patch);
    for (const hunk of hunks) {
      for (const part of splitHunk(
        hunk,
        sources.map((id) => allSources.get(id)!),
        metadata,
      ))
        add('unit', part.sources, { patch: { path: patch.path, patch: part.patch } });
    }
    // 同一ファイルの周辺宣言も確認する。巨大な単一宣言は分割しない。
    for (const id of sources)
      if (!plan.obligations.some((o) => o.sources.includes(id))) add('unit', [id]);
  }
  for (const edge of edges) {
    const from = sourcesFor(edge.from),
      to = sourcesFor(edge.to);
    // 宣言間の関係を切り捨てない。巨大な関係数は課金前の予算検証で止める。
    if (from.length * to.length > 2000)
      throw new ReviewFailure('BUDGET_EXCEEDED', '境界の容量上限を超えました');
    for (const left of from) for (const right of to) add('boundary', [left, right]);
  }
  for (const prior of metadata.priorFindings ?? []) {
    const ids = unique([
      ...sourcesFor(prior.path),
      ...edges
        .filter((e) => e.from === prior.path || e.to === prior.path)
        .flatMap((e) => [...sourcesFor(e.from), ...sourcesFor(e.to)]),
    ]);
    if (!ids.length) throw new ReviewFailure('MISSING_EVIDENCE', '過去指摘の必須資料がありません');
    add('history', ids, { priorId: prior.id });
  }
  plan.sources = [...allSources.values()]
    .filter((s) => plan.obligations.some((o) => o.sources.includes(s.id)))
    .sort((a, b) => a.id.localeCompare(b.id));
  if (!plan.obligations.length) add('unit', []); // 除外変更だけでも確認範囲をモデルへ伝える。
  for (const kind of ['unit', 'boundary', 'history'] as const) {
    const pending = plan.obligations.filter((o) => o.kind === kind);
    while (pending.length) {
      const task: ReviewTask = {
        id: `task-${plan.tasks.length + 1}`,
        kind,
        sources: [],
        obligations: [],
        priorIds: [],
      };
      while (pending.length) {
        pending.sort(
          (a, b) =>
            b.sources.filter((id) => task.sources.includes(id)).length -
              a.sources.filter((id) => task.sources.includes(id)).length ||
            a.id.localeCompare(b.id),
        );
        const next = pending[0];
        const candidate = {
          ...task,
          sources: unique([...task.sources, ...next.sources]),
          obligations: [...task.obligations, next.id],
          priorIds: unique([...task.priorIds, ...(next.priorId ? [next.priorId] : [])]),
        };
        if (
          candidate.obligations.length > 200 ||
          !taskFits(plan, candidate) ||
          (kind === 'boundary' &&
            Buffer.byteLength(JSON.stringify(taskData(plan, candidate))) > 250_000)
        ) {
          if (!task.obligations.length)
            throw new ReviewFailure(
              'BUDGET_EXCEEDED',
              '分割できない確認対象が容量上限を超えました',
            );
          break;
        }
        Object.assign(task, candidate);
        pending.shift();
      }
      plan.tasks.push(task);
    }
  }
  validatePlan(plan);
  return plan;
}

export function validatePlan(plan: ReviewPlan): ReviewPlan {
  if (
    !plan ||
    plan.version !== 1 ||
    !plan.metadata ||
    !Array.isArray(plan.sources) ||
    !Array.isArray(plan.tasks) ||
    !Array.isArray(plan.obligations) ||
    !Array.isArray(plan.excluded) ||
    !plan.excluded.every((p) => typeof p === 'string') ||
    plan.tasks.length < 1
  )
    throw new Error('作業台帳の形式が不正です');
  if (
    !/^[a-f0-9]{40}$/.test(plan.metadata.head) ||
    !/^[a-f0-9]{40}$/.test(plan.metadata.base) ||
    !Number.isSafeInteger(plan.metadata.number) ||
    plan.metadata.number < 1
  )
    throw new Error('対象が不正です');
  const ids = new Set<string>();
  for (const s of plan.sources) {
    if (
      !s ||
      typeof s.path !== 'string' ||
      typeof s.content !== 'string' ||
      !Number.isSafeInteger(s.start) ||
      s.start < 1 ||
      !Number.isSafeInteger(s.end) ||
      s.end < s.start ||
      !Array.isArray(s.revisions) ||
      !s.revisions.length ||
      !s.revisions.every(
        (r) => r === plan.metadata.base || r === plan.metadata.head || r === plan.metadata.ancestor,
      ) ||
      s.id !== digest(`${s.path}:${s.start}:${s.content}`) ||
      ids.has(s.id)
    )
      throw new Error('資料の形式またはハッシュが不正です');
    ids.add(s.id);
  }
  const assigned: string[] = [];
  for (const o of plan.obligations) {
    if (
      !o ||
      !['unit', 'boundary', 'history'].includes(o.kind) ||
      !Array.isArray(o.sources) ||
      o.sources.some((id) => !ids.has(id)) ||
      o.id !==
        digest(
          JSON.stringify({
            kind: o.kind,
            sources: o.sources,
            ...(o.patch ? { patch: o.patch } : {}),
            ...(o.priorId ? { priorId: o.priorId } : {}),
          }),
        ).slice(0, 16)
    )
      throw new Error('確認対象が不正です');
  }
  for (const task of plan.tasks) {
    if (
      !task ||
      !Array.isArray(task.obligations) ||
      !task.obligations.length ||
      !Array.isArray(task.sources) ||
      !Array.isArray(task.priorIds) ||
      task.sources.some((id) => !ids.has(id)) ||
      !taskFits(plan, task)
    )
      throw new Error('作業の容量または形式が不正です');
    const obligations = task.obligations.map((id) => plan.obligations.find((o) => o.id === id));
    if (
      obligations.some(
        (o) => !o || o.kind !== task.kind || o.sources.some((id) => !task.sources.includes(id)),
      ) ||
      JSON.stringify(unique(obligations.flatMap((o) => (o?.priorId ? [o.priorId] : []))).sort()) !==
        JSON.stringify([...task.priorIds].sort())
    )
      throw new Error('担当対象が不正です');
    assigned.push(...task.obligations);
  }
  if (
    new Set(plan.tasks.map((t) => t.id)).size !== plan.tasks.length ||
    new Set(assigned).size !== assigned.length ||
    assigned.length !== plan.obligations.length ||
    new Set(plan.obligations.map((o) => o.id)).size !== plan.obligations.length
  )
    throw new Error('確認対象の割り当てが欠落または重複しています');
  const priorIds = (plan.metadata.priorFindings ?? []).map((p) => p.id).sort();
  if (
    priorIds.length > 30 ||
    JSON.stringify(priorIds) !== JSON.stringify(plan.tasks.flatMap((t) => t.priorIds).sort())
  )
    throw new Error('過去指摘の割り当てが不正です');
  return plan;
}
