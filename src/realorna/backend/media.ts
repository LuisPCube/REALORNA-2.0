import { randomUUID } from "node:crypto";
import { getSql } from "@/lib/db";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, isAbsolute, relative } from "node:path";
import { z } from "zod";
import type { CheckStage, MediaCoverage } from "../types";
import { CheckError } from "./check-errors";

const ImageSchema = z.object({ path: z.string(), item: z.number().int().min(1).max(20), type: z.enum(["slide", "frame"]), timestamp: z.number().min(0).max(300).optional() });
const AudioSchema = z.object({ path: z.string(), item: z.number().int().min(1).max(20), duration: z.number().positive().max(300) });
const ManifestSchema = z.object({
  ok: z.literal(true), complete: z.literal(true), platform: z.string().max(40), url: z.string().url(),
  title: z.string().max(220), caption: z.string().max(32000), author: z.string().max(160), published_at: z.string().max(80),
  expected_items: z.number().int().min(1).max(20), items: z.number().int().min(1).max(20),
  videos: z.number().int().min(0).max(3), duration_seconds: z.number().min(0).max(300),
  images: z.array(ImageSchema).min(1).max(24), audio: z.array(AudioSchema).max(3),
});
export type VisualInput = { bytes: Uint8Array; label: string };
export type PreparedMedia = {
  title: string; caption: string; author: string; published_at: string;
  images: VisualInput[]; audio: { bytes: Uint8Array; item: number }[]; coverage: MediaCoverage;
};
const mediaCodes = ["media_setup", "media_unavailable", "media_unsupported", "media_limit", "media_partial", "media_timeout"] as const;

function childEnvironment(): NodeJS.ProcessEnv {
  // Extractors never receive database credentials, auth secrets, or OpenAI keys.
  const env: NodeJS.ProcessEnv = { PYTHONUNBUFFERED: "1", PYTHONDONTWRITEBYTECODE: "1" };
  for (const key of ["PATH", "LANG", "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "NODE_EXTRA_CA_CERTS",
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

async function runWorker(input: Record<string, unknown>, timeout: number, onStage?: (stage: CheckStage) => Promise<void>) {
  const script = process.env.MEDIA_SCRIPT_PATH?.trim() || join(process.cwd(), "media", "media_job.py");
  const python = process.env.MEDIA_PYTHON?.trim() || "python3";
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const child = spawn(python, [script], { env: childEnvironment(), stdio: ["pipe", "pipe", "ignore"], detached: process.platform !== "win32" });
    let output = "", last: Record<string, unknown> | undefined, finished = false, bytes = 0;
    let stageUpdates = Promise.resolve();
    const stop = () => {
      if (!child.pid) return;
      try { process.platform === "win32" ? child.kill("SIGKILL") : process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ }
    };
    const fail = (code: typeof mediaCodes[number]) => { if (finished) return; finished = true; clearTimeout(timer); stop(); reject(new CheckError(code)); };
    const timer = setTimeout(() => fail("media_timeout"), timeout);
    child.on("error", () => fail("media_setup"));
    child.stdin.on("error", () => {});
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 200_000) { fail("media_partial"); return; }
      output += chunk;
      let end: number;
      while ((end = output.indexOf("\n")) >= 0) {
        const line = output.slice(0, end); output = output.slice(end + 1);
        try {
          const data = JSON.parse(line) as Record<string, unknown>;
          if (data.stage === "downloading" || data.stage === "preparing_media") {
            const stage = data.stage;
            stageUpdates = stageUpdates.then(() => onStage?.(stage)).then(() => {});
            // Attach a handler immediately; DB failure must stop this check.
            void stageUpdates.catch(() => fail("media_unavailable"));
          } else last = data;
        } catch { fail("media_partial"); }
      }
    });
    child.on("close", () => {
      if (finished) return;
      finished = true; clearTimeout(timer); stop();
      void stageUpdates.then(() => {
        if (!last) return reject(new CheckError("media_setup"));
        if (last.ok !== true) {
          const code = mediaCodes.find(code => code === last?.error) || "media_unavailable";
          return reject(new CheckError(code));
        }
        resolve(last);
      }).catch(() => reject(new CheckError("media_unavailable")));
    });
    child.stdin.end(JSON.stringify(input));
  });
}

