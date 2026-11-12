import { render, screen } from "@testing-library/react";

import { StatusBadge } from "./StatusBadge.js";

describe("StatusBadge", () => {
  it("renders a humanized status label", () => {
    render(<StatusBadge status="ci_failed" />);

    expect(screen.getByText("ci failed")).toBeVisible();
  });

  it.each([
    ["completed", "var(--color-status-green)"],
    ["passed", "var(--color-status-green)"],
    ["merged", "var(--color-status-green)"],
    ["succeeded", "var(--color-status-green)"],
    ["healthy", "var(--color-status-green)"],
    ["abandoned", "var(--color-status-red)"],
    ["failed", "var(--color-status-red)"],
    ["crashed", "var(--color-status-red)"],
    ["dead", "var(--color-status-red)"],
    ["ci_failed", "var(--color-status-red)"],
    ["timed_out", "var(--color-status-red)"],
    ["heartbeat_stale", "var(--color-status-orange)"],
    ["in_progress", "var(--color-primary)"],
    ["running", "var(--color-primary)"],
    ["dispatched", "var(--color-primary)"],
    ["busy", "var(--color-primary)"],
    ["ci_running", "var(--color-primary)"],
    ["pr_open", "var(--color-primary)"],
    ["open", "var(--color-primary)"],
    ["discovered", "var(--color-text-muted)"],
    ["idle", "var(--color-text-muted)"],
    ["stopped", "var(--color-text-muted)"],
    ["closed", "var(--color-text-muted)"],
    ["fallback", "var(--color-text-muted)"],
  ])("maps %s to the expected tone color", (status, color) => {
    render(<StatusBadge status={status} />);

    expect(screen.getByText(status.replaceAll("_", " "))).toHaveStyle({ color });
  });

  it("uses the fallback tone for unknown statuses", () => {
    render(<StatusBadge status="waiting_for_review" />);

    expect(screen.getByText("waiting for review")).toHaveStyle({ color: "var(--color-text-muted)" });
  });
});
