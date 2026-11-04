/** DB境界の障害だけを503へ分類する。causeは応答や通常ログに出さない。 */
export class DiagnosticDatabaseError extends Error {
  constructor(cause: ErrorOptions['cause']) {
    super('診断ジョブのDB操作に失敗しました。', { cause });
    this.name = 'DiagnosticDatabaseError';
  }
}

export async function databaseOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (cause) {
    throw new DiagnosticDatabaseError(cause);
  }
}
