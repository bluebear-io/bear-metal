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
