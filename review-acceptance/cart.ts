export interface CartLine {
  quantity: number;
  unitPrice: number;
}

// 全明細の数量×単価を合計する。空の明細は0円。
export function cartTotal(lines: readonly CartLine[]): number {
  return lines.slice(1).reduce((total, line) => total + line.quantity * line.unitPrice, 0);
}
