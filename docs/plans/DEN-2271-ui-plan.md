# Bear Metal Dashboard — UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the read-only dashboard frontend — a Vite + React 19 SPA (`src/ui/`) that renders a tickets list, a ticket detail view, and a workers panel from the backend API, styled with ported BlueBear design tokens.

**Architecture:** A self-contained Vite app under `src/ui/` with its OWN `package.json`/`tsconfig`/toolchain (already excluded from the root `tsc` build). It talks to the Express backend over HTTP (`/api/*`), proxied in dev to `localhost:3100`. TanStack Query handles fetching/caching with a manual refetch button (no polling). react-router-dom for three routes.

**Tech Stack:** React 19, Vite, TypeScript (strict), Tailwind CSS 4 (`@tailwindcss/vite`), react-router-dom 6, @tanstack/react-query, lucide-react, Vitest + Testing Library + jsdom.

**Spec:** [docs/plans/DEN-2271.md](DEN-2271.md) · **Backend (done):** [docs/plans/DEN-2271-backend-plan.md](DEN-2271-backend-plan.md)

---

## API contract (verified against the built backend)

Base path `/api`. **All timestamp columns are serialized as ISO strings** (the backend stores `Date`/`timestamp_ms`; `res.json` → ISO string). `labelsJson` is a JSON-encoded string (e.g. `'["bear-metal"]'`).

- `GET /api/health` → `{ status: "ok" }`
- `GET /api/tickets[?status=<bmStatus>]` → `{ tickets: TicketListItem[] }` (newest-first; includes latest run summary; invalid status → 400)
- `GET /api/tickets/:id` → `TicketDetail` (404 if missing)
- `GET /api/workers` → `{ workers: WorkerListItem[] }` (includes current run and health flags)

Shapes (HTTP/serialized form) are defined in Task U1 (`src/ui/src/api/types.ts`).

---

## File Structure (`src/ui/`)

```
src/ui/
  package.json          # own deps + scripts (dev/build/test)
  tsconfig.json         # browser/DOM, strict; references node config
  tsconfig.node.json    # for vite.config.ts
  vite.config.ts        # react + tailwind plugins; dev proxy /api → :3100; vitest config
  index.html
  src/
    main.tsx            # React root + QueryClientProvider + RouterProvider
    App.tsx             # routes + layout shell (nav)
    index.css           # @import tailwindcss + ported BlueBear tokens (light/dark)
    test/setup.ts       # jest-dom matchers
    lib/format.ts       # date/duration/label helpers
    api/types.ts        # serialized API types
    api/client.ts       # fetch wrappers (fail-fast on !ok)
    api/queries.ts      # TanStack Query hooks
    components/
      PageHeader.tsx
      StatusBadge.tsx
      DataTable.tsx
      RefreshButton.tsx
      ThemeToggle.tsx
      QueryBoundary.tsx # loading / error / empty states
    pages/
      TicketsListPage.tsx
      TicketDetailPage.tsx
      WorkersPage.tsx
```

All component/page files get a colocated `*.test.tsx`.

---

## Task U0: Scaffold the Vite app

**Files:** create `src/ui/package.json`, `src/ui/tsconfig.json`, `src/ui/tsconfig.node.json`, `src/ui/vite.config.ts`, `src/ui/index.html`, `src/ui/src/main.tsx`, `src/ui/src/App.tsx`, `src/ui/src/index.css`, `src/ui/src/test/setup.ts`, `src/ui/src/App.test.tsx`.

- [ ] **Step 1: Create `src/ui/package.json`**

Pin EXACT versions (per CONTRIBUTING: no `^`/`~`, and respect the 4-week quarantine — pick versions published ≥4 weeks ago). Use `console/package.json` as a known-good baseline for shared libs (react 19.1.2, tailwindcss 4.x, vitest, testing-library, jsdom, typescript). Resolve exact compliant versions at install time.

```json
{
  "name": "bear-metal-ui",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite --host 127.0.0.1 --port 5273",
    "build": "tsc -p tsconfig.json --noEmit && tsc -p tsconfig.node.json --noEmit && vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit --pretty false && tsc -p tsconfig.node.json --noEmit --pretty false"
  },
  "dependencies": {
    "@tanstack/react-query": "<pin>",
    "lucide-react": "<pin>",
    "react": "<pin>",
    "react-dom": "<pin>",
    "react-router-dom": "<pin>"
  },
  "devDependencies": {
    "@tailwindcss/vite": "<pin>",
    "@testing-library/jest-dom": "<pin>",
    "@testing-library/react": "<pin>",
    "@testing-library/user-event": "<pin>",
    "@types/react": "<pin>",
    "@types/react-dom": "<pin>",
    "@vitejs/plugin-react": "<pin>",
    "jsdom": "<pin>",
    "tailwindcss": "<pin>",
    "typescript": "<pin>",
    "vite": "<pin>",
    "vitest": "<pin>"
  }
}
```

- [ ] **Step 2: Install** — run `cd src/ui && npm install <each pkg>@<exact>` so versions save exact. Confirm no `^`/`~` in `src/ui/package.json`. (This creates `src/ui/package-lock.json` — the UI is its own npm project, independent of the root package, per the agreed structure.)

- [ ] **Step 3: `src/ui/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noEmit": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "types": ["vitest/globals", "@testing-library/jest-dom"]
  },
  "include": ["src"]
}
```

- [ ] **Step 4: `src/ui/tsconfig.node.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "composite": true,
    "strict": true,
    "skipLibCheck": true
  },
  "include": ["vite.config.ts"]
}
```

- [ ] **Step 5: `src/ui/vite.config.ts`** (react + tailwind plugins, dev proxy, vitest jsdom)

