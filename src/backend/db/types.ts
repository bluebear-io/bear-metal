import type { tickets, workers, runs, pullRequests, ciRuns, ciChecks, reviewThreads, runToolCalls, events, workerStateTransitions } from "./schema.js";

export type Ticket = typeof tickets.$inferSelect;
export type Worker = typeof workers.$inferSelect;
export type Run = typeof runs.$inferSelect;
export type PullRequestRow = typeof pullRequests.$inferSelect;
export type CiRun = typeof ciRuns.$inferSelect;
export type CiCheck = typeof ciChecks.$inferSelect;
export type ReviewThreadRow = typeof reviewThreads.$inferSelect;
export type RunToolCallRow = typeof runToolCalls.$inferSelect;
export type EventRow = typeof events.$inferSelect;
export type WorkerStateTransitionRow = typeof workerStateTransitions.$inferSelect;

export type NewTicket = typeof tickets.$inferInsert;
export type NewWorker = typeof workers.$inferInsert;
export type NewRun = typeof runs.$inferInsert;
export type NewPullRequest = typeof pullRequests.$inferInsert;
export type NewCiRun = typeof ciRuns.$inferInsert;
export type NewCiCheck = typeof ciChecks.$inferInsert;
export type NewReviewThread = typeof reviewThreads.$inferInsert;
export type NewRunToolCall = typeof runToolCalls.$inferInsert;
export type NewEvent = typeof events.$inferInsert;
export type NewWorkerStateTransition = typeof workerStateTransitions.$inferInsert;
