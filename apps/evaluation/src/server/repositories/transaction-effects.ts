import type { createPrimaryDb } from '@korekaite/database/connection';
import type { exists } from 'void/db';

type Database = ReturnType<typeof createPrimaryDb>;
export type TransactionStatement = Parameters<Database['batch']>[0][number];
export interface JobTransactionEffects {
  completed?(guard: ReturnType<typeof exists>, jobId: string, now: number): TransactionStatement[];
  dlqReceived?(
    guard: ReturnType<typeof exists>,
    jobId: string,
    now: number,
  ): TransactionStatement[];
}
