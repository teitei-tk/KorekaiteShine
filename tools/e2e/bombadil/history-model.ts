import { requireValue } from './required.ts';
import type { components } from '@korekaite/api-contracts/http';
import type { ExplorationFixtures } from './fixtures.ts';
export type HistoryRequest = {
  method: 'GET' | 'DELETE';
  id: string | null;
  started: number;
  finished: number | null;
  status: number | null;
  confirmedId?: string;
  generation?: number;
  history?: {
    items: Pick<components['schemas']['InterviewHistory']['items'][number], 'interviewId'>[];
  };
};
export type DeletionCancellation = {
  id: string;
  opened: number;
  cancelled: number;
  checkedAt: number | null;
};
export type HistoryObservation = {
  listedIds: string[] | null;
  detail: {
    selectedId: string;
    theme: string;
    statements: string[];
    summary: string | null;
  } | null;
  requests: HistoryRequest[];
  cancellations: DeletionCancellation[];
};
export function historyIssues(
  observation: HistoryObservation,
  fixtures?: ExplorationFixtures,
): string[] {
  const issues: string[] = [];
  if (
    observation.requests.some(
      (request) => request.method === 'DELETE' && request.confirmedId !== request.id,
    )
  ) {
    issues.push('unconfirmed-deletion');
  }
  const deleted = observation.requests.filter(
    (request) => request.method === 'DELETE' && request.status === 204 && request.finished !== null,
  );
  if (
    deleted.some(
      (request) =>
        request.id !== null &&
        ((observation.listedIds?.includes(request.id) ?? false) ||
          observation.detail?.selectedId === request.id),
    )
  ) {
    issues.push('deleted-interview-visible');
  }
  if (
    deleted.some((deletion) =>
      observation.requests.some(
        (request) =>
          request.method === 'GET' &&
          request.status === 200 &&
          request.finished !== null &&
          request.started > requireValue(deletion.finished) &&
          (request.id === deletion.id ||
            request.history?.items.some((item) => item.interviewId === deletion.id)),
      ),
    )
  ) {
    issues.push('deleted-interview-returned');
  }
  if (observation.detail) {
    const { detail } = observation;
    const expected = fixtures?.interviews.find((interview) => interview.id === detail.selectedId);
    if (!expected) {
      issues.push('unknown-interview');
    } else if (
      detail.theme !== expected.theme ||
      detail.summary !== expected.summary ||
      detail.statements.length !== 1 ||
      detail.statements[0] !== expected.statement
    ) {
      issues.push('mixed-interview-detail');
    }
  }
  if (
    observation.cancellations.some((cancel) =>
      observation.requests.some(
        (request) =>
          request.method === 'DELETE' &&
          request.started >= cancel.opened &&
          (cancel.checkedAt === null || request.started <= cancel.checkedAt),
      ),
    )
  ) {
    issues.push('delete-during-cancellation');
  }
  if (
    observation.cancellations.some((cancel) =>
      observation.requests.some(
        (request) =>
          request.method === 'GET' &&
          request.id === cancel.id &&
          request.status === 404 &&
          request.started >= cancel.cancelled &&
          request.finished !== null &&
          cancel.checkedAt !== null &&
          request.finished <= cancel.checkedAt,
      ),
    )
  ) {
    issues.push('cancelled-record-missing');
  }
  return issues;
}
