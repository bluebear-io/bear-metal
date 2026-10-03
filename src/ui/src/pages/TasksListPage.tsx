import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { useConfig, useTaskFilterOptions, useTasks } from "../api/queries.js";
import type { StopReason, TaskListItem, TaskListQuery } from "../api/types.js";
import { PageHeader } from "../components/PageHeader.js";
import { QueryBoundary } from "../components/QueryBoundary.js";
import { RefreshButton } from "../components/RefreshButton.js";
import { StatusBadge } from "../components/StatusBadge.js";
import { formatDateTime } from "../lib/format.js";

const Dash = () => <span className="text-text-muted">-</span>;

const TaskLabel = ({ task }: { task: TaskListItem }) => task.ticketUrl ? (
  <a href={task.ticketUrl} className="font-medium text-primary transition hover:underline" target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
    {task.identifier}
  </a>
) : <span className="font-medium text-primary capitalize">{task.type}</span>;

const PrLink = ({ task }: { task: TaskListItem }) => {
  if (task.pullRequests.length === 0) {
    return <Dash />;
  }

  return (
    <div className="flex flex-wrap gap-x-2 gap-y-1">
      {task.pullRequests.map((pr) => (
        <a
          key={pr.id}
          href={pr.url}
          className="font-medium text-primary transition hover:underline"
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
        >
          #{pr.number}
        </a>
      ))}
    </div>
  );
};

type FilterKey = "all" | "in_progress" | "validating" | "waiting_for_human" | "failed" | "completed";

const FILTER_STATUSES: Record<Exclude<FilterKey, "all">, ReadonlyArray<string>> = {
  in_progress: ["in_progress", "queued", "running", "awaiting_coordination", "approved", "posting", "dispatched"],
  validating: ["validating"],
  waiting_for_human: ["waiting_for_human"],
  failed: ["failed", "timed_out", "crashed"],
  completed: ["completed", "coordinated", "succeeded"],
};

const FILTERS: ReadonlyArray<{ key: FilterKey; label: string }> = [
  { key: "all", label: "All" },
  { key: "in_progress", label: "In progress" },
  { key: "validating", label: "Validating" },
  { key: "waiting_for_human", label: "Waiting for human" },
  { key: "failed", label: "Failed" },
  { key: "completed", label: "Completed" },
];

const PAGE_SIZE = 20;

const selectClasses =
  "rounded-md border border-border-default bg-bg-card px-2 py-1 text-sm text-text-primary " +
  "focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary";

