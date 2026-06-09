import type { ReactNode } from "react";

export interface QueryBoundaryProps {
  isLoading: boolean;
  error?: Error | null;
  isEmpty?: boolean;
  loadingLabel?: ReactNode;
  emptyLabel?: ReactNode;
  children: ReactNode;
}

export const QueryBoundary = ({
  isLoading,
  error = null,
  isEmpty = false,
  loadingLabel = "Loading...",
  emptyLabel = "No results",
  children,
}: QueryBoundaryProps) => {
  if (isLoading) {
    return <p className="text-sm text-text-secondary">{loadingLabel}</p>;
  }

  if (error !== null) {
    return (
      <div role="alert" className="rounded-md border border-status-red/40 bg-bg-card p-3 text-sm text-status-red">
        {error.message}
      </div>
    );
  }

  if (isEmpty) {
    return <p className="text-sm text-text-muted">{emptyLabel}</p>;
  }

  return <>{children}</>;
};