```ts
/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5273,
    proxy: { "/api": "http://localhost:3100" },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    css: true,
  },
});
```

- [ ] **Step 6: `src/ui/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Bear Metal</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 7: `src/ui/src/index.css`** — Tailwind 4 + ported BlueBear tokens

Port the token blocks verbatim from `console/src/app/globals.css` (`:root` and `.dark`). Minimal faithful subset:

```css
@import "tailwindcss";

@custom-variant dark (&:where(.dark, .dark *));

:root {
  --color-bg-page: oklch(98.5% 0.002 247.839);
  --color-bg-card: #ffffff;
  --color-text-primary: #0f172a;
  --color-text-secondary: #64748b;
  --color-text-muted: #94a3b8;
  --color-border-default: #e2e8f0;
  --color-primary: oklch(0.46 0.14 258.69);
  --color-status-red: #dc2626;
  --color-status-orange: #ea580c;
  --color-status-green: #16a34a;
}
.dark {
  --color-bg-page: #10141c;
  --color-bg-card: #1a1f2b;
  --color-text-primary: #f1f5f9;
  --color-text-secondary: #94a3b8;
  --color-text-muted: #64748b;
  --color-border-default: #2a3142;
  --color-primary: #3b82f6;
  --color-status-red: #ef4444;
  --color-status-orange: #f97316;
  --color-status-green: #22c55e;
}
@theme inline {
  --color-bg-page: var(--color-bg-page);
  --color-bg-card: var(--color-bg-card);
  --color-text-primary: var(--color-text-primary);
  --color-text-secondary: var(--color-text-secondary);
  --color-text-muted: var(--color-text-muted);
  --color-border-default: var(--color-border-default);
  --color-primary: var(--color-primary);
  --color-status-red: var(--color-status-red);
  --color-status-orange: var(--color-status-orange);
  --color-status-green: var(--color-status-green);
}
body { background-color: var(--color-bg-page); color: var(--color-text-primary); }
```

- [ ] **Step 8: `src/ui/src/test/setup.ts`**

```ts
import "@testing-library/jest-dom/vitest";
```

- [ ] **Step 9: `src/ui/src/App.tsx`** (placeholder shell; routes added in U6)

```tsx
export default function App() {
  return <div data-testid="app-root">Bear Metal</div>;
}
```

- [ ] **Step 10: `src/ui/src/main.tsx`**

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.js";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```
(Note: under `moduleResolution: bundler`, extensionless or `.js` specifiers both resolve; the examples use `./App.js` — keep imports consistent within the app. If the implementer prefers extensionless TS imports for the SPA, that's acceptable as long as it's consistent and typechecks.)

- [ ] **Step 11: Smoke test `src/ui/src/App.test.tsx`**

```tsx
import { render, screen } from "@testing-library/react";
import App from "./App.js";

test("renders the app root", () => {
  render(<App />);
  expect(screen.getByTestId("app-root")).toBeInTheDocument();
});
```

- [ ] **Step 12: Verify** — from `src/ui/`: `npm test` (1 passing), `npm run typecheck` (clean), `npm run build` (produces `dist/`). Confirm `src/ui/dist` and `src/ui/node_modules` are gitignored (add to root `.gitignore` if not — check first).

- [ ] **Step 13: Commit**
```bash
git add src/ui/package.json src/ui/package-lock.json src/ui/tsconfig.json src/ui/tsconfig.node.json src/ui/vite.config.ts src/ui/index.html src/ui/src .gitignore
git commit -m "chore(ui): [DEN-2271] scaffold vite + react dashboard app with design tokens"
```

---

## Task U1: API types and client

**Files:** create `src/ui/src/api/types.ts`, `src/ui/src/api/client.ts`, `src/ui/src/api/client.test.ts`.

- [ ] **Step 1: Write `src/ui/src/api/types.ts`** (serialized/HTTP shapes — timestamps are strings)

```ts
export type BmStatus =
  | "discovered" | "dispatched" | "in_progress" | "pr_open"
  | "ci_running" | "ci_failed" | "completed" | "abandoned";
export type WorkerStatus = "idle" | "busy" | "stopped" | "dead";
export type RunStatus = "dispatched" | "running" | "succeeded" | "failed" | "timed_out" | "crashed";
export type RunTrigger = "new" | "ci_failure" | "delegated_back";
export type CiStatus = "running" | "passed" | "failed";

export interface Ticket {
  id: string; identifier: string; title: string; description: string | null;
  url: string; branchName: string; linearStatusName: string; linearStatusType: string;
  labelsJson: string; bmStatus: BmStatus; attemptCount: number; maxAttempts: number;
  createdAt: string; updatedAt: string; completedAt: string | null;
}
export interface LatestRunSummary {
  id: string; attemptNumber: number; status: RunStatus; trigger: RunTrigger;
  workerId: string | null; startedAt: string | null; endedAt: string | null; createdAt: string;
}
export interface TicketListItem extends Ticket {
  latestRun: LatestRunSummary | null;
  latestPr: { number: number; url: string; state: "open" | "closed"; merged: boolean } | null;
  latestCiStatus: CiStatus | null;
}
export interface Worker {
  id: string; name: string; status: WorkerStatus; currentRunId: string | null;
  lastHeartbeatAt: string | null; startedAt: string; updatedAt: string;
}
export interface CurrentRunSummary extends LatestRunSummary {
  ticketId: string; ticketIdentifier: string; ticketTitle: string; runtimeMs: number | null;
}
export interface WorkerListItem extends Worker {
  currentTicketIdentifier: string | null;
  currentTicketTitle: string | null;
  currentRun: CurrentRunSummary | null;
  heartbeatAgeMs: number | null;
  isDead: boolean;
  isHeartbeatStale: boolean;
  isTimedOut: boolean;
}
export interface Run {
  id: string; ticketId: string; attemptNumber: number; workerId: string | null;
  trigger: RunTrigger; status: RunStatus; contextJson: string | null;
  startedAt: string | null; endedAt: string | null;
  stopReason: "completed" | "timeout" | "crash" | "error" | null; error: string | null; createdAt: string;
  worker: Worker | null;
}
export interface PullRequest {
  id: string; ticketId: string; number: number; title: string; headRef: string;
  state: "open" | "closed"; draft: boolean; merged: boolean; url: string;
  lastRunId: string | null; createdAt: string; updatedAt: string;
}
export interface CiRun {
  id: string; ticketId: string; runId: string; prId: string | null;
  status: CiStatus; url: string | null; summary: string | null;
  createdAt: string; completedAt: string | null;
}
export interface TicketEvent {
  id: string; ticketId: string | null; runId: string | null; workerId: string | null;
  source: "manager" | "worker" | "ci"; type: string; summary: string;
  payloadJson: string | null; createdAt: string;
}
export interface TicketDetail {
  ticket: Ticket; runs: Run[]; pullRequests: PullRequest[]; ciRuns: CiRun[]; events: TicketEvent[];
}
```

