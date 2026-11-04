import "@typespec/json-schema";

using TypeSpec.JsonSchema;

@jsonSchema
@extension("additionalProperties", false)
model JobNotification {
  schemaVersion: 1;
  @pattern("^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
  jobId: string;
}
