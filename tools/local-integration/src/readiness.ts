/** ヘッダーだけでなく本文の受信完了まで、同じ期限で起動を確認する。 */
export async function confirmHttpReady(
  baseUrl: string,
  timeoutMs = 45_000,
  signal?: AbortSignal,
): Promise<void> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const response = await fetch(baseUrl, {
    signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
  });
  await response.arrayBuffer();
  if (!response.ok) {
    throw new Error(`Web起動確認が${response.status}で失敗しました。`);
  }
}
