import { describe, expect, it, vi } from "vitest";
import type { Ticket } from "../../shared/index.js";
import { loadDelegatedTickets, type LinearSource } from "./linear-source.js";

const makeTicket = (id: string): Ticket => ({
  id,
  identifier: id.toUpperCase(),
  title: `Ticket ${id}`,
  description: null,
  url: `https://linear.app/${id}`,
  branchName: `feature/${id}`,
  status: { name: "Done", type: "completed" },
  priority: 0,
  labels: [],
  assignee: null,
  delegate: { id: "agent" },
});

describe("loadDelegatedTickets", () => {
  it("returns every ticket when no limit is set", async () => {
    const source: LinearSource = {
      findAllDelegatedTickets: vi.fn().mockResolvedValue([makeTicket("a"), makeTicket("b")]),
    };
    const result = await loadDelegatedTickets(source, { agentId: "agent" });
    expect(result).toHaveLength(2);
    expect(source.findAllDelegatedTickets).toHaveBeenCalledWith("agent");
  });

  it("truncates to the limit when set", async () => {
    const source: LinearSource = {
      findAllDelegatedTickets: vi
        .fn()
        .mockResolvedValue([makeTicket("a"), makeTicket("b"), makeTicket("c")]),
    };
    const result = await loadDelegatedTickets(source, { agentId: "agent", limit: 2 });
    expect(result.map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("does not truncate when there are fewer tickets than the limit", async () => {
    const source: LinearSource = {
      findAllDelegatedTickets: vi.fn().mockResolvedValue([makeTicket("a")]),
    };
    const result = await loadDelegatedTickets(source, { agentId: "agent", limit: 5 });
    expect(result).toHaveLength(1);
  });
});
