import "@typespec/http";
import "@typespec/openapi";

using TypeSpec.Http;
using TypeSpec.OpenAPI;

namespace InterviewSpike;

@extension("additionalProperties", false)
model MaterialAnalysisRequest {
  @minLength(1) @maxLength(32768) markdown: string;
  confirmed: true;
}

@extension("additionalProperties", false)
model MaterialTheme {
  @minLength(1) @maxLength(200) title: string;
  @minLength(1) @maxLength(200) heading: string;
  @minLength(1) @maxLength(8000) excerpt: string;
}

@extension("additionalProperties", false)
model MaterialAnalysisResult {
  @minItems(1) @maxItems(5) themes: MaterialTheme[];
}

@extension("additionalProperties", false)
model SavedMaterialAnalysis {
  @minLength(1) @maxLength(100) analysisId: string;
  ...MaterialAnalysisResult;
}

@extension("additionalProperties", false)
model MaterialErrorBody {
  @extension("additionalProperties", false)
  error: {
    code: "INVALID_MATERIAL" | "FORBIDDEN" | "MATERIAL_TOO_LARGE" | "UNSUPPORTED_MEDIA_TYPE" | "USAGE_LIMIT" | "INVALID_AI_RESULT" | "AI_UNAVAILABLE" | "ANALYSIS_SAVE_FAILED";
    message: string;
  };
}

model MaterialFailure<Status extends int32> {
  @statusCode statusCode: Status;
  @header("Cache-Control") cacheControl: "no-store";
  @body body: MaterialErrorBody;
}

model MaterialAnalyzed {
  @statusCode statusCode: 200;
  @header("Cache-Control") cacheControl: "no-store";
  @body body: SavedMaterialAnalysis;
}

@route("/api/materials/analyze")
@post
op analyzeExperienceMaterial(
  @body body: MaterialAnalysisRequest,
): MaterialAnalyzed | MaterialFailure<400> | MaterialFailure<403> | MaterialFailure<413> | MaterialFailure<415> | MaterialFailure<429> | MaterialFailure<502> | MaterialFailure<503>;
