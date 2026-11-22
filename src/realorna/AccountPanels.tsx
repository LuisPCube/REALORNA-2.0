import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, Gift, RefreshCw, ShieldCheck } from "lucide-react";
import { apiRequest, errorMessage, say, useAccount } from "./account";
import type { AccountOrder, Attempt } from "./account-types";
import type { Lang, Plan } from "./types";

const checkStatusLabels = {
  queued: { en: "Ready to check", id: "Siap dicek" },
  processing: { en: "Checking", id: "Sedang dicek" },
  processed: { en: "Completed", id: "Selesai" },
  failed: { en: "Failed", id: "Gagal" },
};

export function AccountPanel({ lang, onAttempt, onOrder }: { lang: Lang; onAttempt: (attempt: Attempt) => void; onOrder: (order: AccountOrder) => void }) {
  const { user, attempts, orders, refresh } = useAccount();
  if (!user) return null;
  const regular = attempts.filter(a => a.plan === "regular").length;
  const advance = attempts.filter(a => a.plan === "advance").length;
  const retries = orders.filter(order => order.status === "failed").length;
  return <section className="account-card account-overview" aria-label={say(lang,"Your account","Akunmu")}>
    <div className="account-section-head"><div><span className="eyebrow">{say(lang,"YOUR ACCOUNT","AKUNMU")}</span><h2>@{user.username}</h2></div><button className="icon-action" type="button" aria-label={say(lang,"Refresh account","Muat ulang akun")} onClick={() => void refresh()}><RefreshCw size={17}/></button></div>
    {user.admin ? <p className="success-line"><ShieldCheck size={18}/>{say(lang,"Admins can run Regular and Advance checks.","Admin bisa menjalankan cek Regular dan Advance.")}</p> : <div className="credit-grid">
      <div><span>Regular</span><strong>{regular}</strong><small>{say(lang,"attempts available","kesempatan tersedia")}</small></div>
      <div><span>Advance</span><strong>{advance}</strong><small>{say(lang,"attempts available","kesempatan tersedia")}</small></div>
    </div>}
    {attempts.length > 0 && <details className="account-details"><summary>{say(lang,"Use an available attempt","Gunakan kesempatan tersedia")}</summary><ul className="account-list">
      {attempts.map(a => <li key={a.attempt_id}><span><Gift size={16}/><strong>{a.plan === "advance" ? "Advance" : "Regular"}</strong></span><button type="button" className="btn" onClick={() => onAttempt(a)}>{say(lang,"Use","Gunakan")}</button></li>)}
    </ul></details>}
    {orders.length > 0 && <details className="account-details"><summary>{say(lang,"Recent checks","Pemeriksaan terbaru")}{retries > 0 ? say(lang, ` · ${retries} free retries saved`, ` · ${retries} retry gratis tersimpan`) : ""}</summary><ul className="account-list">
      {orders.map(order => {
        const waiting = Boolean(order.retry_after_at && new Date(order.retry_after_at).getTime() > Date.now());
        return <li key={order.order_id}><span className="account-order-summary"><strong>{order.plan === "advance" ? "Advance" : "Regular"} · {checkStatusLabels[order.status][lang]}</strong><small>{order.url}</small>
          {order.status === "failed" && <small>{say(lang,"Free retry saved for this link and plan.","Retry gratis tersimpan untuk link dan paket ini.")}</small>}</span>
          <button type="button" className="btn" disabled={waiting} onClick={() => onOrder(order)}>
            {order.status === "processed" ? say(lang,"Report","Laporan")
              : waiting ? say(lang,"Waiting to retry","Menunggu jeda")
              : order.status === "failed" ? say(lang,"Retry for free","Coba lagi gratis") : say(lang,"Resume / retry","Lanjut / ulang")}
          </button>
        </li>;
      })}
    </ul></details>}
  </section>;
}

