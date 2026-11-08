import "./interview.tsp";
import "@typespec/json-schema";
using TypeSpec.JsonSchema;

@extension("additionalProperties", false)
model LiveInputText { type: "input_text"; @maxLength(16000) text: string; }
@extension("additionalProperties", false)
model LiveOutputText { type: "output_text"; @maxLength(16000) text: string; }
@extension("additionalProperties", false)
model LiveUserMessage { type: "message"; role: "user"; @minItems(1) @maxItems(1) content: LiveInputText[]; }
@extension("additionalProperties", false)
model LiveAssistantMessage { type: "message"; role: "assistant"; @minItems(1) @maxItems(1) content: LiveOutputText[]; }
@extension("additionalProperties", false)
model LiveResponses {
  @minLength(1) @maxLength(200) `model`: string;
  @minLength(1) @maxLength(16000) instructions: string;
  @maxItems(0) tools: string[];
  tool_choice: "none";
}
@extension("additionalProperties", false)
model LiveSessionConfiguration {
  `model`: "gpt-live-1";
  store: false;
  @minLength(1) @maxLength(16000) instructions: string;
  @maxItems(128) input: (LiveUserMessage | LiveAssistantMessage)[];
  @extension("additionalProperties", false)
  audio: {
    @extension("additionalProperties", false) format: { type: "audio/pcm"; rate: 24000; };
    @extension("additionalProperties", false) output: { voice: "marin" | "harema" | "shida"; };
  };
  @extension("additionalProperties", false)
  delegation: { type: "responses"; responses: LiveResponses; };
}

@jsonSchema
@extension("additionalProperties", false)
model LiveStartEvent {
  type: "session.start";
  @minLength(1) event_id: string;
  session: LiveSessionConfiguration;
}

@extension("additionalProperties", false)
model LiveInputAudioEvent {
  type: "session.input_audio.append";
  @minLength(4) @maxLength(12800) @pattern("^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$") audio: string;
}
@extension("additionalProperties", false)
model LiveCloseEvent { type: "session.close"; }
@extension("additionalProperties", false)
model LiveInstructionEvent {
  type: "session.instructions.append";
  @minLength(1) event_id: string;
  delegation_id: null;
  @minLength(1) @maxLength(2000) content: string;
}
@jsonSchema
union LiveClientEvent { LiveStartEvent, LiveInputAudioEvent, LiveCloseEvent, LiveInstructionEvent, }

// 上流の追加項目は許容するが、アプリで扱う値は必ず検証する。
model LiveStartedEvent { type: "session.started"; @minLength(1) event_id: string; session: { @minLength(1) id: string; }; }
model LiveTranscriptEvent {
  type: "session.input_transcript.delta" | "session.output_transcript.delta";
  @minLength(1) @maxLength(200) event_id: string;
  @maxLength(32768) delta: string;
  @minValue(0) start_ms: float64;
  @minValue(0) end_ms: float64;
}
model LiveAudioEvent {
  type: "session.output_audio.delta";
  @minLength(1) event_id?: string;
  @maxLength(131072) @pattern("^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$") delta: string;
}
model LiveUsage { @minValue(0) seconds: float64; }
model LiveUsageEvent { type: "session.usage.updated"; @minLength(1) event_id: string; usage: LiveUsage; }
model LiveClosedEvent { type: "session.closed"; @minLength(1) event_id: string; usage: LiveUsage; reason: string; }
model LiveErrorEvent { type: "error"; error: { code?: string | null; message?: string; client_event_id?: string | null; }; }

@jsonSchema
union LiveServerEvent {
  LiveStartedEvent, LiveTranscriptEvent, LiveAudioEvent, LiveUsageEvent, LiveClosedEvent, LiveErrorEvent,
}