export async function acquireMediaSlot() {
  const sql = await getSql();
  await sql`insert into fact_ai_throttle (scope) values ('media') on conflict (scope) do nothing`;
  const token = randomUUID();
  const rows = await sql.query(`update fact_ai_throttle set lease_id = $1,
    lease_until = clock_timestamp() + interval '120 seconds'
    where scope = 'media' and (lease_until is null or lease_until <= clock_timestamp()) returning scope`, [token]);
  if (!rows.length) throw new CheckError("ai_busy", 3, "busy", { origin: "app_queue", reason: "media_capacity" });
  return token;
}
export async function releaseMediaSlot(token: string) {
  const sql = await getSql();
  await sql.query(`update fact_ai_throttle set lease_id = null, lease_until = null where scope = 'media' and lease_id = $1`, [token]);
}
let healthUntil = 0;
export async function ensureMediaReady() {
  if (healthUntil > Date.now()) return;
  await runWorker({ action: "health" }, 8000);
  healthUntil = Date.now() + 60_000;
}

export async function readConfinedFile(folder: string, name: string, max: number) {
  if (!/^[a-z0-9-]+\.(jpg|mp3)$/.test(name)) throw new CheckError("media_partial");
  try {
    const root = await realpath(folder), path = await realpath(join(root, name));
    const rel = relative(root, path);
    if (isAbsolute(rel) || rel.startsWith("..")) throw new CheckError("media_partial");
    const info = await stat(path);
    if (!info.isFile() || info.size < 64 || info.size > max) throw new CheckError("media_partial");
    return new Uint8Array(await readFile(path));
  } catch { throw new CheckError("media_partial"); }
}

export async function prepareMedia(url: string, deadline: number, onStage?: (stage: CheckStage) => Promise<void>): Promise<PreparedMedia> {
  await ensureMediaReady();
  const token = await acquireMediaSlot();
  let folder: string | undefined;
  try {
    folder = await mkdtemp(join(tmpdir(), "realorna-media-"));
    const timeout = Math.min(105_000, deadline - Date.now() - 110_000);
    if (timeout < 10_000) throw new CheckError("media_timeout");
    const raw = await runWorker({ url, workdir: folder, timeout_seconds: Math.min(100, (timeout - 2000) / 1000) }, timeout, onStage);
    const parsed = ManifestSchema.safeParse(raw);
    if (!parsed.success) throw new CheckError("media_partial");
    const media = parsed.data;
    if (media.items !== media.expected_items || media.audio.length > media.videos) throw new CheckError("media_partial");
    const covered = new Set(media.images.map(i => i.item));
    if (covered.size !== media.items || [...covered].some(i => i > media.items)) throw new CheckError("media_partial");
    const images = await Promise.all(media.images.map(async i => {
      const bytes = await readConfinedFile(folder!, i.path, 1_800_000);
      if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new CheckError("media_partial");
      return { bytes, label: i.type === "slide" ? `Post item / slide ${i.item} of ${media.items}` : `Video at post item ${i.item}, frame at ${i.timestamp?.toFixed(2)} seconds` };
    }));
    if (images.reduce((sum, image) => sum + image.bytes.length, 0) > 18_000_000) throw new CheckError("media_limit");
    const audio = await Promise.all(media.audio.map(async a => ({ item: a.item, bytes: await readConfinedFile(folder!, a.path, 6_000_000) })));
    return { title: media.title, caption: media.caption, author: media.author, published_at: media.published_at, images, audio,
      coverage: { items: media.items, videos: media.videos, frames: media.images.filter(i => i.type === "frame").length,
        slides: media.images.filter(i => i.type === "slide").length, duration_seconds: media.duration_seconds,
        audio_tracks: media.audio.length, transcribed_tracks: 0, sampled_frames: media.videos > 0 } };
  } finally {
    try { if (folder) await rm(folder, { recursive: true, force: true }); }
    finally { await releaseMediaSlot(token); }
  }
}
