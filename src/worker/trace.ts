import type { DbClient } from "../db/client.js";
import { redactCredentials, redactSensitiveText } from "../agent-tools/transport.js";

const MAX_TRACE_FIELD_CHARS = 8_000;

export function traceText(value: string): string {
  const redacted = redactSensitiveText(value);
  return redacted.length > MAX_TRACE_FIELD_CHARS
    ? `${redacted.slice(0, MAX_TRACE_FIELD_CHARS)}… [truncated, ${redacted.length - MAX_TRACE_FIELD_CHARS} more chars]`
    : redacted;
}

export function redactTraceText(value: string): string {
  return redactSensitiveText(value);
}

export function traceJson(value: unknown): string {
  try {
    return traceText(JSON.stringify(redactCredentials(value)) ?? "null");
  } catch (err) {
    throw new Error("Cannot serialize agent trace", { cause: err });
  }
}

export class AgentTraceWriter {
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly db: DbClient, private readonly runId: string) {}

  record(kind: string, content: Record<string, unknown>): void {
    const redacted = redactCredentials(content) as Record<string, unknown>;
    const textValue = typeof redacted.text === "string" ? redacted.text : null;
    const parts = textValue !== null && ["prompt", "assistant_text", "thinking"].includes(kind)
      ? Math.max(1, Math.ceil(textValue.length / MAX_TRACE_FIELD_CHARS))
      : 1;
    for (let index = 0; index < parts; index += 1) {
      const payload = parts === 1 ? redacted : { ...redacted, text: textValue!.slice(index * MAX_TRACE_FIELD_CHARS, (index + 1) * MAX_TRACE_FIELD_CHARS), part: index + 1, parts };
      const contentJson = JSON.stringify(payload);
      this.pending = this.pending.then(() => this.db.recordAgentTrace(this.runId, kind, contentJson));
    }
  }

  async flush(): Promise<void> {
    await this.pending;
  }
}
