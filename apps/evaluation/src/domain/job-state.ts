/** 実行権を新しく取得できる状態。予定時刻や削除状態は別途照合する。 */
export const runnableJobStates = ['pending', 'retry_wait'] as const;

/** 配送の重複で再実行しない終端状態。 */
export const terminalJobStates = ['completed', 'failed', 'cancelled'] as const;
