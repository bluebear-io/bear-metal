import type { SessionStats } from "@earendil-works/pi-coding-agent";

import { createLogger } from "../shared/logger.js";

const logger = createLogger({
  level: process.env.LOG_LEVEL ?? "info",
  name: "worker:cost",
  pretty: process.env.LOG_PRETTY === "true" || process.env.LOG_PRETTY === "1",
});

interface PricedModel {
  provider: string;
  id: string;
  cost: { input: number; output: number };
}

/**
 * USD cost of a Pi session, priced per message by Pi's model registry.
 * Returns null when the registry has no pricing for the model (zero input and
 * output rates), since Pi would otherwise report a misleading $0.
 */
export function sessionCostUsd(model: PricedModel, stats: Pick<SessionStats, "cost">): number | null {
  if (model.cost.input === 0 && model.cost.output === 0) {
    logger.warn({ provider: model.provider, model: model.id }, "model has no pricing; run cost is unknown");
    return null;
  }
  if (!Number.isFinite(stats.cost) || stats.cost < 0) {
    throw new Error(`Invalid Pi session cost for ${model.provider}/${model.id}: ${String(stats.cost)}`);
  }
  return stats.cost;
}
