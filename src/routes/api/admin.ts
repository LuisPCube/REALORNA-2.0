import { createFileRoute } from "@tanstack/react-router";
export const Route = createFileRoute("/api/admin")({ server: { handlers: {
  GET: async ({ request }) => {
    const { api, json } = await import("@/realorna/backend/http");
    return api(async () => {
      const { requireAccount } = await import("@/realorna/backend/accounts");
      const { getSql } = await import("@/lib/db");
      await requireAccount(request, true);
      const sql = await getSql();
      const audit = await sql.query(`select a.action, a.created_at, u.username, t.plan from fact_admin_audit a
        join "user" u on u.id = a.target_user_id left join fact_attempts t on t.attempt_id = a.attempt_id
        where a.action = 'grant_attempt' order by a.created_at desc limit 15`);
      return json({ audit });
    });
  },
  POST: async ({ request }) => {
    const { api, json, readJson, ApiError, requestKey } = await import("@/realorna/backend/http");
    return api(async () => {
      const { requireAccount } = await import("@/realorna/backend/accounts");
      const { grantAttempt } = await import("@/realorna/backend/orders");
      const admin = await requireAccount(request, true);
      const body = await readJson(request);
      const { username, plan } = body;
      if (body.action !== "grant" || typeof username !== "string" || (plan !== "regular" && plan !== "advance")) {
        throw new ApiError("invalid");
      }
      return json(await grantAttempt(admin, username, plan, requestKey(body.request_key)));
    });
  },
} } });
