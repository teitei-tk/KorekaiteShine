import OpenAI from 'openai';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const schema = JSON.parse(readFileSync(new URL('./schema.json', import.meta.url), 'utf8'));

export async function generateReview(token: string, prompt: string, fetcher: typeof fetch = fetch) {
  try {
    if (!token || Buffer.byteLength(prompt) > 500_000) throw new Error('invalid input');
    const client = new OpenAI({
      apiKey: token,
      baseURL: 'https://api.openai.com/v1',
      organization: null,
      project: null,
      maxRetries: 0,
      timeout: 150_000,
      logLevel: 'off',
      fetch: fetcher,
    });
    const result = await client.responses.create(
      {
        model: 'gpt-6-luna',
        input: prompt,
        reasoning: { effort: 'medium' },
        tools: [],
        store: false,
        max_output_tokens: 8000,
        text: { format: { type: 'json_schema', name: 'code_review', strict: true, schema } },
      },
      { signal: AbortSignal.timeout(150_000) },
    );
    if (
      result.status !== 'completed' ||
      !result.output_text ||
      Buffer.byteLength(result.output_text) > 30_000
    )
      throw new Error('incomplete output');
    const value: unknown = JSON.parse(result.output_text);
    const count = (n: unknown) =>
      typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : null;
    return {
      value,
      usage: {
        input: count(result.usage?.input_tokens),
        output: count(result.usage?.output_tokens),
        total: count(result.usage?.total_tokens),
      },
    };
  } catch (error) {
    const status =
      error instanceof OpenAI.APIError && Number.isInteger(error.status)
        ? `（HTTP ${error.status}）`
        : '';
    // SDKのエラー本文・headers・認証値・プロンプトは出力しない。
    throw new Error(`レビュー生成に失敗しました${status}。`);
  }
}

if (import.meta.main) {
  try {
    const directory = process.env.REVIEW_DIRECTORY!;
    const { value, usage } = await generateReview(
      process.env.OPENAI_ACCESS_TOKEN ?? '',
      readFileSync(join(directory, 'prompt.txt'), 'utf8'),
    );
    writeFileSync(join(directory, 'result.json'), JSON.stringify(value));
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY!,
      `Responses API使用量: input=${usage.input ?? '不明'}, output=${usage.output ?? '不明'}, total=${usage.total ?? '不明'} tokens\n`,
    );
  } catch (error) {
    console.error(
      error instanceof Error &&
        /^レビュー生成に失敗しました(?:（HTTP \d{3}）)?。$/.test(error.message)
        ? error.message
        : 'レビュー生成に失敗しました。',
    );
    process.exitCode = 1;
  }
}
