import { createClient } from '@korekaite/api-contracts/http/client';
import { listInterviews } from '@korekaite/api-contracts/http/sdk';
import type { InterviewList } from '@korekaite/api-contracts/http';
import { validateList } from '@korekaite/api-contracts/http/validators';

export async function getInterviews(
  baseUrl: string,
  fetcher: typeof fetch = fetch,
): Promise<InterviewList> {
  const client = createClient({ baseUrl, fetch: fetcher });
  const { data, error, response } = await listInterviews({ client });
  if (!response || error instanceof Error) {
    throw error;
  }
  if (!response.ok || !data) {
    throw new Error('面接一覧を取得できませんでした。');
  }
  if (!validateList(data)) {
    throw new Error('面接一覧の形式が契約と一致しません。');
  }
  return data;
}