export default function TasksListPage() {
  const navigate = useNavigate();
  const [filter, setFilter] = useState<FilterKey>("all");
  const [searchInput, setSearchInput] = useState<string>("");
  const [appliedSearch, setAppliedSearch] = useState<string>("");
  const [workerId, setWorkerId] = useState<string>("");
  const [taskType, setTaskType] = useState<TaskListItem["type"] | "">("");
  const [label, setLabel] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [stopReason, setStopReason] = useState<StopReason | "">("");
  const loadMoreRef = useRef<HTMLDivElement | null>(null);

  const query = useMemo<TaskListQuery>(() => {
    const q: TaskListQuery = { pageSize: PAGE_SIZE };
    if (appliedSearch.trim()) q.q = appliedSearch.trim();
    if (taskType) q.type = taskType;
    if (workerId) q.workerId = workerId;
    if (label) q.label = label;
    if (stopReason) q.stopReason = stopReason;
    if (statusFilter) {
      q.statuses = [statusFilter];
    } else if (filter !== "all") {
      q.statuses = [...FILTER_STATUSES[filter]];
    }
    return q;
  }, [appliedSearch, taskType, workerId, label, statusFilter, stopReason, filter]);

  const tasksQuery = useTasks(query);
  const filtersQuery = useTaskFilterOptions();
  const configQuery = useConfig();

  const pages = tasksQuery.data?.pages ?? [];
  const tasks = pages.flatMap((page) => page.tasks);
  const total = pages[0]?.total ?? 0;
  const filterOptions = filtersQuery.data;

  const visibleTasks = tasks;

  const hasActiveServerFilter =
    Boolean(appliedSearch.trim()) || Boolean(taskType) || Boolean(workerId) || Boolean(label) || Boolean(statusFilter) || Boolean(stopReason);

  useEffect(() => {
    const target = loadMoreRef.current;
    if (!target || !tasksQuery.hasNextPage || typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting) && tasksQuery.hasNextPage && !tasksQuery.isFetchingNextPage) {
        void tasksQuery.fetchNextPage();
      }
    });

    observer.observe(target);
    return () => observer.disconnect();
  }, [tasksQuery.fetchNextPage, tasksQuery.hasNextPage, tasksQuery.isFetchingNextPage]);

  const submitSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setAppliedSearch(searchInput);
  };

  const clearFilters = () => {
    setSearchInput("");
    setAppliedSearch("");
    setWorkerId("");
    setTaskType("");
    setLabel("");
    setStatusFilter("");
    setStopReason("");
  };

  const setCategory = (key: FilterKey) => {
    setFilter(key);
  };

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-5 px-6 py-6 sm:px-8">
      <PageHeader title="Tasks">
        <RefreshButton busy={tasksQuery.isFetching} onClick={() => void tasksQuery.refetch()} />
      </PageHeader>

      <section aria-label="Task search" className="flex flex-col gap-3 rounded-md border border-border-default bg-bg-card p-3">
        <form role="search" onSubmit={submitSearch} className="flex flex-wrap gap-2">
          <label className="sr-only" htmlFor="task-search">Search tasks</label>
          <input
            id="task-search"
            type="search"
            placeholder="Search tasks (ticket, request, description)"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className={`${selectClasses} min-w-[20rem] flex-1`}
          />
          <button
            type="submit"
            className="rounded-md border border-border-default bg-bg-card px-3 py-1 text-sm font-medium text-text-primary transition hover:border-primary hover:text-primary"
          >
            Search
          </button>
          {hasActiveServerFilter ? (
            <button
              type="button"
              onClick={clearFilters}
              className="rounded-md border border-border-default bg-bg-card px-3 py-1 text-sm font-medium text-text-primary transition hover:border-primary hover:text-primary"
            >
              Clear
            </button>
          ) : null}
        </form>

        <div className="flex flex-wrap gap-2" aria-label="Task filters">
          <label className="flex items-center gap-1 text-xs text-text-secondary">
            Type
            <select aria-label="Filter by type" value={taskType} onChange={(e) => setTaskType(e.target.value as TaskListItem["type"] | "")} className={selectClasses}>
              <option value="">Any type</option>
              <option value="coding">Coding</option>
              <option value="research">Research</option>
              <option value="coordinator">Coordination</option>
            </select>
          </label>
          <label className="flex items-center gap-1 text-xs text-text-secondary">
            Worker
            <select
              aria-label="Filter by worker"
              value={workerId}
              onChange={(e) => { setWorkerId(e.target.value); }}
              className={selectClasses}
            >
              <option value="">Any worker</option>
              {filterOptions?.workers.map((w) => (
                <option key={w.id} value={w.id}>{w.name}</option>
              ))}
            </select>
          </label>

          <label className="flex items-center gap-1 text-xs text-text-secondary">
            Label
            <select
              aria-label="Filter by label"
              value={label}
              onChange={(e) => { setLabel(e.target.value); }}
              className={selectClasses}
            >
              <option value="">Any label</option>
              {filterOptions?.labels.map((l) => (
                <option key={l} value={l}>{l}</option>
              ))}
            </select>
          </label>

          <label className="flex items-center gap-1 text-xs text-text-secondary">
            State
            <select
              aria-label="Filter by state"
              value={statusFilter}
              onChange={(e) => { setStatusFilter(e.target.value); }}
              className={selectClasses}
            >
              <option value="">Any state</option>
              {(filterOptions?.statuses ?? []).map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </label>

          <label className="flex items-center gap-1 text-xs text-text-secondary">
            Failure reason
            <select
              aria-label="Filter by failure reason"
              value={stopReason}
              onChange={(e) => { setStopReason(e.target.value as StopReason | ""); }}
              className={selectClasses}
            >
              <option value="">Any reason</option>
              {(filterOptions?.stopReasons ?? []).map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          </label>
        </div>
      </section>

      <nav aria-label="Task categories" className="flex flex-wrap gap-2">
        {FILTERS.map(({ key, label: btnLabel }) => {
          const isActive = filter === key;
          return (
            <button
              key={key}
              type="button"
              onClick={() => setCategory(key)}
              aria-pressed={isActive}
              className={
                "rounded-full border px-3 py-1 text-sm transition " +
                (isActive
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border-default bg-bg-card text-text-secondary transition hover:border-primary hover:text-primary")
              }
            >
              {btnLabel}
            </button>
          );
        })}
      </nav>

      <QueryBoundary
        isLoading={tasksQuery.isLoading}
        error={tasksQuery.error}
        isEmpty={visibleTasks.length === 0}
        emptyLabel={hasActiveServerFilter || filter !== "all" ? "No tasks match these filters." : "No tasks yet."}
      >
        <section aria-label="Tasks list" className="flex flex-col gap-3">
          <div className="overflow-x-auto rounded-md border border-border-default bg-bg-card">
            <table className="min-w-full divide-y divide-border-default text-left text-sm">
              <thead className="bg-bg-page text-xs uppercase text-text-muted">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">Task</th>
                  <th scope="col" className="px-4 py-3 font-medium">Title</th>
                  <th scope="col" className="px-4 py-3 font-medium">Status</th>
                  <th scope="col" className="px-4 py-3 font-medium">Latest run</th>
                  <th scope="col" className="px-4 py-3 font-medium">Attempts</th>
                  <th scope="col" className="px-4 py-3 font-medium">Owner</th>
                  <th scope="col" className="px-4 py-3 font-medium">PR</th>
                  <th scope="col" className="px-4 py-3 font-medium">Updated</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-default">
                {visibleTasks.map((task) => (
                  <tr
                    key={task.id}
                    className="align-middle cursor-pointer hover:bg-bg-page"
                    onClick={() => navigate(`/tasks/${task.type === "coding" && !task.ticketId ? "run" : task.type}/${task.id}`)}
                  >
                    <td className="whitespace-nowrap px-4 py-3">
                      <TaskLabel task={task} />
                    </td>
                    <td className="max-w-xs truncate px-4 py-3 text-text-primary">{task.title}</td>
                    <td className="whitespace-nowrap px-4 py-3">
                      <StatusBadge status={task.status} />
                    </td>
                    <td className="whitespace-nowrap px-4 py-3">
                      {task.runStatus === null ? <Dash /> : <StatusBadge status={task.runStatus} />}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-text-primary">
                      {task.type === "coding" ? `${task.attemptCount}/${configQuery.data?.maxIterations ?? "?"}` : <Dash />}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-text-secondary">
                      {task.assigneeName ?? <Dash />}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3">
                      <PrLink task={task} />
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-text-secondary">
                      {formatDateTime(task.updatedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div ref={loadMoreRef} data-testid="tasks-scroll-sentinel" className="h-2" />
          <div className="text-sm text-text-secondary" aria-live="polite">
            {tasksQuery.isFetchingNextPage ? "Loading more tasks..." : `Showing ${visibleTasks.length} of ${total} tasks`}
          </div>
        </section>
      </QueryBoundary>
    </main>
  );
}
