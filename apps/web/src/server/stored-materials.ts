import type { createPrimaryDb } from '@korekaite/database/connection';
import type { MaterialAnalysisDependencies } from '../application/analyze-material';
import { analyzeMaterialRequest } from './materials';
import { createMaterialAnalyzer, materialPromptVersion } from './openai-material-analyzer';
import { saveMaterialAnalysis } from './repositories/materials';
import { reserveAnalysis } from './repositories/analysis-usage';

export function analyzeStoredMaterialRequest(
  request: Request,
  deps: {
    db: ReturnType<typeof createPrimaryDb>;
    actor(request: Request): string | null;
    now(): number;
    newId(): string;
    apiKey: string;
    model: string;
    analyze?: MaterialAnalysisDependencies['analyze'];
  },
): Promise<Response> {
  const actorId = deps.actor(request);
  function authenticatedActorId(): string {
    if (!actorId) {
      throw new Error('本人確認が必要です。');
    }
    return actorId;
  }
  const analysisId = deps.newId();
  return analyzeMaterialRequest(request, {
    authorize: () => actorId !== null,
    analyze: deps.analyze ?? createMaterialAnalyzer({ apiKey: deps.apiKey, model: deps.model }),
    reserveAnalysis: async () => {
      if (!deps.apiKey.trim() || !deps.model.trim()) {
        throw new Error('分析設定が不足しています。');
      }
      return reserveAnalysis(deps.db, {
        reservationId: analysisId,
        actorId: authenticatedActorId(),
        now: deps.now(),
      });
    },
    saveAnalysis: async (markdown, result) => {
      const now = deps.now();
      await saveMaterialAnalysis(deps.db, {
        analysisId,
        actorId: authenticatedActorId(),
        markdown,
        result,
        model: deps.model,
        promptVersion: materialPromptVersion,
        createdAt: now,
        expiresAt: now + 24 * 60 * 60 * 1000,
      });
      return analysisId;
    },
  });
}
