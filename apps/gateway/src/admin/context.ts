import type { AdminDeps } from "../contracts.js";
import { AdminAuth } from "./auth.js";

/** 관리 API 라우트가 쓰는 것: 받은 의존성과 관리 화면 인증 */
export type AdminContext = AdminDeps & { auth: AdminAuth };

export function createAdminContext(deps: AdminDeps): AdminContext {
  return { ...deps, auth: new AdminAuth(deps.db, deps.config) };
}
