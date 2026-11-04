import { DiagnosticDatabaseError } from '../server/repositories/database-error';
import { validateCheckJobId } from '@korekaite/api-contracts/http/diagnostics-validators';
import { findDiagnosticJob } from '../server/repositories/diagnostic-jobs';
import type { CheckDependencies } from './accept';
import { errorResponse, validationResponse } from './errors';

export async function getCheck(
  _request: Request,
  jobId: string,
  deps: CheckDependencies,
): Promise<Response> {
  const requestId = deps.newId();
  const headers = { 'Cache-Control': 'no-store' };
  if (!validateCheckJobId(jobId)) {
    return validationResponse(requestId, [
      {
        location: 'path',
        path: 'jobId',
        code: 'INVALID_FORMAT',
        message: 'ジョブIDを確認してください。',
      },
    ]);
  }
  try {
    const status = await findDiagnosticJob(deps, jobId);
    if (!status) {
      return errorResponse(requestId, 'JOB_NOT_FOUND', '対象ジョブが見つかりません。');
    }
    return Response.json(status, { headers });
  } catch (error) {
    if (!(error instanceof DiagnosticDatabaseError)) {
      return errorResponse(requestId, 'INTERNAL_ERROR', '内部エラーが発生しました。');
    }
    return errorResponse(
      requestId,
      'SERVICE_UNAVAILABLE',
      '状態を取得できません。時間をおいて再度確認してください。',
    );
  }
}
