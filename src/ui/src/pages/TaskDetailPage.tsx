import { useState } from "react";
import { Link, useParams } from "react-router-dom";

import { useAgentRunDetail } from "../api/queries.js";
import type { AgentRunSummary, AgentTraceEvent } from "../api/types.js";
import { PageHeader } from "../components/PageHeader.js";
import { QueryBoundary } from "../components/QueryBoundary.js";
import { RefreshButton } from "../components/RefreshButton.js";
import { StatusBadge } from "../components/StatusBadge.js";
import { formatDateTime } from "../lib/format.js";
import CodingTaskDetail from "../components/CodingTaskDetail.js";
import { CopyableBlock, Field, RunsSection, Section } from "../components/TaskDetailSections.js";

const showJson = (value: string): string => {
  try { return JSON.stringify(JSON.parse(value), null, 2); }
  catch { return value; }
};

const traceContent = (value: string): string => {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (typeof parsed.text === "string") return typeof parsed.part === "number" && typeof parsed.parts === "number"
      ? `Part ${parsed.part} of ${parsed.parts}\n\n${parsed.text}` : parsed.text;
    return JSON.stringify(parsed, null, 2);
  } catch { return value; }
};

const traceLabel = (event: AgentTraceEvent): string => {
  if (event.kind === "prompt") return "Prompt";
  if (event.kind === "assistant_text") return "Assistant output";
  if (event.kind === "thinking") return "Thinking";
  if (event.kind === "tool_call") {
    try {
      const parsed = JSON.parse(event.contentJson) as Record<string, unknown>;
      return typeof parsed.toolName === "string" ? parsed.toolName : "Tool call";
    } catch { return "Tool call"; }
  }
  return event.kind.replaceAll("_", " ");
};

const traceStatus = (event: AgentTraceEvent): string => {
  if (event.kind !== "tool_call") return "ok";
  try {
    const parsed = JSON.parse(event.contentJson) as Record<string, unknown>;
    return parsed.resultStatus === "error" ? "error" : "ok";
  } catch { return "unknown"; }
};

const TraceRow = ({ event }: { event: AgentTraceEvent }) => {
  const [open, setOpen] = useState(false);
  const status = traceStatus(event);
  const badgeClass = status === "error" ? "bg-status-red/10 text-status-red"
    : status === "ok" ? "bg-status-green/10 text-status-green" : "bg-status-yellow/10 text-status-yellow";

  return <>
    <tr className="cursor-pointer hover:bg-bg-page" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
      <td className="whitespace-nowrap px-4 py-3">
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${badgeClass}`}>{status}</span>
      </td>
      <td className="whitespace-nowrap px-4 py-3">
        <span className="rounded-full border border-border-default px-2 py-0.5 text-xs font-medium text-text-secondary">
          {event.kind === "tool_call" ? "agent" : event.kind === "prompt" ? "system" : "assistant"}
        </span>
      </td>
      <td className="px-4 py-3 text-sm text-text-primary">{traceLabel(event)}</td>
      <td className="whitespace-nowrap px-4 py-3 text-right text-xs text-text-muted">
        <time dateTime={event.createdAt}>{formatDateTime(event.createdAt)}</time>
      </td>
    </tr>
    {open && <tr><td colSpan={4} className="border-t border-border-default bg-bg-page px-4 py-3 max-w-0 w-full">
      <CopyableBlock content={traceContent(event.contentJson)} tall />
    </td></tr>}
  </>;
};

const TraceEventLog = ({ trace, active }: { trace: AgentTraceEvent[]; active: boolean }) => (
  <Section title="Event log">
    {trace.length === 0 && !active ? <p className="text-sm text-text-muted">No events yet.</p> : (
      <div className="overflow-x-auto rounded-md border border-border-default bg-bg-card">
        <table className="min-w-full divide-y divide-border-default text-left text-sm">
          <thead className="bg-bg-page text-xs uppercase text-text-muted"><tr>
            <th scope="col" className="px-4 py-3 font-medium">Status</th>
            <th scope="col" className="px-4 py-3 font-medium">Source</th>
            <th scope="col" className="px-4 py-3 font-medium">Event</th>
            <th scope="col" className="px-4 py-3 font-medium text-right">Time</th>
          </tr></thead>
          <tbody className="divide-y divide-border-default">
            {trace.map((event) => <TraceRow key={event.id} event={event} />)}
            {active && <tr><td colSpan={4} className="px-4 py-3 text-xs text-text-muted">Worker is active — new events will appear here</td></tr>}
          </tbody>
        </table>
      </div>
    )}
  </Section>
);

const TaskSummary = ({ run }: { run: AgentRunSummary }) => {
  const slackUrl = run.slackChannelId && run.slackThreadTs
    ? `https://app.slack.com/archives/${run.slackChannelId}/p${run.slackThreadTs.replace(".", "")}` : null;
  return <Section title="Summary">
    <dl className="grid gap-4 rounded-md border border-border-default bg-bg-card p-4 sm:grid-cols-2 lg:grid-cols-4">
      <Field label="Type" value={run.type === "coordinator" ? "Coordination" : run.type === "coding" ? "Coding" : "Research"} />
      <Field label="Title" value={run.ticketTitle ?? run.request ?? "Slack thread coordination"} />
      <div><dt className="text-xs font-medium uppercase text-text-muted">Status</dt>
        <dd className="mt-1"><StatusBadge status={run.slackState ?? run.status} /></dd></div>
      <Field label="Started" value={formatDateTime(run.startedAt ?? run.createdAt)} />
      <Field label="Completed" value={formatDateTime(run.endedAt)} />
      <Field label="Model" value={run.modelName ?? "—"} />
      <Field label="Provider" value={run.provider ?? "—"} />
      {run.ticketUrl && <div><dt className="text-xs font-medium uppercase text-text-muted">Ticket</dt>
        <dd className="mt-1"><a href={run.ticketUrl} className="text-sm font-medium text-primary hover:underline">{run.ticketIdentifier ?? run.ticketUrl}</a></dd></div>}
      {run.ticketId && <div><dt className="text-xs font-medium uppercase text-text-muted">Coding task</dt>
        <dd className="mt-1"><Link to={`/tasks/coding/${run.ticketId}`} className="text-sm font-medium text-primary hover:underline">View ticket history</Link></dd></div>}
      {slackUrl && <div><dt className="text-xs font-medium uppercase text-text-muted">Slack thread</dt>
        <dd className="mt-1"><a href={slackUrl} className="text-sm font-medium text-primary hover:underline">Open thread</a></dd></div>}
    </dl>
  </Section>;
};

