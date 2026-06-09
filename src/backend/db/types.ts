import type { tickets, workers, runs, pullRequests, ciRuns, events, tokenUsage } from "./schema.js";

export type Ticket = typeof tickets.$inferSelect;
export type Worker = typeof workers.$inferSelect;
export type Run = typeof runs.$inferSelect;
export type PullRequestRow = typeof pullRequests.$inferSelect;
export type CiRun = typeof ciRuns.$inferSelect;
export type EventRow = typeof events.$inferSelect;
export type TokenUsageRow = typeof tokenUsage.$inferSelect;

export type NewTicket = typeof tickets.$inferInsert;
export type NewWorker = typeof workers.$inferInsert;
export type NewRun = typeof runs.$inferInsert;
export type NewPullRequest = typeof pullRequests.$inferInsert;
export type NewCiRun = typeof ciRuns.$inferInsert;
export type NewEvent = typeof events.$inferInsert;
export type NewTokenUsage = typeof tokenUsage.$inferInsert;
