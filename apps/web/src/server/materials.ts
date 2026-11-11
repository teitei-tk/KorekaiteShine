import { readJsonBody } from './json-body';
import type { components } from '@korekaite/api-contracts/http';
import {
  validateMaterialErrorBody,
  validateSavedMaterialAnalysis,
} from '@korekaite/api-contracts/http/materials-validators';
import {
  analyzeMaterial,
  readMaterialInput,
  type MaterialAnalysisDependencies,
} from '../application/analyze-material';

interface MaterialHttpDependencies extends MaterialAnalysisDependencies {
  authorize(request: Request): boolean;
  reserveAnalysis(): Promise<boolean>;
  saveAnalysis(
    markdown: string,
    result: components['schemas']['MaterialAnalysisResult'],
  ): Promise<string>;
}

type ErrorCode = components['schemas']['MaterialErrorBody']['error']['code'];
const errors: Record<ErrorCode, readonly [number, string]> = {
  INVALID_MATERIAL: [400, '送信内容と確認操作を確認してください。'],
  FORBIDDEN: [403, 'この要求は許可されていません。'],
  MATERIAL_TOO_LARGE: [413, '材料を32KiB以内にしてください。'],
  UNSUPPORTED_MEDIA_TYPE: [415, 'JSON形式で送信してください。'],
  USAGE_LIMIT: [429, '材料分析の利用上限に達しました。'],
  INVALID_AI_RESULT: [502, '材料の根拠を確認できる分析結果を取得できませんでした。'],
  AI_UNAVAILABLE: [503, '材料分析を利用できません。設定と接続を確認してください。'],
  ANALYSIS_SAVE_FAILED: [503, '分析結果を保存できませんでした。再度お試しください。'],
};

function errorResponse(code: ErrorCode): Response {
  const [status, message] = errors[code];
  const body = { error: { code, message } };
  if (!validateMaterialErrorBody(body)) {
    throw new Error('材料分析のエラー契約が不正です。');
  }
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

export async function analyzeMaterialRequest(
  request: Request,
  deps: MaterialHttpDependencies,
): Promise<Response> {
  if (!deps.authorize(request)) {
    return errorResponse('FORBIDDEN');
  }
  // JSONのUnicodeエスケープを許容しつつ、読み取る本文のバイト数を制限する。
  const body = await readJsonBody(request, 200_000);
  if (!body.ok) {
    const errors = {
      UNSUPPORTED_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE',
      REQUEST_TOO_LARGE: 'MATERIAL_TOO_LARGE',
      INVALID_REQUEST: 'INVALID_MATERIAL',
    } as const;
    return errorResponse(errors[body.code]);
  }
  const input = body.value;
  const checked = readMaterialInput(
    typeof input === 'object' && !Array.isArray(input) ? input : null,
  );
  if (!checked.ok) {
    return errorResponse(checked.code);
  }
  try {
    if (!(await deps.reserveAnalysis())) {
      return errorResponse('USAGE_LIMIT');
    }
    const result = await analyzeMaterial(checked.value, deps);
    if (!result.ok) {
      return errorResponse(result.code);
    }
    try {
      const analysisId = await deps.saveAnalysis(checked.value.markdown, result.value);
      const saved = { ...result.value, analysisId };
      if (!validateSavedMaterialAnalysis(saved)) {
        return errorResponse('ANALYSIS_SAVE_FAILED');
      }
      return Response.json(saved, { headers: { 'Cache-Control': 'no-store' } });
    } catch {
      return errorResponse('ANALYSIS_SAVE_FAILED');
    }
  } catch {
    return errorResponse('AI_UNAVAILABLE');
  }
}
