import { sql } from 'void/db';
import { check, integer, sqliteTable, text, uniqueIndex } from 'void/schema-d1';
import { jobs } from './jobs.ts';

export const interviews = sqliteTable(
  'interviews',
  {
    interviewId: text('interview_id').primaryKey(),
    actorId: text('actor_id').notNull(),
    // 分析候補の期限・削除後も開始要求の再送を照合する。候補へのFKは持たない。
    analysisId: text('analysis_id'),
    themeIndex: integer('theme_index'),
    materialHash: text('material_hash').notNull(),
    themeTitle: text('theme_title').notNull(),
    themeHeading: text('theme_heading').notNull(),
    themeExcerpt: text('theme_excerpt').notNull(),
    background: text('background').notNull(),
    status: text('status', {
      enum: ['ready', 'connecting', 'active', 'paused', 'reconnecting', 'ending', 'ended'],
    }).notNull(),
    revision: integer('revision').notNull().default(0),
    generation: integer('generation').notNull().default(0),
    streamGeneration: integer('stream_generation'),
    transcriptIncomplete: integer('transcript_incomplete', { mode: 'boolean' })
      .notNull()
      .default(false),
    activeMs: integer('active_ms').notNull().default(0),
    activeSince: integer('active_since'),
    deadline: integer('deadline'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    endedAt: integer('ended_at'),
  },
  (table) => [
    uniqueIndex('interviews_one_open_per_actor')
      .on(table.actorId)
      .where(sql`${table.status} != 'ended'`),
    check(
      'interviews_status',
      sql`${table.status} IN ('ready', 'connecting', 'active', 'paused', 'reconnecting', 'ending', 'ended')`,
    ),
    check(
      'interviews_counters',
      sql`typeof(${table.revision}) = 'integer' AND ${table.revision} >= 0
        AND typeof(${table.generation}) = 'integer' AND ${table.generation} >= 0
        AND typeof(${table.activeMs}) = 'integer' AND ${table.activeMs} BETWEEN 0 AND 1200000`,
    ),
  ],
);

// 原文断片は追記専用。再接続後の上流IDと面接全体の順序を分ける。
export const transcriptFragments = sqliteTable(
  'transcript_fragments',
  {
    fragmentId: text('fragment_id').primaryKey(),
    interviewId: text('interview_id')
      .notNull()
      .references(() => interviews.interviewId),
    sequence: integer('sequence').notNull(),
    generation: integer('generation').notNull(),
    sourceEventId: text('source_event_id').notNull(),
    speaker: text('speaker', { enum: ['user', 'assistant'] }).notNull(),
    content: text('content').notNull(),
    sourceStartMs: integer('source_start_ms'),
    sourceEndMs: integer('source_end_ms'),
    receivedAt: integer('received_at').notNull(),
  },
  (table) => [
    uniqueIndex('transcript_fragments_sequence').on(table.interviewId, table.sequence),
    uniqueIndex('transcript_fragments_source').on(
      table.interviewId,
      table.generation,
      table.sourceEventId,
    ),
    check('transcript_fragments_speaker', sql`${table.speaker} IN ('user', 'assistant')`),
    check(
      'transcript_fragments_counters',
      sql`typeof(${table.sequence}) = 'integer' AND ${table.sequence} > 0
      AND typeof(${table.generation}) = 'integer' AND ${table.generation} > 0`,
    ),
  ],
);

// 上流の生成済みテキストを、利用者が聞いた証拠として扱わない。
export const playbackReceipts = sqliteTable(
  'playback_receipts',
  {
    interviewId: text('interview_id')
      .notNull()
      .references(() => interviews.interviewId),
    generation: integer('generation').notNull(),
    audioOffsetMs: integer('audio_offset_ms').notNull(),
    receivedAt: integer('received_at').notNull(),
  },
  (table) => [
    uniqueIndex('playback_receipts_generation').on(table.interviewId, table.generation),
    check(
      'playback_receipts_counters',
      sql`typeof(${table.generation}) = 'integer' AND ${table.generation} > 0
      AND typeof(${table.audioOffsetMs}) = 'integer' AND ${table.audioOffsetMs} >= 0`,
    ),
  ],
);

export interface EvaluationConfiguration {
  model: string;
  promptVersion: string;
  rubricVersion: string;
  instructions: string;
  rubric: string;
}

export interface EvaluationSnapshot {
  schemaVersion: 1;
  interview: Pick<
    typeof interviews.$inferSelect,
    | 'interviewId'
    | 'materialHash'
    | 'themeTitle'
    | 'themeHeading'
    | 'themeExcerpt'
    | 'background'
    | 'activeMs'
  >;
  fragments: (typeof transcriptFragments.$inferSelect)[];
  playback: (typeof playbackReceipts.$inferSelect)[];
  transcriptIncomplete: boolean;
  evaluation: EvaluationConfiguration;
}

// 固定入力はジョブ単位。手動再評価も元の入力を複製し、原文を再構築しない。
export const evaluationInputs = sqliteTable(
  'evaluation_inputs',
  {
    jobId: text('job_id')
      .primaryKey()
      .references(() => jobs.jobId),
    interviewId: text('interview_id')
      .notNull()
      .references(() => interviews.interviewId),
    kind: text('kind', { enum: ['initial', 'manual'] }).notNull(),
    lastSequence: integer('last_sequence').notNull(),
    inputJson: text('input_json', { mode: 'json' }).$type<EvaluationSnapshot>().notNull(),
    model: text('model').notNull(),
    promptVersion: text('prompt_version').notNull(),
    rubricVersion: text('rubric_version').notNull(),
    createdAt: integer('created_at').notNull(),
    retryOf: text('retry_of'),
  },
  (table) => [
    uniqueIndex('evaluation_inputs_retry_of').on(table.retryOf),
    uniqueIndex('evaluation_inputs_one_initial')
      .on(table.interviewId)
      .where(sql`${table.kind} = 'initial'`),
    check('evaluation_inputs_kind', sql`${table.kind} IN ('initial', 'manual')`),
    check(
      'evaluation_inputs_sequence',
      sql`typeof(${table.lastSequence}) = 'integer' AND ${table.lastSequence} >= 0`,
    ),
    check('evaluation_inputs_json', sql`json_valid(${table.inputJson})`),
  ],
);

export const deletedInterviews = sqliteTable('deleted_interviews', {
  interviewId: text('interview_id').primaryKey(),
  actorId: text('actor_id').notNull(),
  deletedAt: integer('deleted_at').notNull(),
});
