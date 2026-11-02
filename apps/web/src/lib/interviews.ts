import createClient from 'openapi-fetch';
import type { components, paths } from '@korekaite/api-contracts/http';
import { validateList } from '@korekaite/api-contracts/http/validators';

export async function getInterviews(
  baseUrl: string,
  fetcher: typeof fetch = fetch,
): Promise<components['schemas']['InterviewList']> {
  const client = createClient<paths>({ baseUrl, fetch: fetcher });
  const { data, response } = await client.GET('/api/interviews');
  if (!response.ok || !data) throw new Error('面接一覧を取得できませんでした。');
  if (!validateList(data)) throw new Error('面接一覧の形式が契約と一致しません。');
  return data;
}
