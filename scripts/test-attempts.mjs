import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
// Integration tests always use an isolated in-memory Postgres.
if (process.env.DATABASE_URL?.trim() || process.env.VERCEL) throw new Error("Run this test without DATABASE_URL or VERCEL.");
process.env.VITE_AUTH_ENABLED = "true";
process.env.ADMIN_USERNAME = "realorna_admin";
process.env.ADMIN_PASSWORD = randomBytes(24).toString("base64url");
process.env.BETTER_AUTH_SECRET = randomBytes(32).toString("hex");
process.env.BETTER_AUTH_URL = "http://localhost:8090";
process.env.OPENAI_MIN_INTERVAL_MS = "1000";
process.env.OPENAI_RETRY_BASE_MS = "250";
process.env.OPENAI_MAX_QUEUE_WAIT_MS = "2000";
delete process.env.OPENAI_API_KEYS; delete process.env.OPENAI_API_KEY; delete process.env.XAI_API_KEY;
delete process.env.OPENAI_REGULAR_MODEL; delete process.env.OPENAI_ADVANCE_MODEL;
delete process.env.OPENAI_TEXT_MODEL;
const { createServer } = await import("vite");
const server = await createServer({ server: { host: "127.0.0.1", port: 8090, strictPort: true }, logLevel: "error" });
await server.listen();
const originalFetch = globalThis.fetch;
const base = "http://localhost:8090";
const checks = [];
async function request(path, body, token, extraHeaders = {}) {
  const response = await originalFetch(base + path, { method: body === undefined ? "GET" : "POST", headers: {
    "content-type": "application/json", origin: base, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extraHeaders,
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = response.headers.get("Content-Type")?.includes("application/json") ? await response.json() : null;
  return { status: response.status, data, retryAfter: response.headers.get("Retry-After") };
}
async function test(name, fn) { await fn(); checks.push(name); console.log(`PASS ${name}`); }
const input = { url: "https://example.com/article", plan: "regular", lang: "en" };
let admin, alex, other, grant, checkedOrder;
try {
  const db = await server.ssrLoadModule("/src/lib/db.ts");
  const sql = await db.getSql();
  const orders = await server.ssrLoadModule("/src/realorna/backend/orders.ts");
  await test("Admin bootstrap stores a password hash and login works", async () => {
    const response = await request("/api/auth/sign-in/username", { username: "REALORNA_ADMIN", password: process.env.ADMIN_PASSWORD });
    assert.equal(response.status, 200, JSON.stringify(response.data)); admin = response.data.token; assert.ok(admin);
    const state = await request("/api/account", undefined, admin); assert.equal(state.data.user.admin, true);
    const [account] = await sql.query(`select password from account where "providerId" = 'credential' limit 1`);
    assert.notEqual(account.password, process.env.ADMIN_PASSWORD); assert.ok(account.password.length > 100);
  });
  await test("Registration normalizes usernames and cannot set admin privileges", async () => {
    const first = await request("/api/auth/sign-up/email", { name: "Alex", username: "Alex", email: "alex@example.com", password: "ExamplePassword-2026", role: "admin" });
    assert.equal(first.status, 200, JSON.stringify(first.data)); alex = first.data.token;
    const second = await request("/api/auth/sign-up/email", { name: "Other", username: "Other", email: "other@example.com", password: "ExamplePassword-2026" });
    assert.equal(second.status, 200); other = second.data.token;
    const state = await request("/api/account", undefined, alex); assert.equal(state.data.user.username, "alex"); assert.equal(state.data.user.admin, false);
    const dup = await request("/api/auth/sign-up/email", { name: "ALex", username: "aLEX", email: "duplicate@example.com", password: "ExamplePassword-2026" });
    assert.ok(dup.status >= 400); const [{ count }] = await sql.query(`select count(*) as count from "user" where lower(username) = 'alex'`); assert.equal(count, 1);
    const reserved = await request("/api/auth/sign-up/email", { name: "Admin", username: "realorna_admin", email: "attacker@example.com", password: "ExamplePassword-2026" }); assert.equal(reserved.status, 409);
  });
  await test("Concurrent registrations cannot create duplicate usernames", async () => {
    const results = await Promise.all(["one","two"].map(tag => request("/api/auth/sign-up/email", { name: "Race", username: "Race", email: `${tag}@example.com`, password: "ExamplePassword-2026" })));
    assert.equal(results.filter(r => r.status === 200).length, 1);
    const [{ count }] = await sql.query(`select count(*) as count from "user" where lower(username) = 'race'`); assert.equal(count, 1);
  });
  await test("Only admins can grant attempts and signed-in users need an attempt for the selected plan", async () => {
    assert.equal((await request("/api/admin")).status, 401);
    assert.equal((await request("/api/admin", { action: "grant", username: "alex", plan: "advance", request_key: randomUUID() }, alex)).status, 403);
    assert.equal((await request("/api/checks", { ...input, request_key: randomUUID() })).status, 401);
    const missing = await request("/api/checks", { ...input, request_key: randomUUID() }, alex);
    assert.equal(missing.status, 403); assert.equal(missing.data.error, "attempt_required");
    assert.equal((await request("/api/admin", { action: "grant", username: "alex", plan: "regular", request_key: randomUUID() }, admin, { origin: "https://evil.example", "sec-fetch-site": "cross-site" })).status, 403);
  });
  await test("Admin grants are case insensitive, idempotent and account-bound", async () => {
    const body = { action: "grant", username: "ALEX", plan: "regular", request_key: randomUUID() };
    const response = await request("/api/admin", body, admin); assert.equal(response.status, 200, JSON.stringify(response.data)); grant = response.data;
    const repeat = await request("/api/admin", body, admin); assert.equal(repeat.data.attempt_id, grant.attempt_id);
    assert.equal((await request("/api/account", undefined, alex)).data.attempts.length, 1);
    assert.equal((await request("/api/checks", { ...input, attempt_id: grant.attempt_id, request_key: randomUUID() }, other)).status, 403);
    assert.equal((await request("/api/checks", { ...input, plan: "advance", attempt_id: grant.attempt_id, request_key: randomUUID() }, alex)).status, 403);
  });
  await test("One attempt creates exactly one check, including concurrent requests", async () => {
    const body = { ...input, attempt_id: grant.attempt_id, request_key: randomUUID() };
    const results = await Promise.all([request("/api/checks",body,alex),request("/api/checks",{...body,request_key:randomUUID()},alex)]);
    assert.equal(results.filter(r => r.status === 200).length,1,JSON.stringify(results)); checkedOrder = results.find(r => r.status === 200).data;
    const [{ count }] = await sql.query(`select count(*) as count from fact_orders where credit_attempt_id = $1`, [grant.attempt_id]); assert.equal(count,1);
    const repeat = await request("/api/checks",body,alex);
    if (results[0].status === 200) assert.equal(repeat.data.order_id,checkedOrder.order_id); else assert.equal(repeat.status,403);
    assert.equal(checkedOrder.status, "queued");
    assert.equal((await request(`/api/orders/${checkedOrder.order_id}`,undefined,other)).status,404);
    assert.equal((await request("/api/analyze",{order_id:checkedOrder.order_id},other)).status,404);
    const [stored] = await sql.query(`select request_key from fact_orders where order_id = $1`, [checkedOrder.order_id]);
    const changed = await request("/api/checks", { ...body, url: "https://example.com/different", request_key: stored.request_key }, alex);
    assert.equal(changed.status,409);
  });
  await test("Processing claims are exclusive and stale workers cannot overwrite a retry", async () => {
    const claims = await Promise.all([orders.claimRetry(checkedOrder.order_id),orders.claimRetry(checkedOrder.order_id)]);
    const claimed = claims.find(Boolean); assert.equal(claims.filter(Boolean).length,1);
    await orders.markFailed(claimed.order_id,"ai_failed","wrong-token"); assert.equal((await orders.getOrder(claimed.order_id)).status,"processing");
    await orders.markFailed(claimed.order_id,"ai_failed",claimed.claim_token); assert.equal((await orders.getOrder(claimed.order_id)).status,"failed");
    const retry = await orders.claimRetry(claimed.order_id); assert.ok(retry); assert.notEqual(retry.claim_token,claimed.claim_token);
    await orders.markFailed(claimed.order_id,"old-error",claimed.claim_token); assert.equal((await orders.getOrder(claimed.order_id)).status,"processing");
    await orders.markFailed(claimed.order_id,"ai_failed",retry.claim_token);
    assert.equal((await request("/api/account",undefined,alex)).data.attempts.length,0);
  });
  await test("Busy saved checks preserve their reason, HTTP status, and the original consumed attempt", async () => {
    const claimed = await orders.claimRetry(checkedOrder.order_id); assert.ok(claimed);
    await orders.markFailed(claimed.order_id, "ai_busy", claimed.claim_token, 36);
    const response = await request("/api/analyze", { order_id: claimed.order_id }, alex);
    assert.equal(response.status, 503); assert.equal(response.data.error, "ai_busy");
    assert.equal(response.data.retry_reason, "busy"); assert.equal(response.data.error_origin, "saved_check");
    assert.ok(Number(response.retryAfter) > 0); assert.ok(response.data.support_id);
    const repeat = await request("/api/analyze", { order_id: claimed.order_id }, alex); assert.equal(repeat.status, 503);
    assert.equal((await request("/api/account", undefined, alex)).data.attempts.length, 0);
    const [count] = await sql.query(`select count(*) as count from fact_orders where credit_attempt_id = $1`, [grant.attempt_id]);
    assert.equal(count.count, 1);
    await sql.query(`update fact_orders set retry_after_at = null where order_id = $1`, [claimed.order_id]);
  });
  await test("Checkout routes and payment approval actions are gone", async () => {
    for (const path of ["/api/create-payment", "/api/demo-payment", "/api/midtrans-webhook"]) {
      const response = await request(path, {}, alex);
      assert.ok([404, 405].includes(response.status), `${path}: ${response.status}`);
    }
    const submitted = await request(`/api/orders/${checkedOrder.order_id}`, { reference: "Fixture" }, alex);
    assert.ok([404, 405].includes(submitted.status), submitted.status);
    for (const action of ["approve", "reject"]) {
      assert.equal((await request("/api/admin", { action, order_id: checkedOrder.order_id }, admin)).status, 400);
    }
    assert.equal((await request("/api/account", undefined, alex)).data.attempts.length, 0);
  });
  await test("Historical invoices are excluded while existing attempts and saved checks still work", async () => {
    const { user: recipient } = (await request("/api/account", undefined, other)).data;
    const { user: issuer } = (await request("/api/account", undefined, admin)).data;
    const invoiceId = randomUUID(), queuedId = randomUUID(), reportId = randomUUID(), attemptId = randomUUID();
    const report = { ok: true, summary: "Existing report fixture" };
    await sql.query(`insert into fact_orders (order_id, user_id, url, plan, lang, amount, status, payment_method, paid_at, report_json)
      values ($1, $4, $5, 'regular', 'en', 3000, 'paid', 'transfer', now(), null),
        ($2, $4, $5, 'regular', 'en', 0, 'paid', 'credit', now(), null),
        ($3, $4, $5, 'regular', 'en', 0, 'processed', 'credit', now(), $6)`, [invoiceId, queuedId, reportId, recipient.id, input.url, JSON.stringify(report)]);
    await sql.query(`insert into fact_attempts (attempt_id, user_id, plan, source, source_order_id, granted_by, request_key)
      values ($1, $2, 'regular', 'transfer', $3, $4, $1)`, [attemptId, recipient.id, invoiceId, issuer.id]);
    await sql.query(`insert into fact_admin_audit (audit_id, admin_id, action, target_user_id, attempt_id, order_id)
      values ($1, $2, 'approve_transfer', $3, $4, $5)`, [randomUUID(), issuer.id, recipient.id, attemptId, invoiceId]);
    const state = (await request("/api/account", undefined, other)).data;
    assert.deepEqual(state.attempts.map(a => a.attempt_id), [attemptId]);
    assert.deepEqual(new Set(state.orders.map(order => order.order_id)), new Set([queuedId, reportId]));
    assert.equal(state.orders.find(order => order.order_id === queuedId).status, "queued");
    const audit = (await request("/api/admin", undefined, admin)).data;
    assert.ok(audit.audit.length && audit.audit.every(entry => entry.action === "grant_attempt"));
    assert.equal(Object.hasOwn(audit, "orders"), false);
    assert.equal((await request(`/api/orders/${invoiceId}`, undefined, other)).status, 404);
    assert.equal((await request("/api/analyze", { order_id: invoiceId }, other)).status, 404);
    assert.equal(await orders.claimRetry(invoiceId), null);
    assert.equal((await request(`/api/orders/${queuedId}`, undefined, other)).data.status, "queued");
    assert.deepEqual((await request(`/api/orders/${reportId}`, undefined, other)).data.report, report);
    assert.equal((await orders.claimRetry(queuedId)).status, "processing");
    const checked = await request("/api/checks", { ...input, attempt_id: attemptId, request_key: randomUUID() }, other);
    assert.equal(checked.status, 200, JSON.stringify(checked.data));
    assert.equal((await request("/api/account", undefined, other)).data.attempts.length, 0);
    const [invoice] = await sql.query(`select status from fact_orders where order_id = $1`, [invoiceId]);
    assert.equal(invoice.status, "paid");
  });
  await test("Admins can check both plans without consuming attempts", async () => {
    for (const plan of ["regular", "advance"]) {
      const response = await request("/api/checks", { ...input, plan, request_key: randomUUID() }, admin);
      assert.equal(response.status, 200);
      assert.equal(response.data.status, "queued");
      for (const field of ["payment_method", "amount", "transfer_reference", "expires_at"]) {
        assert.equal(Object.hasOwn(response.data, field), false);
      }
    }
  });
  await test("API-key failover handles invalid keys while a 429 cools down the shared pool",async()=>{
    const pool=await server.ssrLoadModule("/src/realorna/backend/key-pool.ts");
    await sql`delete from fact_ai_throttle`; await sql`delete from fact_ai_key_cooldowns`;
    process.env.OPENAI_API_KEYS="test-exhausted,test-working,test-working"; assert.equal(pool.openaiKeys().length,2);
    const tried=[]; const call=async key=>{tried.push(key);return new Response("{}",{status:key==="test-exhausted"?429:200,headers:{"retry-after":"60"}});};
    await assert.rejects(()=>pool.withOpenAIKey(call,Date.now()+5000),/ai_quota/); assert.deepEqual(tried,["test-exhausted"]);
    tried.length=0;await assert.rejects(()=>pool.withOpenAIKey(call,Date.now()+5000),/ai_quota/);assert.deepEqual(tried,[]);
    await sql`delete from fact_ai_throttle`;
    process.env.OPENAI_API_KEYS='["test-denied","test-healthy"]';const authTried=[];
    await pool.withOpenAIKey(async key=>{authTried.push(key);return new Response("{}",{status:key==="test-denied"?403:200});},Date.now()+5000);assert.deepEqual(authTried,["test-denied","test-healthy"]);
    await sql`delete from fact_ai_throttle`;
    process.env.OPENAI_API_KEYS="all-invalid-a,all-invalid-b";
    await assert.rejects(()=>pool.withOpenAIKey(async()=>new Response("{}",{status:403}),Date.now()+5000),/openai_off/);
    await assert.rejects(()=>pool.withOpenAIKey(async()=>{throw new Error("A cooled-down invalid key must not be retried.");},Date.now()+1000),/openai_off/);
  });
  await test("An AI check retries with its original attempt and stores a report (mock provider)",async()=>{
    await sql`delete from fact_ai_throttle`;
    process.env.OPENAI_API_KEYS="fixture-key-1,fixture-key-2";process.env.OPENAI_MODEL="fixture-model";
    let modelCalls=0;
    const fixture={content_review:{all_items_read:true,all_core_claims_covered:true,issues:[]},verdict:"BELUM_TERVERIFIKASI",summary:"Integration test fixture only.",claims:[],red_flags:[],sources:[],reference_date:"",meta:{title:"Test fixture",platform:"web",author:"",published_at:""}};
    globalThis.fetch=async(url,options)=>{
      if(String(url).startsWith("https://api.openai.com/")) {modelCalls++;assert.equal(options.headers.Authorization,"Bearer fixture-key-1");return new Response(JSON.stringify(modelCalls===1?{}:{status:"completed",output:[{type:"web_search_call",status:"completed",action:{type:"search",sources:[]}},{type:"message",content:[{type:"output_text",text:JSON.stringify(fixture)}]}]}),{status:modelCalls===1?429:200});}
      if(String(url).startsWith("https://example.com"))return new Response(`<html><head><title>Test fixture</title></head><body><article>${"This is synthetic text for an integration test. ".repeat(40)}</article></body></html>`,{headers:{"content-type":"text/html"}});
      return originalFetch(url,options);
    };
    const response=await request("/api/analyze",{order_id:checkedOrder.order_id},alex);assert.equal(response.status,200,JSON.stringify(response.data));assert.equal(response.data.report.ok,true);assert.equal(modelCalls,2);
    const again=await request("/api/analyze",{order_id:checkedOrder.order_id},alex);assert.equal(again.status,200);assert.equal(modelCalls,2);
    assert.equal((await request("/api/account",undefined,alex)).data.attempts.length,0);
  });
  await test("A provider 429 returns Retry-After, persists it, and blocks repeated analysis calls without spending another attempt",async()=>{
    await sql`delete from fact_ai_throttle`;
    const granted = await request("/api/admin", { action: "grant", username: "alex", plan: "regular", request_key: randomUUID() }, admin);
    assert.equal(granted.status, 200);
    let modelCalls=0;
    globalThis.fetch=async(url,options)=>{
      if(String(url).startsWith("https://api.openai.com/")){modelCalls++;return new Response("{}",{status:429,headers:{"Retry-After":"60"}});}
      if(String(url).startsWith("https://example.com"))return new Response(`<article>${"Synthetic test article. ".repeat(80)}</article>`,{headers:{"content-type":"text/html"}});
      return originalFetch(url,options);
    };
    const created=await request("/api/checks",{...input,request_key:randomUUID()},alex);assert.equal(created.status,200);
    const response=await request("/api/analyze",{order_id:created.data.order_id},alex);
    assert.equal(response.status,429);assert.ok(Number(response.retryAfter)>=60);assert.ok(response.data.retry_after_seconds>=60);
    assert.equal((await request("/api/analyze",{order_id:created.data.order_id},alex)).status,429);assert.equal(modelCalls,1);
    const state=await request("/api/account",undefined,alex);assert.equal(state.data.attempts.length,0);
    assert.ok(state.data.orders.find(o=>o.order_id===created.data.order_id).retry_after_at);
  });
  await test("Failed Regular and Advance article checks retry the original owned order without another attempt", async () => {
    const fixture = { content_review: { all_items_read: true, all_core_claims_covered: true, issues: [] }, verdict: "BELUM_TERVERIFIKASI", summary: "Retry integration fixture.", claims: [], red_flags: [], sources: [], reference_date: "", meta: { title: "Fixture", platform: "web", author: "", published_at: "" } };
    for (const plan of ["regular", "advance"]) {
      await sql`delete from fact_ai_throttle`; await sql`delete from fact_ai_key_cooldowns`;
      const expectedModel = "gpt-6.2-sol";
      const grantResult = await request("/api/admin", { action: "grant", username: "alex", plan, request_key: randomUUID() }, admin);
      assert.equal(grantResult.status, 200);
      const created = await request("/api/checks", { ...input, plan, attempt_id: grantResult.data.attempt_id, request_key: randomUUID() }, alex);
      assert.equal(created.status, 200); const id = created.data.order_id;
      const seen = []; let fail = true;
      globalThis.fetch = async (url, options) => {
        if (String(url).startsWith("https://api.openai.com/")) {
          seen.push(JSON.parse(options.body).model);
          if (fail) throw new DOMException("Fixture timeout", "TimeoutError");
          return new Response(JSON.stringify({ status: "completed", output: [
            { type: "web_search_call", status: "completed", action: { type: "search", sources: [] } },
            { type: "message", content: [{ type: "output_text", text: JSON.stringify(fixture) }] }
          ] }));
        }
        if (String(url).startsWith("https://example.com")) return new Response(`<article>${"Synthetic retry test article. ".repeat(40)}</article>`, { headers: { "Content-Type": "text/html" } });
        return originalFetch(url, options);
      };
      for (let attempt = 0; attempt < 2; attempt++) {
        const failed = await request("/api/analyze", { order_id: id, plan: plan === "regular" ? "advance" : "regular", model: "client-model-must-be-ignored" }, alex);
        assert.equal(failed.status, 504, JSON.stringify(failed.data));
        assert.equal(failed.data.error, "ai_timeout");
        const state = await request("/api/account", undefined, alex);
        assert.ok(state.data.orders.some(order => order.order_id === id && order.status === "failed"));
        assert.equal(state.data.attempts.filter(value => value.plan === plan).length, 0);
      }
      assert.equal((await request("/api/analyze", { order_id: id }, other)).status, 404);
      const reloaded = await request(`/api/orders/${id}`, undefined, alex);
      assert.equal(reloaded.status, 200); assert.equal(reloaded.data.url, input.url); assert.equal(reloaded.data.plan, plan);
      fail = false;
      const success = await request("/api/analyze", { order_id: id }, alex);
      assert.equal(success.status, 200, JSON.stringify(success.data)); assert.equal(success.data.report.ok, true);
      assert.deepEqual(seen, [expectedModel, expectedModel, expectedModel]);
      assert.equal((await request("/api/analyze", { order_id: id }, alex)).status, 200); assert.equal(seen.length, 3);
      const [count] = await sql.query(`select count(*) as count from fact_orders where credit_attempt_id = $1`, [grantResult.data.attempt_id]);
      assert.equal(count.count, 1);
      const [used] = await sql.query(`select status, used_order_id from fact_attempts where attempt_id = $1`, [grantResult.data.attempt_id]);
      assert.equal(used.status, "used"); assert.equal(used.used_order_id, id);
    }
  });
  await test("Missing media runtime stops before consuming a granted attempt", async () => {
    const grantResult = await request("/api/admin", { action: "grant", username: "alex", plan: "advance", request_key: randomUUID() }, admin);
    assert.equal(grantResult.status, 200);
    const previous = process.env.MEDIA_PYTHON; process.env.MEDIA_PYTHON = "/nonexistent-realorna-fixture-python";
    try {
      const response = await request("/api/checks", { url: "https://www.instagram.com/p/fixture/", plan: "advance", lang: "id", attempt_id: grantResult.data.attempt_id, request_key: randomUUID() }, alex);
      assert.equal(response.status, 503); assert.equal(response.data.error, "media_setup");
      const [stored] = await sql.query(`select status, used_order_id from fact_attempts where attempt_id = $1`, [grantResult.data.attempt_id]);
      assert.equal(stored.status, "ready"); assert.equal(stored.used_order_id, null);
    } finally { if (previous === undefined) delete process.env.MEDIA_PYTHON; else process.env.MEDIA_PYTHON = previous; }
  });
  console.log(JSON.stringify({ok:true,integration_checks:checks.length,live_openai_tested:false}));
} finally { globalThis.fetch=originalFetch; await server.close(); }
