import type { EvaluationSnapshot } from '@korekaite/database';
import type { components } from '@korekaite/api-contracts/http';
import { validateInterviewEvaluation } from '@korekaite/api-contracts/http/evaluation-validators';
import { EvaluationProviderError, type EvaluationResult } from '../domain/evaluation-result';

type Evidence = components['schemas']['EvaluationEvidence'];
export type InterviewEvaluation = components['schemas']['InterviewEvaluation'];
export type EvaluationGenerator = (
  input: EvaluationSnapshot,
  signal: AbortSignal,
) => Promise<object | null>;

export async function evaluateInterview(
  input: EvaluationSnapshot,
  signal: AbortSignal,
  generate: EvaluationGenerator,
): Promise<EvaluationResult> {
  try {
    if (signal.aborted) {
      return { ok: false, error: { code: 'AI_ABORTED', retryable: true } };
    }
    const hasAnswer = input.fragments.some(
      (fragment) => fragment.speaker === 'user' && fragment.content.trim().length > 0,
    );
    const value = hasAnswer ? await generate(input, signal) : noAnswerResult();
    if (signal.aborted || !validateInterviewEvaluation(value) || !validEvidence(input, value)) {
      return { ok: false, error: { code: 'INVALID_AI_RESULT', retryable: true } };
    }
    return { ok: true, value };
  } catch (error) {
    if (error instanceof EvaluationProviderError) {
      return { ok: false, error: error.failure };
    }
    return { ok: false, error: { code: 'AI_UNAVAILABLE', retryable: true } };
  }
}

function validEvidence(input: EvaluationSnapshot, value: InterviewEvaluation): boolean {
  const fragments = new Map(input.fragments.map((fragment) => [fragment.fragmentId, fragment]));
  function speaker(evidence: Evidence) {
    return evidence.source === 'transcript'
      ? fragments.get(evidence.fragmentIds[0])?.speaker
      : null;
  }
  function valid(reference: Evidence): boolean {
    if (reference.source === 'material') {
      return (
        reference.fragmentIds.length === 0 && input.interview.themeExcerpt.includes(reference.quote)
      );
    }
    const selected = reference.fragmentIds.map((id) => fragments.get(id));
    if (selected.length === 0 || selected.some((fragment) => !fragment)) {
      return false;
    }
    const contiguous = selected.every(
      (fragment, index) =>
        fragment!.speaker === selected[0]!.speaker &&
        (index === 0 || fragment!.sequence === selected[index - 1]!.sequence + 1),
    );
    return (
      contiguous &&
      selected
        .map((fragment) => fragment!.content)
        .join('')
        .includes(reference.quote)
    );
  }
  for (const axis of Object.values(value.axes)) {
    if ((axis.status === 'scored') !== (axis.score !== null) || !axis.evidence.every(valid)) {
      return false;
    }
    if (
      axis.status === 'scored' &&
      !axis.evidence.some((reference) => speaker(reference) === 'user')
    ) {
      return false;
    }
  }
  for (const observation of [
    ...value.strengths,
    ...value.gaps,
    ...value.unconfirmed,
    ...value.practiceQuestions,
  ]) {
    if (!observation.evidence.every(valid)) {
      return false;
    }
  }
  return value.consistency.every(
    (item) =>
      valid(item.first) &&
      valid(item.second) &&
      speaker(item.first) === 'user' &&
      speaker(item.second) === 'user' &&
      JSON.stringify(item.first) !== JSON.stringify(item.second),
  );
}

function noAnswerResult(): InterviewEvaluation {
  const axis: InterviewEvaluation['axes']['problem'] = {
    status: 'unconfirmed',
    score: null,
    reason: '評価対象の回答なし',
    evidence: [],
  };
  return {
    summary: '評価対象の回答なし',
    axes: { problem: axis, alternatives: axis, reasoning: axis, action: axis, learning: axis },
    strengths: [],
    gaps: [],
    unconfirmed: [],
    practiceQuestions: [],
    consistency: [],
  };
}
