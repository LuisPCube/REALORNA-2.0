import type { FactOk, Lang, Plan, CheckStage } from "./types";
export type Account = { id: string; username: string; email: string; admin: boolean };
export type Attempt = { attempt_id: string; plan: Plan; created_at: string };
export type CheckStatus = "queued" | "processing" | "processed" | "failed";
export type AccountOrder = {
  order_id: string; url: string; plan: Plan; lang: Lang;
  status: CheckStatus; created_at: string; error: string | null; report?: FactOk | null;
  retry_after_at?: string | null; progress_stage?: CheckStage | null;
};
export type AccountState = { user: Account | null; attempts: Attempt[]; orders: AccountOrder[] };
