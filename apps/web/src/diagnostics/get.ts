import { validateCheckJobId } from '@korekaite/api-contracts/http/diagnostics-validators';
import { findDiagnosticJob } from '../server/repositories/diagnostic-jobs';
import type { CheckDependencies } from './accept';
import { validationResponse } from './errors';

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
    if (!status)
      return Response.json(
        { error: { code: 'JOB_NOT_FOUND', message: '対象ジョブが見つかりません。', requestId } },
        { status: 404, headers },
      );
    return Response.json(status, { headers });
  } catch {
    return Response.json(
      {
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: '状態を取得できません。時間をおいて再度確認してください。',
          requestId,
        },
      },
      { status: 503, headers },
    );
  }
}
