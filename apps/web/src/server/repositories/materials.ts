import { and, eq, gt } from 'void/db';
import { materialAnalyses } from '@korekaite/database/materials';
import type { createPrimaryDb } from '@korekaite/database/connection';
import type { components } from '@korekaite/api-contracts/http';
import { validateMaterialAnalysisResult } from '@korekaite/api-contracts/http/materials-validators';

type Database = ReturnType<typeof createPrimaryDb>;
type Analysis = typeof materialAnalyses.$inferInsert;
interface SaveAnalysis extends Omit<Analysis, 'materialHash' | 'candidatesJson'> {
  markdown: string;
  result: components['schemas']['MaterialAnalysisResult'];
}

export async function saveMaterialAnalysis(db: Database, input: SaveAnalysis): Promise<void> {
  if (!validateMaterialAnalysisResult(input.result)) {
    throw new Error('分析候補の保存形式が不正です。');
  }
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input.markdown));
  const materialHash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  await db.insert(materialAnalyses).values({
    analysisId: input.analysisId,
    actorId: input.actorId,
    materialHash,
    candidatesJson: JSON.stringify(input.result),
    model: input.model,
    promptVersion: input.promptVersion,
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
  });
}

export async function findMaterialTheme(
  db: Database,
  actorId: string,
  analysisId: string,
  themeIndex: number,
  now: number,
): Promise<{ materialHash: string; theme: components['schemas']['MaterialTheme'] } | null> {
  if (!Number.isSafeInteger(themeIndex) || themeIndex < 0) {
    return null;
  }
  const [row] = await db
    .select()
    .from(materialAnalyses)
    .where(
      and(
        eq(materialAnalyses.analysisId, analysisId),
        eq(materialAnalyses.actorId, actorId),
        gt(materialAnalyses.expiresAt, now),
      ),
    );
  if (!row) {
    return null;
  }
  const candidates = JSON.parse(row.candidatesJson);
  if (!validateMaterialAnalysisResult(candidates)) {
    throw new Error('保存された分析候補が不正です。');
  }
  const theme = candidates.themes[themeIndex];
  return theme ? { materialHash: row.materialHash, theme } : null;
}
