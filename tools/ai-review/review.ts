import { ReviewFailure } from './failure.ts';
import type { PriorFinding } from './history.ts';
import OpenAI from 'openai';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validReview } from './policy.ts';
import type { Review } from './policy.ts';
import type { Material } from './material.ts';

const schema = JSON.parse(readFileSync(new URL('./schema.json', import.meta.url), 'utf8'));

export interface ReviewResult<T = Review> {
  value: T;
  usage: { input: number | null; output: number | null; total: number | null };
}

export async function generateReview(
  token: string,
  prompt: string,
  lines: Record<string, number[]>,
  fetcher: typeof fetch = fetch,
  prior: PriorFinding[] = [],
): Promise<ReviewResult> {
  return requestStructuredReview(
    token,
    prompt,
    (value) => validReview(value, lines, prior),
    fetcher,
  );
}

export async function requestStructuredReview<T>(
  token: string,
  prompt: string,
  validate: (value: T) => T,
  fetcher: typeof fetch = fetch,
  outputSchema = schema,
): Promise<ReviewResult<T>> {
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
        text: {
          format: { type: 'json_schema', name: 'code_review', strict: true, schema: outputSchema },
        },
      },
      { signal: AbortSignal.timeout(150_000) },
    );
    if (
      result.status !== 'completed' ||
      !result.output_text ||
      Buffer.byteLength(result.output_text) > 30_000
    )
      throw new ReviewFailure('INCOMPLETE', 'レビュー生成に失敗しました。');
    let value: T;
    try {
      value = validate(JSON.parse(result.output_text));
    } catch (error) {
      if (error instanceof ReviewFailure) throw error;
      throw new ReviewFailure('OUTPUT_INVALID', 'レビュー生成に失敗しました。');
    }
    const count = (n: number | undefined) =>
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
    if (error instanceof ReviewFailure) throw error;
    const status =
      error instanceof OpenAI.APIError && Number.isInteger(error.status)
        ? `（HTTP ${error.status}）`
        : '';
    // SDKのエラー本文・headers・認証値・プロンプトは出力しない。
    throw new Error(`レビュー生成に失敗しました${status}。`);
  }
}

export async function writeReviewArtifact(
  directory: string,
  token: string,
  summaryPath: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const metadata = JSON.parse(readFileSync(join(directory, 'metadata.json'), 'utf8')) as Material;
  const { value, usage } = await generateReview(
    token,
    readFileSync(join(directory, 'prompt.txt'), 'utf8'),
    metadata.lines,
    fetcher,
    metadata.priorFindings,
  );
  writeFileSync(join(directory, 'result.json'), JSON.stringify(value));
  appendFileSync(
    summaryPath,
    `Responses API使用量: input=${usage.input ?? '不明'}, output=${usage.output ?? '不明'}, total=${usage.total ?? '不明'} tokens\n`,
  );
}

if (import.meta.main) {
  try {
    await writeReviewArtifact(
      process.env.REVIEW_DIRECTORY!,
      process.env.OPENAI_ACCESS_TOKEN ?? '',
      process.env.GITHUB_STEP_SUMMARY!,
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
