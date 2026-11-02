import { and, eq, exists, inArray, isNull, notExists, sql } from 'void/db';
import { jobs, jobOutbox, diagnosticChecks, deletedJobs } from '@korekaite/database';
import { createPrimaryDb } from '@korekaite/database/connection';
import type { D1Database } from '@cloudflare/workers-types';

export async function requireDiagnosticInitialization(
  binding: D1Database,
  jobId: string,
): Promise<void> {
  const db = createPrimaryDb(binding);
  const [job] = await db
    .select({ jobId: jobs.jobId })
    .from(jobs)
    .innerJoin(jobOutbox, eq(jobOutbox.jobId, jobs.jobId))
    .where(
      and(
        eq(jobs.jobId, jobId),
        eq(jobs.purpose, 'diagnostics'),
        eq(jobs.actorId, 'local-developer'),
        eq(jobOutbox.operation, 'initialize_do'),
        eq(jobOutbox.purpose, 'diagnostics'),
        notExists(db.select().from(deletedJobs).where(eq(deletedJobs.jobId, jobId))),
      ),
    )
    .limit(1);
  if (!job) throw new Error('診断の初期化対象を確認できません。');
}

export async function confirmDiagnosticInitialization(
  binding: D1Database,
  jobId: string,
  firstReceivedAt: number,
): Promise<void> {
  const db = createPrimaryDb(binding);
  const now = Date.now();
  const active = and(
    eq(jobs.jobId, jobId),
    eq(jobs.actorId, 'local-developer'),
    eq(jobs.purpose, 'diagnostics'),
    eq(jobs.status, 'pending'),
    notExists(db.select().from(deletedJobs).where(eq(deletedJobs.jobId, jobId))),
  );
  const activeJobs = db.select({ jobId: jobs.jobId }).from(jobs).where(active);
  const pendingInitialization = db
    .select({ id: jobOutbox.id })
    .from(jobOutbox)
    .where(
      and(
        eq(jobOutbox.jobId, jobId),
        eq(jobOutbox.purpose, 'diagnostics'),
        eq(jobOutbox.operation, 'initialize_do'),
        isNull(jobOutbox.sentAt),
      ),
    );
  const confirmed = db
    .select({ jobId: diagnosticChecks.jobId })
    .from(diagnosticChecks)
    .where(
      and(
        eq(diagnosticChecks.jobId, jobId),
        eq(diagnosticChecks.firstReceivedAt, firstReceivedAt),
        eq(diagnosticChecks.doPersistence, 'passed'),
      ),
    );
  await db.batch([
    db
      .update(jobs)
      .set({ updatedAt: now })
      .where(
        and(
          active,
          exists(pendingInitialization),
          exists(
            db
              .select()
              .from(diagnosticChecks)
              .where(
                and(eq(diagnosticChecks.jobId, jobId), isNull(diagnosticChecks.firstReceivedAt)),
              ),
          ),
        ),
      ),
    db
      .update(diagnosticChecks)
      .set({ firstReceivedAt, doPersistence: 'passed' })
      .where(
        and(
          eq(diagnosticChecks.jobId, jobId),
          isNull(diagnosticChecks.firstReceivedAt),
          inArray(diagnosticChecks.jobId, activeJobs),
          exists(pendingInitialization),
        ),
      ),
    db
      .insert(jobOutbox)
      .select(
        db
          .select({
            id: sql<string>`${crypto.randomUUID()}`.as('id'),
            jobId: jobs.jobId,
            purpose: sql<'diagnostics'>`'diagnostics'`.as('purpose'),
            operation: sql<'notify'>`'notify'`.as('operation'),
            generation: sql<number>`0`.as('generation'),
            scheduledAt: sql<number>`${now}`.as('scheduled_at'),
            sentAt: sql<null>`NULL`.as('sent_at'),
          })
          .from(jobs)
          .where(and(active, exists(confirmed), exists(pendingInitialization))),
      )
      .onConflictDoNothing({
        target: [jobOutbox.jobId, jobOutbox.operation, jobOutbox.generation],
      }),
    db
      .update(jobOutbox)
      .set({ sentAt: now })
      .where(
        and(
          eq(jobOutbox.jobId, jobId),
          eq(jobOutbox.operation, 'initialize_do'),
          eq(jobOutbox.purpose, 'diagnostics'),
          isNull(jobOutbox.sentAt),
          inArray(jobOutbox.jobId, activeJobs),
          exists(confirmed),
        ),
      ),
  ]);
  const [confirmation] = await confirmed;
  if (!confirmation) throw new Error('DO保存の観測結果を確定できません。');
}

export async function pendingCheckNotification(binding: D1Database, jobId: string) {
  const db = createPrimaryDb(binding);
  const [pending] = await db
    .select({ id: jobOutbox.id, jobId: jobOutbox.jobId })
    .from(jobOutbox)
    .innerJoin(jobs, eq(jobs.jobId, jobOutbox.jobId))
    .where(
      and(
        eq(jobOutbox.jobId, jobId),
        eq(jobOutbox.operation, 'notify'),
        eq(jobOutbox.purpose, 'diagnostics'),
        eq(jobOutbox.generation, 0),
        isNull(jobOutbox.sentAt),
        eq(jobs.purpose, 'diagnostics'),
        eq(jobs.actorId, 'local-developer'),
        eq(jobs.status, 'pending'),
        notExists(db.select().from(deletedJobs).where(eq(deletedJobs.jobId, jobId))),
      ),
    )
    .limit(1);
  return pending ?? null;
}

export async function markCheckNotificationSent(binding: D1Database, id: string): Promise<void> {
  const db = createPrimaryDb(binding);
  await db
    .update(jobOutbox)
    .set({ sentAt: Date.now() })
    .where(
      and(
        eq(jobOutbox.id, id),
        eq(jobOutbox.operation, 'notify'),
        eq(jobOutbox.purpose, 'diagnostics'),
        eq(jobOutbox.generation, 0),
        isNull(jobOutbox.sentAt),
      ),
    );
}