- [ ] **Step 2: Write the failing test `src/ui/src/api/client.test.ts`**

```tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchTickets, fetchTicketDetail, fetchWorkers } from "./client.js";

function mockFetch(status: number, body: unknown) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response);
}
afterEach(() => vi.restoreAllMocks());

describe("api client", () => {
  it("fetchTickets returns the tickets array and passes the status filter", async () => {
    mockFetch(200, { tickets: [{ identifier: "DEN-1" }] });
    const out = await fetchTickets("abandoned");
    expect(out).toEqual([{ identifier: "DEN-1" }]);
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/tickets?status=abandoned");
  });

  it("fetchTickets omits the query when no filter", async () => {
    mockFetch(200, { tickets: [] });
    await fetchTickets();
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/tickets");
  });

  it("fetchTicketDetail returns the detail object", async () => {
    mockFetch(200, { ticket: { id: "lin_2" }, runs: [], pullRequests: [], ciRuns: [], events: [] });
    const out = await fetchTicketDetail("lin_2");
    expect(out.ticket.id).toBe("lin_2");
  });

  it("fails fast (throws) on a non-OK response", async () => {
    mockFetch(500, {});
    await expect(fetchWorkers()).rejects.toThrow(/500/);
  });
});
```

- [ ] **Step 3: Run test → FAIL** (`Cannot find module './client.js'`). Run: `cd src/ui && npm test -- src/api/client.test.ts`.

- [ ] **Step 4: Write `src/ui/src/api/client.ts`**

```ts
import type { TicketListItem, TicketDetail, WorkerListItem, BmStatus } from "./types.js";

const BASE = "/api";

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) {
    throw new Error(`API request ${path} failed: ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function fetchTickets(status?: BmStatus): Promise<TicketListItem[]> {
  const qs = status ? `?status=${status}` : "";
  const data = await getJson<{ tickets: TicketListItem[] }>(`/tickets${qs}`);
  return data.tickets;
}

export function fetchTicketDetail(id: string): Promise<TicketDetail> {
  return getJson<TicketDetail>(`/tickets/${encodeURIComponent(id)}`);
}

export async function fetchWorkers(): Promise<WorkerListItem[]> {
  const data = await getJson<{ workers: WorkerListItem[] }>("/workers");
  return data.workers;
}
```

- [ ] **Step 5: Run test → PASS (4).** `npm run typecheck` clean.

- [ ] **Step 6: Commit**
```bash
git add src/ui/src/api
git commit -m "feat(ui): [DEN-2271] add API types and fail-fast fetch client"
```

---

## Task U2: Query hooks + format helpers + shared primitives

**Files:** create `src/ui/src/api/queries.ts`, `src/ui/src/lib/format.ts` (+ `format.test.ts`), `src/ui/src/components/{StatusBadge,PageHeader,RefreshButton,QueryBoundary}.tsx` (+ `StatusBadge.test.tsx`).

- [ ] **Step 1: `src/ui/src/api/queries.ts`**

```ts
import { useQuery } from "@tanstack/react-query";
import { fetchTickets, fetchTicketDetail, fetchWorkers } from "./client.js";
import type { BmStatus } from "./types.js";

export const useTickets = (status?: BmStatus) =>
  useQuery({ queryKey: ["tickets", status ?? "all"], queryFn: () => fetchTickets(status) });

export const useTicketDetail = (id: string) =>
  useQuery({ queryKey: ["ticket", id], queryFn: () => fetchTicketDetail(id) });

export const useWorkers = () =>
  useQuery({ queryKey: ["workers"], queryFn: () => fetchWorkers() });
```

- [ ] **Step 2: failing test `src/ui/src/lib/format.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { formatDateTime, formatDuration, formatDurationMs, parseLabels } from "./format.js";

describe("format", () => {
  it("formats an ISO timestamp to a readable local string", () => {
    expect(formatDateTime("2026-06-09T07:05:00.000Z")).toMatch(/2026/);
  });
  it("renders a dash for null timestamps", () => {
    expect(formatDateTime(null)).toBe("—");
  });
  it("formats a duration between two ISO times", () => {
    expect(formatDuration("2026-06-09T07:00:00Z", "2026-06-09T07:45:00Z")).toBe("45m");
  });
  it("formats a duration in milliseconds", () => {
    expect(formatDurationMs(6 * 60000)).toBe("6m");
  });
  it("returns 'in progress' when end is null", () => {
    expect(formatDuration("2026-06-09T07:00:00Z", null)).toBe("in progress");
  });
  it("parses a labelsJson string into an array", () => {
    expect(parseLabels('["bear-metal","module:bff"]')).toEqual(["bear-metal", "module:bff"]);
  });
  it("returns [] for invalid labelsJson", () => {
    expect(parseLabels("not json")).toEqual([]);
  });
});
```

- [ ] **Step 3: Run → FAIL. Then write `src/ui/src/lib/format.ts`**

```ts
export function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

