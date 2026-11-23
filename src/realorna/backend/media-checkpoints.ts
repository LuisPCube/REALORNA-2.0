import { getSql } from "@/lib/db";
import type { PreparedMedia } from "./media";
import type { OrderRow } from "./orders";

export type MediaVerificationInput = Omit<PreparedMedia, "audio"> & { transcripts: string[] };
export type CheckClaim = Pick<OrderRow, "order_id" | "claim_token">;

type StoredCheckpoint = {
  version: 1;
  media: Omit<MediaVerificationInput, "images">;
  images: { label: string; jpeg: string }[];
};

export async function readMediaCheckpoint(claim: CheckClaim, url: string): Promise<MediaVerificationInput | null> {
  const sql = await getSql();
  const [row] = await sql.query<{ payload: string }>(`with expired as (
    delete from fact_media_checkpoints where expires_at <= clock_timestamp()
  ) select c.payload from fact_media_checkpoints c join fact_orders o using (order_id)
    where c.order_id = $1 and c.source_url = $3 and c.expires_at > clock_timestamp()
      and o.status = 'processing' and o.claim_token = $2`, [claim.order_id, claim.claim_token, url]);
  if (!row) return null;
  try {
    const stored = JSON.parse(row.payload) as StoredCheckpoint;
    if (stored.version !== 1) return null;
    return { ...stored.media, images: stored.images.map(({ label, jpeg }) => ({ label, bytes: Buffer.from(jpeg, "base64") })) };
  } catch { return null; }
}

export async function saveMediaCheckpoint(claim: CheckClaim, url: string, { images, ...media }: MediaVerificationInput) {
  const sql = await getSql();
  const payload: StoredCheckpoint = {
    version: 1, media, images: images.map(({ label, bytes }) => ({ label, jpeg: Buffer.from(bytes).toString("base64") })),
  };
  // Lock the order while saving so a stale worker cannot replace a newer claim's input.
  await sql.query(`insert into fact_media_checkpoints (order_id, source_url, payload, expires_at)
    select order_id, $3, $4, clock_timestamp() + interval '30 minutes'
    from fact_orders where order_id = $1 and status = 'processing' and claim_token = $2 for update
    on conflict (order_id) do update set source_url = excluded.source_url, payload = excluded.payload, expires_at = excluded.expires_at`,
    [claim.order_id, claim.claim_token, url, JSON.stringify(payload)]);
}
