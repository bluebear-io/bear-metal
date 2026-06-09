export const formatDateTime = (iso: string | null): string => {
  if (iso === null) {
    return "—";
  }

  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "—";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
};

const formatWholeMinutes = (minutes: number): string => {
  const safeMinutes = Math.max(0, Math.floor(minutes));

  if (safeMinutes < 60) {
    return `${safeMinutes}m`;
  }

  const hours = Math.floor(safeMinutes / 60);
  const remainingMinutes = safeMinutes % 60;
  return `${hours}h ${remainingMinutes}m`;
};

export const formatDuration = (startIso: string | null, endIso: string | null): string => {
  if (startIso === null) {
    return "—";
  }

  if (endIso === null) {
    return "in progress";
  }

  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return "—";
  }

  return formatWholeMinutes((end - start) / 60_000);
};

export const formatDurationMs = (ms: number | null): string => {
  if (ms === null) {
    return "—";
  }

  return formatWholeMinutes(ms / 60_000);
};

export const formatTokens = (tokens: number | null): string => {
  if (tokens === null) return "—";
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return tokens.toString();
};

export const formatCostUsd = (cost: number | null): string => {
  if (cost === null) return "—";
  if (cost === 0) return "$0";
  if (cost < 0.01) return "<$0.01";
  if (cost < 1) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(2)}`;
};

export const formatPercent = (ratio: number): string => `${(ratio * 100).toFixed(0)}%`;

export const formatSeconds = (seconds: number | null): string => {
  if (seconds === null) return "—";
  if (seconds < 60) return `${seconds.toFixed(0)}s`;
  return formatDurationMs(seconds * 1000);
};

export const parseLabels = (labelsJson: string): string[] => {
  try {
    const labels: unknown = JSON.parse(labelsJson);
    if (!Array.isArray(labels)) {
      return [];
    }

    return labels.filter((label): label is string => typeof label === "string");
  } catch {
    return [];
  }
};
