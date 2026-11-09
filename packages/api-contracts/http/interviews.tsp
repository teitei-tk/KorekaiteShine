import "@typespec/http";
import "@typespec/openapi";
using TypeSpec.Http;
using TypeSpec.OpenAPI;
namespace InterviewSpike;

@extension("additionalProperties", false)
model CreateInterviewRequest {
  @minLength(1) @maxLength(100) @pattern("^[A-Za-z0-9_-]+$") interviewId: string;
  @minLength(1) @maxLength(100) analysisId: string;
  @minValue(0) @maxValue(4) themeIndex: int32;
  @maxLength(4000) background: string;
}

@extension("additionalProperties", false)
model InterviewSession {
  @minLength(1) @maxLength(100) interviewId: string;
  status: "ready" | "connecting" | "active" | "paused" | "reconnecting" | "ending" | "ended";
  @minLength(1) @maxLength(200) theme: string;
  @minValue(0) createdAt: safeint;
  @minValue(0) @maxValue(1200000) activeMs: int32;
}

@extension("additionalProperties", false)
model InterviewErrorBody {
  @extension("additionalProperties", false)
  error: {
    code: "INVALID_REQUEST" | "FORBIDDEN" | "REQUEST_TOO_LARGE" | "UNSUPPORTED_MEDIA_TYPE" | "ANALYSIS_NOT_FOUND" | "INTERVIEW_CONFLICT" | "STORAGE_UNAVAILABLE";
    message: string;
  };
}
model InterviewFailure<Status extends int32> {
  @statusCode statusCode: Status;
  @header("Cache-Control") cacheControl: "no-store";
  @body body: InterviewErrorBody;
}
model InterviewAccepted {
  @statusCode statusCode: 200;
  @header("Cache-Control") cacheControl: "no-store";
  @body body: InterviewSession;
}

@route("/api/interviews") @post
op createInterview(@body body: CreateInterviewRequest): InterviewAccepted | InterviewFailure<400> | InterviewFailure<403> | InterviewFailure<404> | InterviewFailure<409> | InterviewFailure<413> | InterviewFailure<415> | InterviewFailure<503>;
