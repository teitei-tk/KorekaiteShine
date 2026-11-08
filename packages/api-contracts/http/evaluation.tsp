import "@typespec/openapi";
using TypeSpec.OpenAPI;
namespace InterviewSpike;

@extension("additionalProperties", false)
model EvaluationEvidence {
  source: "transcript" | "material";
  @maxItems(32) fragmentIds: string[];
  @minLength(1) @maxLength(2000) quote: string;
}

@extension("additionalProperties", false)
model EvaluationAxis {
  status: "scored" | "unconfirmed" | "not_applicable";
  score: 1 | 2 | 3 | 4 | 5 | null;
  @minLength(1) @maxLength(2000) reason: string;
  @maxItems(8) evidence: EvaluationEvidence[];
}

@extension("additionalProperties", false)
model EvaluationAxes {
  problem: EvaluationAxis;
  alternatives: EvaluationAxis;
  reasoning: EvaluationAxis;
  action: EvaluationAxis;
  learning: EvaluationAxis;
}

@extension("additionalProperties", false)
model EvaluationObservation {
  @minLength(1) @maxLength(2000) text: string;
  @minItems(1) @maxItems(8) evidence: EvaluationEvidence[];
}

@extension("additionalProperties", false)
model EvaluationConsistency {
  status: "resolved" | "needs_confirmation";
  first: EvaluationEvidence;
  second: EvaluationEvidence;
  @minLength(1) @maxLength(2000) explanation: string;
}

@extension("additionalProperties", false)
model InterviewEvaluation {
  @minLength(1) @maxLength(4000) summary: string;
  axes: EvaluationAxes;
  @maxItems(8) strengths: EvaluationObservation[];
  @maxItems(8) gaps: EvaluationObservation[];
  @maxItems(8) unconfirmed: EvaluationObservation[];
  @maxItems(8) practiceQuestions: EvaluationObservation[];
  @maxItems(8) consistency: EvaluationConsistency[];
}
