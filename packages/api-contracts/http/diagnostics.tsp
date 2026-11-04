import "@typespec/http";
import "@typespec/openapi";

using TypeSpec.Http;
using TypeSpec.OpenAPI;

namespace InterviewSpike;

@pattern("^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
scalar DiagnosticUuid extends string;

@format("date-time")
@pattern("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$")
scalar DiagnosticTimestamp extends string;

alias CheckScenario = "success" | "retry_then_success" | "exhaust_retries";
alias CheckObservation = "pending" | "passed" | "not_expected";

@extension("additionalProperties", false)
model CheckStartRequest {
  scenario: CheckScenario;
}

@extension("additionalProperties", false)
model CheckAccepted {
  jobId: DiagnosticUuid;
  scenario: CheckScenario;
  acceptedAt: DiagnosticTimestamp;
}

@extension("additionalProperties", false)
model CheckObservations {
  doPersistence: CheckObservation;
  consumerCompletion: CheckObservation;
  dlqReceipt: CheckObservation;
}

@extension("additionalProperties", false)
model CheckStatus {
  jobId: DiagnosticUuid;
  scenario: CheckScenario;
  status: "pending" | "running" | "retry_wait" | "completed" | "failed" | "cancelled";
  @minValue(0) @maxValue(4) attemptCount: int32;
  acceptedAt: DiagnosticTimestamp;
  updatedAt: DiagnosticTimestamp;
  finishedAt: DiagnosticTimestamp | null;
  nextAttemptAt: DiagnosticTimestamp | null;
  lastErrorCode: string | null;
  checks: CheckObservations;
}

@extension("additionalProperties", false)
model CheckValidationDetail {
  location: "header" | "path" | "query" | "body";
  @doc("本文はJSON Pointer、本文全体は空文字。他の場所はヘッダー名またはパラメーター名。")
  path: string;
  code: "REQUIRED" | "INVALID_FORMAT" | "INVALID_VALUE" | "UNRECOGNIZED_FIELD";
  message: string;
}

@extension("additionalProperties", false)
model CheckError<Code extends string> {
  code: Code;
  message: string;
  requestId: DiagnosticUuid;
}

@extension("additionalProperties", false)
model CheckErrorBody<Code extends string> {
  error: CheckError<Code>;
}

@extension("additionalProperties", false)
model CheckValidationError {
  code: "VALIDATION_ERROR";
  message: string;
  requestId: DiagnosticUuid;
  details: CheckValidationDetail[];
}

@extension("additionalProperties", false)
model CheckValidationErrorBody {
  error: CheckValidationError;
}

model CheckResponse<Status extends int32, Body> {
  @statusCode statusCode: Status;
  @header("Cache-Control") cacheControl: "no-store";
  @body body: Body;
}

model CheckAcceptedResponse extends CheckResponse<202, CheckAccepted> {
  @pattern("^/api/diagnostics/check-jobs/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
  @header("Location") location: string;
}

alias CheckValidationResponse = CheckResponse<400, CheckValidationErrorBody>;
alias CheckInternalErrorResponse = CheckResponse<500, CheckErrorBody<"INTERNAL_ERROR">>;
alias CheckUnavailableResponse = CheckResponse<503, CheckErrorBody<"SERVICE_UNAVAILABLE">>;

@route("/api/diagnostics/check-jobs")
@post
op startCheckJob(
  @header("Content-Type") contentType: "application/json",
  @header("Idempotency-Key") idempotencyKey: DiagnosticUuid,
  @body body: CheckStartRequest,
): CheckAcceptedResponse
  | CheckValidationResponse
  | CheckResponse<409, CheckErrorBody<"IDEMPOTENCY_KEY_CONFLICT">>
  | CheckResponse<415, CheckErrorBody<"UNSUPPORTED_MEDIA_TYPE">>
  | CheckInternalErrorResponse
  | CheckUnavailableResponse;

@route("/api/diagnostics/check-jobs/{jobId}")
@get
op getCheckJob(@path jobId: DiagnosticUuid):
  CheckResponse<200, CheckStatus>
  | CheckValidationResponse
  | CheckResponse<404, CheckErrorBody<"JOB_NOT_FOUND">>
  | CheckInternalErrorResponse
  | CheckUnavailableResponse;
