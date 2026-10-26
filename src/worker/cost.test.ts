import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { sessionCostUsd } from "./cost.js";

describe("sessionCostUsd", () => {
  it("returns Pi's session cost for a model with registry pricing", async () => {
    const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
    for (const [provider, id] of [
      ["anthropic", "claude-opus-5-5"],
      ["amazon-bedrock", "us.anthropic.claude-opus-4-6-v1"],
    ] as const) {
      const model = runtime.getModel(provider, id);
      if (!model) throw new Error(`${provider}/${id} missing from Pi registry`);
      expect(model.cost.input).toBeGreaterThan(0);
      expect(sessionCostUsd(model, { cost: 2.5 })).toBe(2.5);
    }
  });

  it("reports unknown cost instead of $0 when the model has no pricing", () => {
    const model = { provider: "custom", id: "local", cost: { input: 0, output: 0 } };
    expect(sessionCostUsd(model, { cost: 0 })).toBeNull();
  });

  it("rejects an invalid session cost", () => {
    const model = { provider: "anthropic", id: "claude", cost: { input: 5, output: 25 } };
    expect(() => sessionCostUsd(model, { cost: Number.NaN })).toThrow("Invalid Pi session cost");
    expect(() => sessionCostUsd(model, { cost: undefined as unknown as number })).toThrow("Invalid Pi session cost");
  });
});
