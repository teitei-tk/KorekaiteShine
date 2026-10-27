import { MODEL, MAX_OUTPUT, validUsage } from './budget.ts';
import type { BillingHooks } from './budget.ts';
import { digest } from './source-index.ts';
import type { ResponseCreateParamsNonStreaming } from 'openai/resources/responses/responses';
import { ReviewFailure } from './failure.ts';
import { detail } from './diagnostics.ts';
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
  billing?: BillingHooks,
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
    const body = {
      model: MODEL,
      input: prompt,
      reasoning: { effort: 'medium' },
      tools: [],
      store: false,
      service_tier: 'default',
      prompt_cache_options: { mode: 'implicit', ttl: '30m' },
      max_output_tokens: MAX_OUTPUT,
      text: {
        format: { type: 'json_schema', name: 'code_review', strict: true, schema: outputSchema },
      },
    } satisfies ResponseCreateParamsNonStreaming;
    if (billing) {
      let input: number;
      try {
        const { model, input: promptInput, reasoning, tools, text } = body;
        const counted = await client.responses.inputTokens.count(
          { model, input: promptInput, reasoning, tools, text },
          {
            signal: AbortSignal.timeout(30000),
          },
        );
        if (
          counted.object !== 'response.input_tokens' ||
          !Number.isSafeInteger(counted.input_tokens) ||
          counted.input_tokens < 0
        )
          throw new Error('invalid count');
        input = counted.input_tokens;
      } catch {
        throw new ReviewFailure('TOKEN_COUNT_FAILED', '入力計数に失敗しました');
      }
      await billing.reserve(input, digest(JSON.stringify(body)));
    }
    const result = await client.responses.create(body, { signal: AbortSignal.timeout(150_000) });
    if (billing) {
      const u = result.usage;
      const usage = {
        input: u?.input_tokens,
        cached: u?.input_tokens_details?.cached_tokens,
        written: u?.input_tokens_details?.cache_write_tokens,
        output: u?.output_tokens,
        total: u?.total_tokens,
      };
      if (!validUsage(usage)) throw new ReviewFailure('USAGE_INVALID', '使用量が不明です');
      // 未知の料金区分では予約を保持し、誤った単価で精算しない。
      if (result.model !== MODEL || result.service_tier !== 'default')
        throw new ReviewFailure('USAGE_INVALID', '料金区分が一致しません');
      // 課金usageはJSON解析・指摘の検証より先に保存する。
      await billing.settle(usage);
    }
    if (result.status !== 'completed') {
      const reason = result.incomplete_details?.reason;
      const subcode =
        reason === 'max_output_tokens'
          ? 'TOKEN_LIMIT'
          : reason === 'content_filter'
            ? 'CONTENT_FILTER'
            : 'API_INCOMPLETE';
      throw new ReviewFailure('INCOMPLETE', 'レビュー生成に失敗しました。', detail(subcode));
    }
    if (!result.output_text)
      throw new ReviewFailure('INCOMPLETE', 'レビュー生成に失敗しました。', detail('EMPTY_OUTPUT'));
    if (Buffer.byteLength(result.output_text) > 30_000)
      throw new ReviewFailure('INCOMPLETE', 'レビュー生成に失敗しました。', detail('OUTPUT_LIMIT'));
    let parsed: T;
    try {
      parsed = JSON.parse(result.output_text) as T;
    } catch {
      throw new ReviewFailure(
        'OUTPUT_INVALID',
        'レビュー生成に失敗しました。',
        detail('INVALID_JSON'),
      );
    }
    let value: T;
    try {
      value = validate(parsed);
    } catch (error) {
      if (error instanceof ReviewFailure) throw error;
      throw new ReviewFailure(
        'OUTPUT_INVALID',
        'レビュー生成に失敗しました。',
        detail('INVALID_RESULT'),
      );
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
