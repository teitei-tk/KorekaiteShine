import "@typespec/http";
import "@typespec/openapi";
using TypeSpec.Http;
using TypeSpec.OpenAPI;
namespace InterviewSpike;

@extension("additionalProperties", false)
model LocalSession { @pattern("^[a-f0-9]{64}$") operationToken: string; }
@extension("additionalProperties", false)
model ApplicationError {
  @extension("additionalProperties", false)
  error: { code: "FORBIDDEN" | "NOT_FOUND" | "INVALID_REQUEST" | "CONFLICT" | "UNAVAILABLE"; message: string; };
}
model ApplicationFailure<Status extends int32> {
  @statusCode statusCode: Status;
  @header("Cache-Control") cacheControl: "no-store";
  @body body: ApplicationError;
}
model ApplicationSuccess<Value> {
  @statusCode statusCode: 200;
  @header("Cache-Control") cacheControl: "no-store";
  @body body: Value;
}
model LocalSessionResponse extends ApplicationSuccess<LocalSession> { @header("Set-Cookie") cookie: string; }
@route("/api/local-session") @get
op getLocalSession(): LocalSessionResponse | ApplicationFailure<403>;

@extension("additionalProperties", false)
model InterviewCursor { @minValue(0) createdAt: safeint; @pattern("^[A-Za-z0-9_-]{1,100}$") interviewId: string; }
@extension("additionalProperties", false)
model InterviewHistory { @maxItems(20) items: InterviewSession[]; next: InterviewCursor | null; }
@extension("additionalProperties", false)
model InterviewHistoryQuery {
  @query @minValue(0) beforeCreatedAt?: safeint;
  @query @pattern("^[A-Za-z0-9_-]{1,100}$") beforeId?: string;
}
@route("/api/interview-history") @get
op getInterviewHistory(...InterviewHistoryQuery): ApplicationSuccess<InterviewHistory> | ApplicationFailure<400> | ApplicationFailure<403> | ApplicationFailure<503>;

@extension("additionalProperties", false)
model SavedTranscript {
  fragmentId: string; @minValue(1) sequence: safeint; @minValue(1) generation: safeint;
  speaker: "user" | "assistant"; content: string;
  sourceStartMs: float64 | null; sourceEndMs: float64 | null; receivedAt: safeint;
}
@extension("additionalProperties", false)
model SavedPlayback { @minValue(1) generation: safeint; @minValue(0) audioOffsetMs: safeint; receivedAt: safeint; }
@extension("additionalProperties", false)
model SavedEvaluation {
  jobId: string;
  status: "pending" | "running" | "retry_wait" | "completed" | "failed" | "cancelled";
  @minValue(0) attemptCount: int32;
  nextAttemptAt: safeint | null;
  lastErrorCode: string | null;
  result: InterviewEvaluation | null;
}
@extension("additionalProperties", false)
model InterviewDetail {
  @minValue(0) audioRemainingMs?: safeint;
  session: InterviewSession;
  material: MaterialTheme;
  background: string;
  transcriptIncomplete: boolean;
  transcripts: SavedTranscript[];
  playback: SavedPlayback[];
  evaluation: SavedEvaluation | null;
}
@route("/api/interviews/{interviewId}") @get
op getInterviewDetail(@path @pattern("^[A-Za-z0-9_-]{1,100}$") interviewId: string): ApplicationSuccess<InterviewDetail> | ApplicationFailure<400> | ApplicationFailure<403> | ApplicationFailure<404> | ApplicationFailure<503>;

model InterviewSocket { @statusCode statusCode: 101; }
@route("/api/interviews/{interviewId}/live") @get
op connectInterview(@path @pattern("^[A-Za-z0-9_-]{1,100}$") interviewId: string): InterviewSocket | ApplicationFailure<400> | ApplicationFailure<403> | ApplicationFailure<404> | ApplicationFailure<503>;

@pattern("^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
scalar EvaluationJobId extends string;
@extension("additionalProperties", false)
model RetryEvaluationRequest { failedJobId: EvaluationJobId; }
@extension("additionalProperties", false)
model RetryEvaluationAccepted { jobId: EvaluationJobId; }
@route("/api/interviews/{interviewId}/retry") @post
op retryEvaluation(@path @pattern("^[A-Za-z0-9_-]{1,100}$") interviewId: string, @body request: RetryEvaluationRequest): {
  @statusCode statusCode: 202;
  @header("Cache-Control") cacheControl: "no-store";
  @body body: RetryEvaluationAccepted;
} | ApplicationFailure<400> | ApplicationFailure<403> | ApplicationFailure<404> | ApplicationFailure<409> | ApplicationFailure<503>;

@route("/api/interviews/{interviewId}") @delete
op deleteInterview(@path @pattern("^[A-Za-z0-9_-]{1,100}$") interviewId: string): {
  @statusCode statusCode: 204;
  @header("Cache-Control") cacheControl: "no-store";
} | ApplicationFailure<400> | ApplicationFailure<403> | ApplicationFailure<404> | ApplicationFailure<503>;
