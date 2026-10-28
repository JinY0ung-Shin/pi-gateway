import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type Db, migrate } from "../db.js";

/**
 * request_admin — agent가 스스로 해결할 수 없는 일(설치되지 않는 패키지, 막힌 도메인, 없는 도구·권한)을
 * 관리자에게 남긴다. 관리 화면의 "요청" 페이지에서 보고, 처리하면 지운다.
 */

export const REQUEST_ADMIN_TOOL = "request_admin";

const MIGRATIONS = [
  `CREATE TABLE admin_requests (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     principal TEXT NOT NULL,
     session_id TEXT NOT NULL,
     title TEXT NOT NULL,
     detail TEXT NOT NULL,
     created_at TEXT NOT NULL
   )`,
];

export interface AdminRequest {
  id: number;
  user: string;
  sessionId: string;
  title: string;
  detail: string;
  createdAt: string;
}

export class AdminRequests {
  constructor(private readonly db: Db) {
    migrate(db, "admin-requests", MIGRATIONS);
  }

  add(input: Omit<AdminRequest, "id" | "createdAt">): number {
    const { lastInsertRowid } = this.db
      .prepare("INSERT INTO admin_requests (principal, session_id, title, detail, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(input.user, input.sessionId, input.title, input.detail, new Date().toISOString());
    return Number(lastInsertRowid);
  }

  /** 최근 것부터 */
  list(): AdminRequest[] {
    return this.db
      .prepare(
        "SELECT id, principal AS user, session_id AS sessionId, title, detail, created_at AS createdAt FROM admin_requests ORDER BY id DESC",
      )
      .all() as AdminRequest[];
  }

  remove(id: number): boolean {
    return this.db.prepare("DELETE FROM admin_requests WHERE id = ?").run(id).changes > 0;
  }
}

const RequestAdminParams = Type.Object({
  title: Type.String({ description: "One-line summary of what is needed, e.g. 'Install pandas 2.2'.", minLength: 1, maxLength: 200 }),
  detail: Type.String({
    description: "What exactly is needed, why the task needs it, and what you tried and how it failed (include the error).",
    minLength: 1,
    maxLength: 4000,
  }),
});

export function createRequestAdminTool(
  store: Pick<AdminRequests, "add">,
  owner: { principal: string; sessionId: string },
): ToolDefinition<typeof RequestAdminParams> {
  return {
    name: REQUEST_ADMIN_TOOL,
    label: "Request admin",
    description:
      "Leave a request for the gateway administrator when the task needs something you cannot get yourself, " +
      "such as a package that will not install, network access to a blocked host, or a missing tool or permission. " +
      "The administrator handles it later, not during this conversation. Send one request per need, then tell the user you did.",
    parameters: RequestAdminParams,
    async execute(_toolCallId, params) {
      const id = store.add({ user: owner.principal, sessionId: owner.sessionId, title: params.title, detail: params.detail });
      return {
        content: [{ type: "text", text: `Request #${id} was left for the administrator. Tell the user, then continue with what you can do now.` }],
        details: { id },
      };
    },
  };
}