type Audit = { action: string; username: string; plan: string | null; created_at: string };
export function AdminPanel({ lang }: { lang: Lang }) {
  const [username, setUsername] = useState("");
  const [audit, setAudit] = useState<Audit[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [link, setLink] = useState("");
  const key = useRef<{ username: string; plan: Plan; value: string } | null>(null);
  const { refresh } = useAccount();
  const load = useCallback(async () => {
    try { const data = await apiRequest<{ audit: Audit[] }>("/api/admin"); setAudit(data.audit); }
    catch (e) { setError(errorMessage(e, lang)); }
  }, [lang]);
  useEffect(() => { void load(); const timer = setInterval(() => { if (!document.hidden) void load(); }, 15_000); return () => clearInterval(timer); }, [load]);
  async function grant(plan: Plan) {
    if (busy || !username.trim()) return;
    setBusy(true); setError(""); setNote(""); setLink("");
    const normalized = username.trim().toLowerCase();
    if (!key.current || key.current.username !== normalized || key.current.plan !== plan) key.current = { username: normalized, plan, value: crypto.randomUUID() };
    try {
      const data = await apiRequest<{ username: string; plan: Plan; link: string }>("/api/admin", { action: "grant", username: normalized, plan, request_key: key.current.value });
      setNote(say(lang, `1 ${data.plan === "advance" ? "Advance" : "Regular"} attempt sent to @${data.username}.`, `1 kesempatan ${data.plan === "advance" ? "Advance" : "Regular"} dikirim ke @${data.username}.`));
      setLink(new URL(data.link, window.location.origin).toString()); key.current = null; setUsername(""); await load(); await refresh();
    } catch (e) { setError(errorMessage(e, lang)); }
    finally { setBusy(false); }
  }
  return <section className="account-card admin-panel" id="admin-panel">
    <div className="account-section-head"><div><span className="eyebrow">ADMIN</span><h2>{say(lang,"Send attempts","Kirim kesempatan")}</h2></div><ShieldCheck size={26}/></div>
    <div><p>{say(lang,"Enter a registered username, then send one check attempt.","Masukkan username yang sudah terdaftar, lalu kirim satu kesempatan cek.")}</p>
      <form className="stack-form" onSubmit={e => { e.preventDefault(); void grant("regular"); }}>
        <label htmlFor="grant-username">Username<input id="grant-username" autoComplete="off" required minLength={3} maxLength={30} pattern="[A-Za-z0-9_.]+" value={username} onChange={e => setUsername(e.target.value)} disabled={busy} placeholder="alex"/></label>
        <div className="grant-buttons"><button className="btn primary" type="submit" disabled={busy || !username.trim()}><Gift size={17}/>{say(lang,"Send Regular","Kirim Regular")}</button><button className="btn advance-button" type="button" disabled={busy || !username.trim()} onClick={() => void grant("advance")}><Gift size={17}/>{say(lang,"Send Advance","Kirim Advance")}</button></div>
      </form>
      {note && <p className="success-line" role="status"><Check size={18}/>{note}</p>}
      {link && <div className="attempt-share"><label htmlFor="attempt-link">{say(lang,"Account-bound attempt link","Tautan kesempatan khusus akun")}</label><div><input id="attempt-link" readOnly value={link}/><button className="btn" type="button" onClick={() => void navigator.clipboard.writeText(link).then(() => setNote(say(lang,"Link copied.","Tautan disalin."))).catch(() => setNote(say(lang,"Select the link and copy it manually.","Pilih dan salin tautan secara manual.")))}><Copy size={16}/>{say(lang,"Copy","Salin")}</button></div></div>}
      {audit.length > 0 && <details className="account-details"><summary>{say(lang,"Recent admin actions","Aktivitas admin terbaru")}</summary><ul className="audit-list">{audit.map((a,i) => <li key={a.created_at+i}><span>@{a.username} · {a.action}{a.plan ? ` · ${a.plan}` : ""}</span><time>{new Date(a.created_at).toLocaleString(lang === "id" ? "id-ID" : "en-GB")}</time></li>)}</ul></details>}
    </div>
    {error && <p className="form-error" role="alert">{error}</p>}
  </section>;
}
