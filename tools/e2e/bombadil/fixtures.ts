import { parseJson } from '@korekaite/api-contracts/json';
import { createHash } from 'node:crypto';
import type { components } from '@korekaite/api-contracts/http';
import type {
  interviews,
  transcriptFragments,
  evaluationInputs,
  EvaluationSnapshot,
} from '@korekaite/database/interviews';
import type { jobs, jobAttempts } from '@korekaite/database/jobs';

export type ExplorationFixtures = {
  version: 1;
  seed: string;
  interviews: {
    key: 'a' | 'b';
    id: string;
    jobId: string;
    createdAt: number;
    theme: string;
    statement: string;
    summary: string;
  }[];
};

export function createFixtures(seed: string): ExplorationFixtures {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(seed)) {
    throw new Error('fixtureのseedはUUID v4で指定してください。');
  }
  return {
    version: 1,
    seed,
    interviews: (['a', 'b'] as const).map((key, index) => {
      const hash = createHash('sha256').update(`${seed}:${key}`).digest('hex');
      return {
        key,
        id: `explore-${key}-${seed}`,
        jobId: `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`,
        createdAt: 1_700_000_000_000 + index,
        theme: key === 'a' ? '架空図書館の検索改善' : '架空菜園の水やり改善',
        statement:
          key === 'a' ? '私は蔵書の索引を追加しました。' : '私は土の乾き具合で給水を決めました。',
        summary:
          key === 'a' ? '索引を選んだ理由を確認しました。' : '給水間隔を選んだ理由を確認しました。',
      };
    }),
  };
}

export function parseFixtures(text: string): ExplorationFixtures {
  const parsed = parseJson(text);
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    typeof parsed.seed !== 'string'
  ) {
    throw new Error('fixtureの形式が不正です。');
  }
  const canonical = createFixtures(parsed.seed);
  if (JSON.stringify(parsed) !== JSON.stringify(canonical)) {
    throw new Error('fixtureが採用版の初期データと一致しません。');
  }
  return canonical;
}

// 探索用の固定行だけに使う。キーはDrizzleのinsert型で検査し、列名は正式migrationで検証する。
function insert(table: string, row: Record<string, string | number | boolean | object>) {
  const columns = Object.keys(row).map((name) =>
    name.replaceAll(/[A-Z]/gu, (char) => `_${char.toLowerCase()}`),
  );
  const values = Object.values(row).map((value) => {
    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(Number(value));
    }
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return `'${text.replaceAll("'", "''")}'`;
  });
  return `INSERT INTO ${table} (${columns.join(',')}) VALUES (${values.join(',')});`;
}

export function fixtureSql(fixture: ExplorationFixtures): string {
  const verified = parseFixtures(JSON.stringify(fixture));
  return verified.interviews
    .map((record) => {
      const interview = {
        interviewId: record.id,
        actorId: 'local-developer',
        materialHash: createHash('sha256').update(record.statement).digest('hex'),
        themeTitle: record.theme,
        themeHeading: '架空の判断',
        themeExcerpt: record.statement,
        background: '探索専用の架空データ',
        status: 'ended',
        activeMs: 1000,
        createdAt: record.createdAt,
        updatedAt: record.createdAt,
        endedAt: record.createdAt,
      } satisfies typeof interviews.$inferInsert;
      const fragment = {
        fragmentId: `fragment-${record.id}`,
        interviewId: record.id,
        sequence: 1,
        generation: 1,
        sourceEventId: `event-${record.id}`,
        startsQuestion: false,
        speaker: 'user',
        content: record.statement,
        receivedAt: record.createdAt,
        sourceStartMs: 0,
        sourceEndMs: 1000,
      } satisfies typeof transcriptFragments.$inferInsert;
      const snapshot: EvaluationSnapshot = {
        schemaVersion: 1,
        interview,
        fragments: [fragment],
        playback: [],
        transcriptIncomplete: false,
        evaluation: {
          model: 'fixture',
          promptVersion: 'fixture-v1',
          rubricVersion: 'fixture-v1',
          instructions: '架空の発言だけを確認する。',
          rubric: '探索用の固定評価。',
        },
      };
      const axis: components['schemas']['EvaluationAxis'] = {
        status: 'unconfirmed',
        score: null,
        reason: '探索用のため採点しない。',
        evidence: [],
      };
      const evaluation: components['schemas']['InterviewEvaluation'] = {
        summary: record.summary,
        axes: { problem: axis, alternatives: axis, reasoning: axis, action: axis, learning: axis },
        strengths: [],
        gaps: [],
        unconfirmed: [],
        practiceQuestions: [],
        consistency: [],
      };
      return [
        insert('interviews', interview),
        insert('transcript_fragments', fragment),
        insert('jobs', {
          jobId: record.jobId,
          actorId: interview.actorId,
          purpose: 'evaluation',
          status: 'completed',
          attemptCount: 1,
          acceptedAt: record.createdAt,
          updatedAt: record.createdAt,
          finishedAt: record.createdAt,
        } satisfies typeof jobs.$inferInsert),
        insert('evaluation_inputs', {
          jobId: record.jobId,
          interviewId: record.id,
          kind: 'initial',
          lastSequence: 1,
          inputJson: snapshot,
          model: snapshot.evaluation.model,
          promptVersion: snapshot.evaluation.promptVersion,
          rubricVersion: snapshot.evaluation.rubricVersion,
          createdAt: record.createdAt,
        } satisfies typeof evaluationInputs.$inferInsert),
        insert('job_attempts', {
          jobId: record.jobId,
          attemptNumber: 1,
          startedAt: record.createdAt,
          finishedAt: record.createdAt,
          resultJson: JSON.stringify(evaluation),
        } satisfies typeof jobAttempts.$inferInsert),
      ].join('\n');
    })
    .join('\n');
}