const TaskInputOutput = ({ run, trace }: { run: AgentRunSummary; trace: AgentTraceEvent[] }) => {
  let input = run.type === "coordinator" ? run.inputJson : run.request;
  if (run.type === "coordinator" && run.inputJson) {
    const payload = JSON.parse(run.inputJson) as { messages?: Array<{ text: string }>; resultTaskId?: string; request?: string; answer?: string };
    if (payload.messages) input = payload.messages.map((message) => message.text).join("\n\n");
    else if (payload.resultTaskId) input = payload.request && payload.answer
      ? `${payload.request}\n\n${payload.answer}` : `Review research result for task ${payload.resultTaskId}`;
  }
  let output: string | null = null;
  if (run.resultJson) {
    const result = JSON.parse(run.resultJson) as { answer?: string; replies?: string[]; decision?: string };
    output = run.type === "research" ? result.answer ?? null
      : result.replies?.join("\n\n") || result.decision || showJson(run.resultJson);
  } else {
    const assistant = trace.filter((event) => event.kind === "assistant_text");
    if (assistant.length > 0) output = assistant.map((event) => traceContent(event.contentJson)).join("\n\n");
  }
  return <Section title="Input / output">
    <div className="grid gap-4 lg:grid-cols-2">
      <div><h3 className="text-sm font-medium text-text-secondary">Input</h3>
        {input ? <CopyableBlock content={input} tall /> : <p className="text-sm text-text-muted">No input recorded.</p>}</div>
      <div><h3 className="text-sm font-medium text-text-secondary">Output</h3>
        {output ? <CopyableBlock content={output} tall /> : <p className="text-sm text-text-muted">No output recorded yet.</p>}</div>
    </div>
  </Section>;
};

const ExecutionDetail = () => {
  const { id } = useParams();
  const query = useAgentRunDetail(id ?? "");
  const detail = query.data;
  const run = detail?.run;
  const title = run?.ticketIdentifier && run.ticketTitle ? `${run.ticketIdentifier}: ${run.ticketTitle}`
    : run?.request ?? (run?.type === "coordinator" ? "Slack thread coordination" : "Task");

  return <>
    <PageHeader title={title}><RefreshButton busy={query.isFetching} onClick={() => { void query.refetch(); }} /></PageHeader>
    <QueryBoundary isLoading={query.isLoading} error={query.error} isEmpty={!run} emptyLabel="Task detail not found">
      {run && detail && <div className="flex flex-col gap-6">
        {run.type !== "coding" && <TaskInputOutput run={run} trace={detail.trace} />}
        <TaskSummary run={run} />
        {run.request && run.type !== "coordinator" && <Section title="Request"><CopyableBlock content={run.request} tall /></Section>}
        {run.inputJson && <Section title="Task input"><CopyableBlock content={showJson(run.inputJson)} tall /></Section>}
        {run.resultJson && <Section title="Result"><CopyableBlock content={showJson(run.resultJson)} tall /></Section>}
        {run.error && <Section title="Error"><CopyableBlock content={run.error} tall /></Section>}
        <RunsSection runs={[run]} />
        <TraceEventLog trace={detail.trace} active={run.status === "running" || run.status === "dispatched"} />
      </div>}
    </QueryBoundary>
  </>;
};

export default function TaskDetailPage() {
  const { type } = useParams();
  const content = type === undefined || type === "coding" ? <CodingTaskDetail />
    : type === "coordinator" || type === "research" || type === "run" ? <ExecutionDetail />
      : <div role="alert">Unknown task type.</div>;
  return <main className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-6 py-8 sm:px-8">
    <Link to="/" className="text-sm font-medium text-primary hover:underline">Back to tasks</Link>
    {content}
  </main>;
}
