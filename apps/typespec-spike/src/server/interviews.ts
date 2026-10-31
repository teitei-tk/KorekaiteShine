import type { components } from '../../generated/api';
import { validateQuery } from '../../generated/validators.mjs';

const interviews: components['schemas']['Interview'][] = [
  {
    id: 'interview-001',
    theme: '接続状態をDOで管理した判断',
    startedAt: '2026-10-29T01:00:00Z',
    materialKind: 'experience',
    durationSeconds: 600,
    evaluationStatus: 'running',
  },
  {
    id: 'interview-002',
    theme: '評価処理をQueueへ分離した判断',
    startedAt: '2026-10-30T01:00:00Z',
    materialKind: 'code',
    durationSeconds: 900,
    evaluationStatus: 'waiting',
  },
];

export function listInterviews(request: Request): Response {
  const parameters = new URL(request.url).searchParams;
  const query = Object.fromEntries(
    [...parameters].map(([key, value]) => [
      key,
      value.length > 0 && !/[^0-9]/u.test(value) ? Number(value) : value,
    ]),
  );
  if (parameters.getAll('limit').length > 1 || !validateQuery(query)) {
    return Response.json(
      { code: 'INVALID_QUERY', message: 'limitは1〜20の整数で指定してください。' },
      { status: 400 },
    );
  }
  const limit = query.limit ?? 20;
  const items = [...interviews]
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
    .slice(0, limit);
  return Response.json({ items });
}
