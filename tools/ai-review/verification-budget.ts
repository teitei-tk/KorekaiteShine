// 検証専用。呼び出し前に、使用済み費用と今回の最大費用の合計が
// 1ドル以下である場合だけ許可する。ちょうど1ドルは許可する。
export function maySpend(spentUsd: number, nextUsd: number): boolean {
  return (
    Number.isFinite(spentUsd) &&
    Number.isFinite(nextUsd) &&
    spentUsd >= 0 &&
    nextUsd >= 0 &&
    spentUsd + nextUsd <= 1
  );
}
