import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import pg from "pg";
import type { WorkerCommentStore } from "./types.js";
import type { PullRequestRef } from "./types.js";

function sqlitePath(databaseUrl: string): string {
  return databaseUrl.slice("sqlite:".length);
}

/**
 * Open a WorkerCommentStore backed by the same database URL as the task queue.
 * SQLite uses a separate DatabaseSync connection to the same file; Postgres uses a separate pool.
 * The completed_issue_comments table is created on first open.
 */
export async function createCommentStoreFromDatabaseUrl(databaseUrl: string): Promise<WorkerCommentStore> {
  if (databaseUrl.startsWith("sqlite:")) {
    const path = sqlitePath(databaseUrl);
    if (path !== ":memory:") {
      await mkdir(dirname(path), { recursive: true });
    }
    const db = new DatabaseSync(path);
    db.exec(`
      CREATE TABLE IF NOT EXISTS completed_issue_comments (
        owner TEXT NOT NULL,
        repo TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        comment_id TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        PRIMARY KEY (owner, repo, pr_number, comment_id)
      )
    `);
    return {
      async markCompleted(pr: PullRequestRef, commentId: string): Promise<void> {
        const now = new Date().toISOString();
        db.prepare(
          `INSERT OR IGNORE INTO completed_issue_comments (owner, repo, pr_number, comment_id, completed_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(pr.owner, pr.repo, pr.number, commentId, now);
      },
      async getCompleted(pr: PullRequestRef): Promise<Set<string>> {
        const rows = db
          .prepare(
            `SELECT comment_id FROM completed_issue_comments
             WHERE owner = ? AND repo = ? AND pr_number = ?`,
          )
          .all(pr.owner, pr.repo, pr.number) as Array<{ comment_id: string }>;
        return new Set(rows.map((r) => r.comment_id));
      },
    };
  }

  if (databaseUrl.startsWith("postgres://") || databaseUrl.startsWith("postgresql://")) {
    const pool = new pg.Pool({ connectionString: databaseUrl });
    await pool.query(`
      CREATE TABLE IF NOT EXISTS completed_issue_comments (
        owner TEXT NOT NULL,
        repo TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        comment_id TEXT NOT NULL,
        completed_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (owner, repo, pr_number, comment_id)
      )
    `);
    return {
      async markCompleted(pr: PullRequestRef, commentId: string): Promise<void> {
        const now = new Date().toISOString();
        await pool.query(
          `INSERT INTO completed_issue_comments (owner, repo, pr_number, comment_id, completed_at)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT DO NOTHING`,
          [pr.owner, pr.repo, pr.number, commentId, now],
        );
      },
      async getCompleted(pr: PullRequestRef): Promise<Set<string>> {
        const result = await pool.query<{ comment_id: string }>(
          `SELECT comment_id FROM completed_issue_comments WHERE owner = $1 AND repo = $2 AND pr_number = $3`,
          [pr.owner, pr.repo, pr.number],
        );
        return new Set(result.rows.map((r) => r.comment_id));
      },
    };
  }

  throw new Error(`Unsupported DATABASE_URL scheme for comment store: ${databaseUrl}`);
}
