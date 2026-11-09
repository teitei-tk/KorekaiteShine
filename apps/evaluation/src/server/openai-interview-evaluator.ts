import { Temporal } from '@js-temporal/polyfill';
import schema from '@korekaite/api-contracts/http/evaluation-schema';
import type { EvaluationGenerator } from '../application/evaluate-interview';
import { EvaluationProviderError } from '../domain/evaluation-result';

interface ResponseContentInput {
  type?: string;
  text?: string;
}
interface ResponseMessageInput {
  type?: string;
  role?: string;
  status?: string;
  content?: (ResponseContentInput | null)[];
}
interface ResponseInput {
  status?: string;
  error?: { message?: string } | null;
  output?: (ResponseMessageInput | null)[];
}

export function createInterviewEvaluator(options: {
  apiKey: string;
  fetcher?: typeof fetch;
  now?: () => number;
}): EvaluationGenerator {
  const fetcher = options.fetcher ?? fetch;
  return async (input, signal) => {
    if (!options.apiKey.trim() || !input.evaluation.model.trim()) {
      throw new EvaluationProviderError({ code: 'AI_CONFIGURATION_INVALID', retryable: false });
    }
    const response = await fetcher('https://api.openai.com/v1/responses', {
      method: 'POST',
      signal,
      redirect: 'error',
      headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: input.evaluation.model,
        store: false,
        instructions: input.evaluation.instructions,
        tools: [],
        tool_choice: 'none',
        max_output_tokens: 12000,
        input: [
          {
            role: 'user',
            content: JSON.stringify({
              kind: 'fixed_interview_evaluation',
              rubric: input.evaluation.rubric,
              rubricVersion: input.evaluation.rubricVersion,
              promptVersion: input.evaluation.promptVersion,
              interview: input.interview,
              fragments: input.fragments,
              playback: input.playback,
              transcriptIncomplete: input.transcriptIncomplete,
            }),
          },
        ],
        text: {
          format: { type: 'json_schema', name: 'interview_evaluation', strict: true, schema },
        },
      }),
    });
    if (!response.ok) {
      const retryable =
        response.status === 429 || response.status === 408 || response.status >= 500;
      const retryAfterMs = parseRetryAfter(
        response.headers.get('Retry-After'),
        options.now?.() ?? Temporal.Now.instant().epochMilliseconds,
      );
      throw new EvaluationProviderError({
        code:
          response.status === 429
            ? 'AI_RATE_LIMITED'
            : retryable
              ? 'AI_UNAVAILABLE'
              : 'AI_REQUEST_REJECTED',
        retryable,
        ...(retryAfterMs !== null ? { retryAfterMs } : {}),
      });
    }
    try {
      return readStructuredOutput(await response.json());
    } catch {
      throw new EvaluationProviderError({ code: 'INVALID_AI_RESULT', retryable: true });
    }
  };
}

function readStructuredOutput(body: ResponseInput | null): object | null {
  if (
    body === null ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    body.status !== 'completed' ||
    body.error != null ||
    !Array.isArray(body.output)
  ) {
    throw new Error('未完了の応答です。');
  }
  const messages = body.output.filter(
    (item) => item !== null && typeof item === 'object' && item.type === 'message',
  );
  if (messages.length !== 1) {
    throw new Error('応答を特定できません。');
  }
  const message = messages[0];
  if (
    !message ||
    typeof message !== 'object' ||
    Array.isArray(message) ||
    message.role !== 'assistant' ||
    message.status !== 'completed' ||
    !Array.isArray(message.content) ||
    message.content.length !== 1
  ) {
    throw new Error('応答メッセージが不正です。');
  }
  const content = message.content[0];
  if (
    !content ||
    typeof content !== 'object' ||
    Array.isArray(content) ||
    content.type !== 'output_text' ||
    typeof content.text !== 'string'
  ) {
    throw new Error('構造化された応答がありません。');
  }
  return JSON.parse(content.text);
}

function parseRetryAfter(value: string | null, now: number): number | null {
  if (value === null) {
    return null;
  }
  if (/^\d+$/u.test(value)) {
    const milliseconds = Number(value) * 1000;
    if (Number.isSafeInteger(milliseconds)) {
      return milliseconds;
    }
  }
  const match =
    /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/u.exec(
      value,
    );
  if (match) {
    const month =
      ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].indexOf(
        match[2],
      ) + 1;
    try {
      const date = Temporal.PlainDateTime.from(
        {
          year: Number(match[3]),
          month,
          day: Number(match[1]),
          hour: Number(match[4]),
          minute: Number(match[5]),
          second: Number(match[6]),
        },
        { overflow: 'reject' },
      );
      return Math.max(0, date.toZonedDateTime('UTC').epochMilliseconds - now);
    } catch {
      /* 解釈不能なら指定を無視して再試行しない。 */
    }
  }
  throw new EvaluationProviderError({ code: 'AI_RETRY_AFTER_INVALID', retryable: false });
}
