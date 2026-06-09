import { RefreshCw } from "lucide-react";

export interface RefreshButtonProps {
  busy?: boolean;
  onClick: () => void;
}

export const RefreshButton = ({ busy = false, onClick }: RefreshButtonProps) => (
  <button
    type="button"
    aria-label="Refresh"
    disabled={busy}
    onClick={onClick}
    className="inline-flex items-center gap-2 rounded-md border border-border-default bg-bg-card px-3 py-1.5 text-sm font-medium text-text-primary transition hover:border-primary hover:text-primary disabled:cursor-not-allowed disabled:opacity-60"
  >
    <RefreshCw aria-hidden="true" className={`size-4 ${busy ? "animate-spin" : ""}`} />
    <span>Refresh</span>
  </button>
);