export function formatDuration(startIso: string | null, endIso: string | null): string {
  if (!startIso) return "—";
  if (!endIso) return "in progress";
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  return formatDurationMs(ms);
}

export function formatDurationMs(ms: number | null): string {
  if (ms === null) return "—";
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  return `${h}h ${mins % 60}m`;
}

export function parseLabels(labelsJson: string): string[] {
  try {
    const parsed: unknown = JSON.parse(labelsJson);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: Run → PASS (7).**

- [ ] **Step 5: `src/ui/src/components/StatusBadge.tsx`** — colored pill keyed by status

```tsx
const TONE: Record<string, string> = {
  green: "bg-[var(--color-status-green)]/15 text-[var(--color-status-green)]",
  red: "bg-[var(--color-status-red)]/15 text-[var(--color-status-red)]",
  orange: "bg-[var(--color-status-orange)]/15 text-[var(--color-status-orange)]",
  gray: "bg-[var(--color-text-muted)]/15 text-[var(--color-text-secondary)]",
  blue: "bg-[var(--color-primary)]/15 text-[var(--color-primary)]",
};
const STATUS_TONE: Record<string, keyof typeof TONE> = {
  completed: "green", passed: "green", merged: "green", succeeded: "green", healthy: "green",
  abandoned: "red", failed: "red", crashed: "red", dead: "red", ci_failed: "red", timed_out: "red",
  in_progress: "blue", running: "blue", dispatched: "blue", busy: "blue", ci_running: "blue", pr_open: "blue",
  heartbeat_stale: "orange",
  discovered: "gray", idle: "gray", stopped: "gray", open: "blue", closed: "gray",
};
export function StatusBadge({ status }: { status: string }) {
  const tone = TONE[STATUS_TONE[status] ?? "gray"];
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}>
      {status.replace(/_/g, " ")}
    </span>
  );
}
```

- [ ] **Step 6: test `src/ui/src/components/StatusBadge.test.tsx`**

```tsx
import { render, screen } from "@testing-library/react";
import { StatusBadge } from "./StatusBadge.js";

test("renders the humanized status label", () => {
  render(<StatusBadge status="ci_failed" />);
  expect(screen.getByText("ci failed")).toBeInTheDocument();
});
```

- [ ] **Step 7: `src/ui/src/components/PageHeader.tsx`**

```tsx
import type { ReactNode } from "react";
export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <header className="mb-6 flex items-center justify-between">
      <h1 className="text-xl font-semibold text-[var(--color-text-primary)]">{title}</h1>
      <div className="flex items-center gap-2">{children}</div>
    </header>
  );
}
```

- [ ] **Step 8: `src/ui/src/components/RefreshButton.tsx`**

```tsx
import { RefreshCw } from "lucide-react";
export function RefreshButton({ onClick, busy }: { onClick: () => void; busy: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      aria-label="Refresh"
      className="inline-flex items-center gap-1 rounded-md border border-[var(--color-border-default)] px-2 py-1 text-sm disabled:opacity-50"
    >
      <RefreshCw className={`h-4 w-4 ${busy ? "animate-spin" : ""}`} />
      Refresh
    </button>
  );
}
```

- [ ] **Step 9: `src/ui/src/components/QueryBoundary.tsx`** — loading/error/empty wrapper

```tsx
import type { ReactNode } from "react";
interface Props {
  isLoading: boolean;
  error: unknown;
  isEmpty?: boolean;
  emptyLabel?: string;
  children: ReactNode;
}
export function QueryBoundary({ isLoading, error, isEmpty, emptyLabel, children }: Props) {
  if (isLoading) return <p className="text-[var(--color-text-secondary)]">Loading…</p>;
  if (error) {
    return (
      <p role="alert" className="text-[var(--color-status-red)]">
        Failed to load: {error instanceof Error ? error.message : "unknown error"}
      </p>
    );
  }
  if (isEmpty) return <p className="text-[var(--color-text-secondary)]">{emptyLabel ?? "Nothing to show."}</p>;
  return <>{children}</>;
}
```

- [ ] **Step 10: Verify** `npm test` + `npm run typecheck`.

- [ ] **Step 11: Commit**
```bash
git add src/ui/src/api/queries.ts src/ui/src/lib src/ui/src/components
git commit -m "feat(ui): [DEN-2271] add query hooks, format helpers, shared primitives"
```

---

## Task U3: Tickets list page

**Files:** create `src/ui/src/pages/TicketsListPage.tsx`, `src/ui/src/pages/TicketsListPage.test.tsx`. **Test helper:** a `renderWithProviders` util (create `src/ui/src/test/utils.tsx`) that wraps a component in a fresh QueryClientProvider + MemoryRouter.

- [ ] **Step 1: `src/ui/src/test/utils.tsx`**

```tsx
import type { ReactElement } from "react";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

export function renderWithProviders(ui: ReactElement, route = "/") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}
```

- [ ] **Step 2: failing test `src/ui/src/pages/TicketsListPage.test.tsx`** (mock the client module)

```tsx
import { vi, beforeEach, expect, test } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "../test/utils.js";

vi.mock("../api/client.js", () => ({
  fetchTickets: vi.fn().mockResolvedValue([
    { id: "lin_1", identifier: "DEN-3001", title: "Rate limit", url: "u", branchName: "b",
      linearStatusName: "Done", linearStatusType: "completed", labelsJson: "[]",
      bmStatus: "completed", attemptCount: 1, maxAttempts: 5,
      createdAt: "2026-06-09T07:05:00Z", updatedAt: "2026-06-09T07:55:00Z", completedAt: "2026-06-09T07:55:00Z",
      description: null,
      latestRun: { id: "run_1", attemptNumber: 1, status: "succeeded", trigger: "new", workerId: "wk_1", startedAt: "2026-06-09T07:05:00Z", endedAt: "2026-06-09T07:50:00Z", createdAt: "2026-06-09T07:05:00Z" },
      latestPr: { number: 1500, url: "pr", state: "closed", merged: true }, latestCiStatus: "passed" },
  ]),
}));

import { TicketsListPage } from "./TicketsListPage.js";

beforeEach(() => vi.clearAllMocks());

test("renders ticket rows with identifier, status, attempts and PR link", async () => {
  renderWithProviders(<TicketsListPage />);
  expect(await screen.findByText("DEN-3001")).toBeInTheDocument();
  expect(screen.getByText("completed")).toBeInTheDocument();
  expect(screen.getByText("succeeded")).toBeInTheDocument();
  expect(screen.getByText("1/5")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /#1500/ })).toHaveAttribute("href", "pr");
});
```

- [ ] **Step 3: Run → FAIL. Then write `src/ui/src/pages/TicketsListPage.tsx`**

```tsx
import { Link } from "react-router-dom";
import { useTickets } from "../api/queries.js";
import { PageHeader } from "../components/PageHeader.js";
import { RefreshButton } from "../components/RefreshButton.js";
import { StatusBadge } from "../components/StatusBadge.js";
import { QueryBoundary } from "../components/QueryBoundary.js";
import { formatDateTime } from "../lib/format.js";

export function TicketsListPage() {
  const q = useTickets();
  const tickets = q.data ?? [];
  return (
    <section>
      <PageHeader title="Tickets">
        <RefreshButton onClick={() => void q.refetch()} busy={q.isFetching} />
      </PageHeader>
      <QueryBoundary isLoading={q.isLoading} error={q.error} isEmpty={tickets.length === 0} emptyLabel="No tickets yet.">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="text-left text-[var(--color-text-secondary)]">
              <th className="py-2">Ticket</th><th>Title</th><th>Status</th><th>Latest run</th><th>Attempts</th><th>CI</th><th>PR</th><th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {tickets.map((t) => (
              <tr key={t.id} className="border-t border-[var(--color-border-default)]">
                <td className="py-2">
                  <Link className="text-[var(--color-primary)]" to={`/tickets/${t.id}`}>{t.identifier}</Link>
                </td>
                <td>{t.title}</td>
                <td><StatusBadge status={t.bmStatus} /></td>
                <td>{t.latestRun ? <StatusBadge status={t.latestRun.status} /> : "—"}</td>
                <td>{t.attemptCount}/{t.maxAttempts}</td>
                <td>{t.latestCiStatus ? <StatusBadge status={t.latestCiStatus} /> : "—"}</td>
                <td>{t.latestPr ? <a className="text-[var(--color-primary)]" href={t.latestPr.url}>#{t.latestPr.number}</a> : "—"}</td>
                <td>{formatDateTime(t.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </QueryBoundary>
    </section>
  );
}
```

- [ ] **Step 4: Run → PASS.** `npm run typecheck` clean.

- [ ] **Step 5: Commit**
```bash
git add src/ui/src/pages/TicketsListPage.tsx src/ui/src/pages/TicketsListPage.test.tsx src/ui/src/test/utils.tsx
git commit -m "feat(ui): [DEN-2271] add tickets list page"
```

---

## Task U4: Ticket detail page

**Files:** create `src/ui/src/pages/TicketDetailPage.tsx`, `src/ui/src/pages/TicketDetailPage.test.tsx`.

- [ ] **Step 1: failing test `TicketDetailPage.test.tsx`** (mock client; render at route `/tickets/lin_2` with a `<Routes>` so `useParams` resolves)

```tsx
import { vi, beforeEach, expect, test } from "vitest";
import { screen } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { renderWithProviders } from "../test/utils.js";

vi.mock("../api/client.js", () => ({
  fetchTicketDetail: vi.fn().mockResolvedValue({
    ticket: { id: "lin_2", identifier: "DEN-3002", title: "Flaky test", url: "u", branchName: "feature/x",
      linearStatusName: "In Progress", linearStatusType: "started", labelsJson: '["bear-metal"]',
      bmStatus: "ci_failed", attemptCount: 2, maxAttempts: 5,
      createdAt: "2026-06-09T08:00:00Z", updatedAt: "2026-06-09T08:50:00Z", completedAt: null, description: "race" },
    runs: [
      { id: "run_2", ticketId: "lin_2", attemptNumber: 1, workerId: "wk_1", trigger: "new", status: "succeeded",
        contextJson: null, startedAt: "2026-06-09T08:00:00Z", endedAt: "2026-06-09T08:20:00Z", stopReason: "completed",
        error: null, createdAt: "2026-06-09T08:00:00Z", worker: { id: "wk_1", name: "worker-1", status: "busy", currentRunId: null, lastHeartbeatAt: null, startedAt: "2026-06-09T07:00:00Z", updatedAt: "2026-06-09T08:00:00Z" } },
      { id: "run_3", ticketId: "lin_2", attemptNumber: 2, workerId: "wk_2", trigger: "ci_failure", status: "running",
        contextJson: null, startedAt: "2026-06-09T08:45:00Z", endedAt: null, stopReason: null, error: null,
        createdAt: "2026-06-09T08:45:00Z", worker: { id: "wk_2", name: "worker-2", status: "busy", currentRunId: "run_3", lastHeartbeatAt: null, startedAt: "2026-06-09T07:00:00Z", updatedAt: "2026-06-09T08:45:00Z" } },
    ],
    pullRequests: [{ id: "pr_2", ticketId: "lin_2", number: 1501, title: "Fix", headRef: "feature/x", state: "open", draft: false, merged: false, url: "pr", lastRunId: "run_3", createdAt: "x", updatedAt: "y" }],
    ciRuns: [{ id: "ci_2", ticketId: "lin_2", runId: "run_2", prId: "pr_2", status: "failed", url: "ci", summary: "1 failing", createdAt: "x", completedAt: "y" }],
    events: [{ id: "ev_5", ticketId: "lin_2", runId: "run_2", workerId: null, source: "ci", type: "ci_failed", summary: "CI failed", payloadJson: null, createdAt: "2026-06-09T08:40:00Z" }],
  }),
}));

import { TicketDetailPage } from "./TicketDetailPage.js";

beforeEach(() => vi.clearAllMocks());

test("renders ticket header, attempts, PR, CI and timeline", async () => {
  renderWithProviders(<Routes><Route path="/tickets/:id" element={<TicketDetailPage />} /></Routes>, "/tickets/lin_2");
  expect(await screen.findByText("DEN-3002")).toBeInTheDocument();
  expect(screen.getByText(/attempt 2/i)).toBeInTheDocument();   // run_3
  expect(screen.getByText("worker-2")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /#1501/ })).toBeInTheDocument();
  expect(screen.getByText("CI failed")).toBeInTheDocument();    // event summary
});
```

- [ ] **Step 2: Run → FAIL. Then write `src/ui/src/pages/TicketDetailPage.tsx`**

```tsx
import { useParams, Link } from "react-router-dom";
import { useTicketDetail } from "../api/queries.js";
import { PageHeader } from "../components/PageHeader.js";
import { RefreshButton } from "../components/RefreshButton.js";
import { StatusBadge } from "../components/StatusBadge.js";
import { QueryBoundary } from "../components/QueryBoundary.js";
import { formatDateTime, formatDuration } from "../lib/format.js";

export function TicketDetailPage() {
  const { id = "" } = useParams();
  const q = useTicketDetail(id);
  const d = q.data;
  return (
    <section>
      <PageHeader title={d ? d.ticket.identifier : "Ticket"}>
        <Link className="text-sm text-[var(--color-primary)]" to="/">← Tickets</Link>
        <RefreshButton onClick={() => void q.refetch()} busy={q.isFetching} />
      </PageHeader>
      <QueryBoundary isLoading={q.isLoading} error={q.error}>
        {d && (
          <div className="space-y-6">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="font-medium">{d.ticket.title}</h2>
                <StatusBadge status={d.ticket.bmStatus} />
                <span className="text-sm text-[var(--color-text-secondary)]">{d.ticket.attemptCount}/{d.ticket.maxAttempts} attempts</span>
              </div>
              <a className="text-sm text-[var(--color-primary)]" href={d.ticket.url}>Open in Linear</a>
              <span className="ml-3 text-sm text-[var(--color-text-muted)]">{d.ticket.branchName}</span>
            </div>

            <div>
              <h3 className="mb-2 text-sm font-semibold text-[var(--color-text-secondary)]">Attempts</h3>
              <ul className="space-y-1">
                {d.runs.map((r) => (
                  <li key={r.id} className="flex items-center gap-3 text-sm">
                    <span>Attempt {r.attemptNumber}</span>
                    <StatusBadge status={r.status} />
                    <span className="text-[var(--color-text-muted)]">{r.trigger}</span>
                    <span>{r.worker?.name ?? "—"}</span>
                    <span className="text-[var(--color-text-muted)]">{formatDuration(r.startedAt, r.endedAt)}</span>
                    {r.error && <span className="text-[var(--color-status-red)]">{r.error}</span>}
                  </li>
                ))}
              </ul>
            </div>

            <div>
              <h3 className="mb-2 text-sm font-semibold text-[var(--color-text-secondary)]">Pull requests</h3>
              {d.pullRequests.length === 0 ? <p className="text-sm text-[var(--color-text-muted)]">None</p> : (
                <ul className="space-y-1 text-sm">
                  {d.pullRequests.map((pr) => (
                    <li key={pr.id} className="flex items-center gap-2">
                      <a className="text-[var(--color-primary)]" href={pr.url}>#{pr.number}</a>
                      <StatusBadge status={pr.merged ? "merged" : pr.state} />
                      <span>{pr.title}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div>
              <h3 className="mb-2 text-sm font-semibold text-[var(--color-text-secondary)]">Timeline</h3>
              <ul className="space-y-1 text-sm">
                {d.events.map((e) => (
                  <li key={e.id} className="flex gap-3">
                    <span className="text-[var(--color-text-muted)] w-40 shrink-0">{formatDateTime(e.createdAt)}</span>
                    <span className="text-[var(--color-text-muted)]">{e.source}</span>
                    <span>{e.summary}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </QueryBoundary>
    </section>
  );
}
```

- [ ] **Step 3: Run → PASS.** typecheck clean.

- [ ] **Step 4: Commit**
```bash
git add src/ui/src/pages/TicketDetailPage.tsx src/ui/src/pages/TicketDetailPage.test.tsx
git commit -m "feat(ui): [DEN-2271] add ticket detail page"
```

---

## Task U5: Workers page

**Files:** create `src/ui/src/pages/WorkersPage.tsx`, `src/ui/src/pages/WorkersPage.test.tsx`.

- [ ] **Step 1: failing test `WorkersPage.test.tsx`**

```tsx
import { vi, beforeEach, expect, test } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "../test/utils.js";

vi.mock("../api/client.js", () => ({
  fetchWorkers: vi.fn().mockResolvedValue([
    {
      id: "wk_1", name: "worker-1", status: "busy", currentRunId: "run_in_1",
      lastHeartbeatAt: "2026-06-09T09:00:00Z", startedAt: "2026-06-09T07:00:00Z", updatedAt: "2026-06-09T09:00:00Z",
      currentTicketIdentifier: "DEN-3004", currentTicketTitle: "CSV export",
      currentRun: {
        id: "run_in_1", ticketId: "lin_4", ticketIdentifier: "DEN-3004", ticketTitle: "CSV export",
        attemptNumber: 1, status: "running", trigger: "new", workerId: "wk_1",
        startedAt: "2026-06-09T08:55:00Z", endedAt: null, createdAt: "2026-06-09T08:55:00Z", runtimeMs: 6 * 60000,
      },
      heartbeatAgeMs: 60000, isDead: false, isHeartbeatStale: false, isTimedOut: false,
    },
    {
      id: "wk_3", name: "worker-3", status: "dead", currentRunId: null,
      lastHeartbeatAt: "2026-06-09T08:10:00Z", startedAt: "2026-06-09T07:00:00Z", updatedAt: "2026-06-09T08:40:00Z",
      currentTicketIdentifier: null, currentTicketTitle: null, currentRun: null,
      heartbeatAgeMs: 51 * 60000, isDead: true, isHeartbeatStale: true, isTimedOut: false,
    },
  ]),
}));

import { WorkersPage } from "./WorkersPage.js";

beforeEach(() => vi.clearAllMocks());

test("renders workers with status and current ticket", async () => {
  renderWithProviders(<WorkersPage />);
  expect(await screen.findByText("worker-1")).toBeInTheDocument();
  expect(screen.getByText("busy")).toBeInTheDocument();
  expect(screen.getByText("DEN-3004")).toBeInTheDocument();
  expect(screen.getByText("running")).toBeInTheDocument();
  expect(screen.getByText("6m")).toBeInTheDocument();
  expect(screen.getByText("healthy")).toBeInTheDocument();
  expect(screen.getByText("dead")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run → FAIL. Then write `src/ui/src/pages/WorkersPage.tsx`**

```tsx
import { useWorkers } from "../api/queries.js";
import { PageHeader } from "../components/PageHeader.js";
import { RefreshButton } from "../components/RefreshButton.js";
import { StatusBadge } from "../components/StatusBadge.js";
import { QueryBoundary } from "../components/QueryBoundary.js";
import { formatDateTime, formatDurationMs } from "../lib/format.js";

function workerHealth(w: { isDead: boolean; isTimedOut: boolean; isHeartbeatStale: boolean }): "dead" | "timed_out" | "heartbeat_stale" | "healthy" {
  if (w.isDead) return "dead";
  if (w.isTimedOut) return "timed_out";
  if (w.isHeartbeatStale) return "heartbeat_stale";
  return "healthy";
}

export function WorkersPage() {
  const q = useWorkers();
  const workers = q.data ?? [];
  return (
    <section>
      <PageHeader title="Workers">
        <RefreshButton onClick={() => void q.refetch()} busy={q.isFetching} />
      </PageHeader>
      <QueryBoundary isLoading={q.isLoading} error={q.error} isEmpty={workers.length === 0} emptyLabel="No workers.">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="text-left text-[var(--color-text-secondary)]">
              <th className="py-2">Worker</th><th>Status</th><th>Current ticket</th><th>Current run</th><th>Runtime</th><th>Health</th><th>Last heartbeat</th>
            </tr>
          </thead>
          <tbody>
            {workers.map((w) => (
              <tr key={w.id} className="border-t border-[var(--color-border-default)]">
                <td className="py-2">{w.name}</td>
                <td><StatusBadge status={w.status} /></td>
                <td>{w.currentTicketIdentifier ?? "—"}</td>
                <td>{w.currentRun ? <StatusBadge status={w.currentRun.status} /> : "—"}</td>
                <td>{formatDurationMs(w.currentRun?.runtimeMs ?? null)}</td>
                <td><StatusBadge status={workerHealth(w)} /></td>
                <td>{formatDateTime(w.lastHeartbeatAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </QueryBoundary>
    </section>
  );
}
```

- [ ] **Step 3: Run → PASS.** typecheck clean.

- [ ] **Step 4: Commit**
```bash
git add src/ui/src/pages/WorkersPage.tsx src/ui/src/pages/WorkersPage.test.tsx
git commit -m "feat(ui): [DEN-2271] add workers page"
```

---

## Task U6: Router, layout shell, theme toggle, wiring

**Files:** rewrite `src/ui/src/App.tsx`, `src/ui/src/main.tsx`; create `src/ui/src/components/ThemeToggle.tsx`; update `src/ui/src/App.test.tsx`.

- [ ] **Step 1: `src/ui/src/components/ThemeToggle.tsx`**

```tsx
import { useState } from "react";
import { Moon, Sun } from "lucide-react";
export function ThemeToggle() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  function toggle() {
    const next = !dark;
    document.documentElement.classList.toggle("dark", next);
    setDark(next);
  }
  return (
    <button type="button" onClick={toggle} aria-label="Toggle theme" className="rounded-md border border-[var(--color-border-default)] p-1">
      {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </button>
  );
}
```

- [ ] **Step 2: rewrite `src/ui/src/App.tsx`** (layout shell + nav + routes)

```tsx
import { NavLink, Route, Routes } from "react-router-dom";
import { TicketsListPage } from "./pages/TicketsListPage.js";
import { TicketDetailPage } from "./pages/TicketDetailPage.js";
import { WorkersPage } from "./pages/WorkersPage.js";
import { ThemeToggle } from "./components/ThemeToggle.js";

const navClass = ({ isActive }: { isActive: boolean }) =>
  `text-sm ${isActive ? "text-[var(--color-primary)] font-medium" : "text-[var(--color-text-secondary)]"}`;

export default function App() {
  return (
    <div data-testid="app-root" className="mx-auto max-w-5xl p-6">
      <nav className="mb-6 flex items-center gap-4 border-b border-[var(--color-border-default)] pb-3">
        <span className="font-semibold">Bear Metal</span>
        <NavLink to="/" end className={navClass}>Tickets</NavLink>
        <NavLink to="/workers" className={navClass}>Workers</NavLink>
        <span className="ml-auto"><ThemeToggle /></span>
      </nav>
      <Routes>
        <Route path="/" element={<TicketsListPage />} />
        <Route path="/tickets/:id" element={<TicketDetailPage />} />
        <Route path="/workers" element={<WorkersPage />} />
      </Routes>
    </div>
  );
}
```

- [ ] **Step 3: rewrite `src/ui/src/main.tsx`** (providers)

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import App from "./App.js";
import "./index.css";

const client = new QueryClient();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
```

- [ ] **Step 4: update `src/ui/src/App.test.tsx`** (App now needs providers + renders nav + the tickets page; mock the client so the tickets query resolves)

```tsx
import { vi, expect, test } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "./test/utils.js";

vi.mock("./api/client.js", () => ({
  fetchTickets: vi.fn().mockResolvedValue([]),
  fetchWorkers: vi.fn().mockResolvedValue([]),
  fetchTicketDetail: vi.fn(),
}));

import App from "./App.js";

test("renders nav and the tickets page at /", async () => {
  renderWithProviders(<App />, "/");
  expect(screen.getByRole("link", { name: "Tickets" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Workers" })).toBeInTheDocument();
  expect(await screen.findByText("No tickets yet.")).toBeInTheDocument();
});
```
(Note: `renderWithProviders` already wraps in MemoryRouter, so App must NOT include its own Router — it uses `<Routes>` only, and `main.tsx` supplies `<BrowserRouter>`. Good.)

- [ ] **Step 5: Verify everything**
  - `cd src/ui && npm test` → all pass.
  - `npm run typecheck` → clean.
  - `npm run build` → succeeds.
  - **Manual e2e (real backend):** in one shell `BEAR_METAL_DB_PATH=./tmp.db npm run seed:mock && BEAR_METAL_DB_PATH=./tmp.db npm run dev:backend` (from repo root). In another, `cd src/ui && npm run dev`; open the printed URL; confirm tickets list shows DEN-3001..3004, a ticket detail shows attempts/PR/CI/timeline, the workers page shows worker statuses, refresh works, and the theme toggle flips light/dark. Then `rm ./tmp.db`.

- [ ] **Step 6: Commit**
```bash
git add src/ui/src/App.tsx src/ui/src/main.tsx src/ui/src/components/ThemeToggle.tsx src/ui/src/App.test.tsx
git commit -m "feat(ui): [DEN-2271] wire router, layout shell, theme toggle"
```

---

## Self-Review

- **Spec coverage:** Vite+React+Tailwind4 with ported BlueBear tokens (U0) ✓; API client/types matching the real backend contract (U1) ✓; TanStack Query + manual refresh, no polling (U2 hooks + RefreshButton) ✓; tickets list (U3) ✓; ticket detail with runs/PR/CI/timeline (U4) ✓; workers panel (U5) ✓; routing + theme toggle + console-style primitives (U6) ✓; component tests each task ✓. `recharts` intentionally omitted (MVP). Auth: none (local-only) — consistent with spec.
- **Placeholder scan:** version pins in U0 are marked `<pin>` deliberately — they MUST be resolved to exact, quarantine-compliant versions at install (can't be hardcoded blindly here without violating the 4-week rule). Every component/test has full code.
- **Type consistency:** API types in `types.ts` use `string` for all timestamps (serialized form) — matches what `res.json` emits from the backend's `Date` columns. `labelsJson` is a string parsed via `parseLabels`. Hook names (`useTickets`/`useTicketDetail`/`useWorkers`), client fns (`fetchTickets`/`fetchTicketDetail`/`fetchWorkers`), and component prop names are consistent across tasks. `renderWithProviders` wraps Router, so `App` must only use `<Routes>` (verified in U6).

---

## Acceptance Criteria (UI)

- [ ] `src/ui/` Vite app scaffolded with its own toolchain; `src/ui/{dist,node_modules}` gitignored; excluded from root tsc (already done backend-side).
- [ ] BlueBear design tokens ported; light/dark via `.dark` class + ThemeToggle.
- [ ] API client targets `/api/*`, fails fast on non-OK; types match the serialized backend contract.
- [ ] Tickets list, ticket detail, and workers pages render real data; manual refresh works; loading/error/empty states handled (no silent fallbacks).
- [ ] Component tests pass for client, format helpers, badge, and all three pages; `npm test`, `npm run typecheck`, `npm run build` all green in `src/ui/`.
- [ ] Manual e2e against the seeded backend confirms the three screens.

---

## Notes
- The dev proxy points at `localhost:3100` (backend default `BACKEND_PORT`). If the backend runs on another port, adjust `vite.config.ts` proxy.
- `<pin>` versions: resolve against `console/package.json` where shared (React 19, Tailwind 4, Vitest, Testing Library, jsdom, TypeScript) for known-compatible, quarantine-compliant baselines.
