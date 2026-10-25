// 予算判定の受け入れ条件: 消費済み額と次の予約額の合計が上限以下なら許可する。
// 上限を超える予約は拒否し、上限と等しい予約は許可する。金額は非負の整数。
export function canReserveBudget(spent: number, next: number, limit: number): boolean {
  // 予約後の合計で判定する。
  return spent + next <= limit;
}
