import "@typespec/http";
import "@typespec/openapi3";

using TypeSpec.Http;

@service(#{ title: "面接一覧・ローカル連携検証" })
namespace InterviewSpike;

model Interview {
  id: string;
  theme: string;
  startedAt: utcDateTime;
  materialKind: "code" | "experience";
  @minValue(0)
  durationSeconds: int32;
  evaluationStatus: "waiting" | "running" | "retrying" | "failed" | "completed";
}

model InterviewList {
  items: Interview[];
}

model InvalidQuery {
  @statusCode statusCode: 400;
  @body body: { code: "INVALID_QUERY"; message: string; };
}

@route("/api/interviews")
@get
op listInterviews(
  @query @minValue(1) @maxValue(20) limit?: int32,
): InterviewList | InvalidQuery;
