import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

type SessionModel = NonNullable<ReturnType<ModelRuntime["getModel"]>>;

export function resolveSessionModel(
  runtime: ModelRuntime,
  llm: Readonly<{ provider: string; model: string; modelArn: string | null }>,
): SessionModel {
  const model = runtime.getModel(llm.provider, llm.model);
  if (!model) throw new Error(`No model found for provider "${llm.provider}" / model "${llm.model}"`);
  // Bedrock bills and meters the call under the ARN (e.g. a tagged profile); Pi reads the model's
  // capabilities (prompt caching, thinking) from the catalog entry, which an ARN may not name.
  return llm.modelArn ? { ...model, id: llm.modelArn } : model;
}
