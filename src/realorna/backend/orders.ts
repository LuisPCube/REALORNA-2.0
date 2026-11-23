import { randomBytes, randomUUID } from "node:crypto";
import { getSql } from "@/lib/db";
import type { FactContract, FactOk, Lang, Plan, CheckStage } from "../types";
import type { Account, CheckStatus } from "../account-types";
import { ApiError } from "./http";
export type OrderRow = {
  order_id: string; user_id: string; url: string; plan: Plan; lang: Lang;
  status: CheckStatus; result_json: string | null; report_json: string | null;
  error: string | null; claim_token: string | null; credit_attempt_id: string | null;
  created_at: string | Date; retry_after_at: string | Date | null; progress_stage: CheckStage | null;
};
export function createOrderId() { return `ro_${Date.now()}_${randomBytes(4).toString("hex")}`; }
export async function getOrder(orderId: string, userId?: string) {
  const sql = await getSql();
  const rows = await sql.query<OrderRow>(`select * from fact_checks where order_id = $1 and ($2::text is null or user_id = $2)`, [orderId, userId ?? null]);
  return rows[0] ?? null;
}
export async function grantAttempt(admin: Account, username: string, plan: Plan, key: string) {
  const sql = await getSql();
  const target = await sql.query<{ id: string; username: string }>(`select id, username from "user" where lower(username) = $1`, [username.trim().toLowerCase()]);
  if (!target[0]) throw new ApiError("username_not_found", 404);
  const [attempt] = await sql.query<{ attempt_id: string; user_id: string; plan: Plan }>(`with granted as (
    insert into fact_attempts (attempt_id, user_id, plan, source, granted_by, request_key) values ($1, $2, $3, 'admin', $4, $5)
    on conflict (granted_by, request_key) do update set request_key = excluded.request_key returning *
  ), audited as (
    insert into fact_admin_audit (audit_id, admin_id, action, target_user_id, attempt_id)
    select $6, $4, 'grant_attempt', user_id, attempt_id from granted on conflict (audit_id) do nothing
  ) select attempt_id, user_id, plan from granted`, [randomUUID(), target[0].id, plan, admin.id, key, `grant:${admin.id}:${key}`]);
  if (attempt.user_id !== target[0].id || attempt.plan !== plan) throw new ApiError("request_conflict", 409);
  return { attempt_id: attempt.attempt_id, username: target[0].username, plan: attempt.plan, link: `/?attempt=${attempt.attempt_id}` };
}
export async function createCheck(user: Account, input: { url: string; plan: Plan; lang: Lang; key: string; attemptId?: string }) {
  const sql = await getSql();
  const validateExisting = (order: OrderRow) => {
    if (order.url !== input.url || order.plan !== input.plan || order.lang !== input.lang
      || (!user.admin && input.attemptId && order.credit_attempt_id !== input.attemptId)) throw new ApiError("request_conflict", 409);
    return order;
  };
  const existing = await sql.query<OrderRow>(`select * from fact_checks where user_id = $1 and request_key = $2`, [user.id, input.key]);
  if (existing[0]) return validateExisting(existing[0]);
  const args = [createOrderId(), user.id, input.url, input.plan, input.lang, input.key];
  let rows: OrderRow[];
  if (user.admin) {
    rows = await sql.query<OrderRow>(`insert into fact_orders
      (order_id, user_id, url, plan, lang, is_check, status, request_key)
      values ($1, $2, $3, $4, $5, true, 'queued', $6) on conflict (user_id, request_key) do nothing returning *`, args);
  } else {
    rows = await sql.query<OrderRow>(`with available as (
      select attempt_id from fact_attempts where user_id = $2 and plan = $4 and status = 'ready'
        and ($7::text is null or attempt_id = $7) order by created_at limit 1 for update skip locked
    ), created as (
      insert into fact_orders (order_id, user_id, url, plan, lang, is_check, status, request_key, credit_attempt_id)
      select $1, $2, $3, $4, $5, true, 'queued', $6, attempt_id from available
      on conflict (user_id, request_key) do nothing returning *
    ), consumed as (
      update fact_attempts a set status = 'used', used_at = now(), used_order_id = c.order_id
      from created c where a.attempt_id = c.credit_attempt_id returning a.attempt_id
    ) select * from created`, [...args, input.attemptId ?? null]);
  }
  if (rows[0]) return rows[0];
  const concurrent = await sql.query<OrderRow>(`select * from fact_checks where user_id = $1 and request_key = $2`, [user.id, input.key]);
  if (concurrent[0]) return validateExisting(concurrent[0]);
  throw new ApiError("attempt_required", 403);
}
export async function claimRetry(orderId: string) {
  const sql = await getSql();
  const rows = await sql.query<OrderRow>(`update fact_checks set stored_status = 'processing', progress_stage = 'reading', error = null, claim_token = $2, retry_after_at = null, updated_at = now()
    where order_id = $1
    and (retry_after_at is null or retry_after_at <= now())
    and (status in ('queued', 'failed') or (status = 'processing' and updated_at < now() - interval '5 minutes')) returning *`, [orderId, randomUUID()]);
  return rows[0] ?? null;
}
export async function updateProgress(orderId: string, token: string | null, stage: CheckStage) {
  const sql = await getSql();
  const rows = await sql.query(`update fact_checks set progress_stage = $3, updated_at = now()
    where order_id = $1 and status = 'processing' and claim_token = $2 returning order_id`, [orderId, token, stage]);
  if (!rows.length) throw new ApiError("processing_claim_lost", 409);
}
export async function markProcessed(orderId: string, contract: FactContract, report: FactOk, token: string | null) {
  const sql = await getSql();
  const rows = await sql.query(`with finished as (
    update fact_checks set stored_status = 'processed', progress_stage = null, result_json = $2, report_json = $3, error = null,
      claim_token = null, retry_after_at = null, updated_at = now()
      where order_id = $1 and status = 'processing' and claim_token = $4 returning order_id
  ), cleared as (
    delete from fact_media_checkpoints c using finished f where c.order_id = f.order_id
  ) select order_id from finished`,
    [orderId, JSON.stringify(contract), JSON.stringify(report), token]);
  if (!rows.length) throw new ApiError("processing_claim_lost", 409);
}
export async function markFailed(orderId: string, error: string, token: string | null, retryAfterSeconds = 0) {
  const sql = await getSql();
  await sql.query(`update fact_checks set stored_status = 'failed', progress_stage = null, error = $2, claim_token = null, updated_at = now(),
    retry_after_at = case when $4::int > 0 then clock_timestamp() + ($4::int * interval '1 second') else null end
    where order_id = $1 and status = 'processing' and claim_token = $3`, [orderId, error.slice(0, 200), token, retryAfterSeconds]);
}
export function readStored(order: OrderRow) { return { result: parseStored<FactContract>(order.result_json), report: parseStored<FactOk>(order.report_json) }; }
function parseStored<T>(raw: string | null): T | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}
export function publicOrder(order: OrderRow) {
  return { order_id: order.order_id, url: order.url, plan: order.plan, lang: order.lang, status: order.status,
    created_at: order.created_at, error: order.error, retry_after_at: order.retry_after_at, progress_stage: order.progress_stage,
    ...(order.status === "processed" ? readStored(order) : { result: null, report: null }) };
}
