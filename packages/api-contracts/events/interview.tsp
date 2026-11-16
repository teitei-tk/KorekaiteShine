import "@typespec/json-schema";
using TypeSpec.JsonSchema;

@extension("additionalProperties", false)
model InterviewCommand {
  type: "start" | "resume" | "pause" | "finish" | "takeover" | "rephrase" | "skip" | "sync";
  @minLength(1) @maxLength(100) commandId: string;
  @minValue(0) @maxValue(9007199254740991) generation: safeint;
}
@extension("additionalProperties", false)
model InterviewPlayback {
  type: "playback";
  @minLength(1) @maxLength(100) commandId: string;
  @minValue(1) @maxValue(9007199254740991) generation: safeint;
  @minValue(0) @maxValue(1200000) audioOffsetMs: safeint;
}
@jsonSchema
union InterviewClientEvent { InterviewCommand, InterviewPlayback }

@extension("additionalProperties", false)
model InterviewStateEvent {
  type: "state";
  @minLength(1) @maxLength(100) interviewId: string;
  status: "ready" | "connecting" | "active" | "paused" | "reconnecting" | "ending" | "ended";
  @minValue(0) @maxValue(9007199254740991) generation: safeint;
  @minValue(0) @maxValue(1200000) activeMs: safeint;
  activeSince: safeint | null;
  deadline: safeint | null;
  updatedAt: safeint;
  canControl: boolean;
  transcriptIncomplete: boolean;
  evaluationJobId: string | null;
}
@extension("additionalProperties", false)
model InterviewTranscriptEvent {
  type: "transcript";
  @minLength(1) @maxLength(400) fragmentId: string;
  @minValue(1) sequence: safeint;
  @minValue(1) generation: safeint;
  speaker: "user" | "assistant";
  startsQuestion?: boolean;
  @maxLength(32768) content: string;
  sourceStartMs: float64 | null;
  sourceEndMs: float64 | null;
}
@extension("additionalProperties", false)
model InterviewAudioEvent {
  type: "audio";
  @minValue(1) generation: safeint;
  @minValue(0) endOffsetMs: safeint;
  @minValue(2) @maxValue(98304) byteLength: int32;
}
@extension("additionalProperties", false)
model InterviewAckEvent { type: "ack"; commandId: string; }
@extension("additionalProperties", false)
model InterviewErrorEvent {
  type: "error";
  commandId: string | null;
  code: "INVALID_EVENT" | "STALE_STATE" | "NOT_OWNER" | "UNAVAILABLE" | "CONTEXT_LIMIT" | "AUDIO_USAGE_LIMIT" | "AUDIO_CONNECT_FAILED";
}
@extension("additionalProperties", false)
model InterviewDeletedEvent { type: "deleted"; @minLength(1) @maxLength(100) interviewId: string; }
@jsonSchema
union InterviewServerEvent {
  InterviewStateEvent, InterviewTranscriptEvent, InterviewAudioEvent, InterviewAckEvent, InterviewErrorEvent, InterviewDeletedEvent
}
