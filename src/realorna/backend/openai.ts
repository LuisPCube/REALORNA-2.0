import { z } from "zod";
import { SYSTEM_PROMPT } from "./prompt";
import { hasOpenAIKeys, withOpenAIKey } from "./key-pool";
import { evidenceUrl, parseModelJson } from "./contract";
import type { Plan, Source } from "../types";
import { GPT_6_2_SOL, modelForContent, type ContentType } from "./models";
import type { VisualInput } from "./media";
import { AiServiceError, providerDiagnostic, type AiDiagnostic } from "./ai-errors";

const ClaimSchema = z.object({
  text: z.string(), status: z.enum(["benar", "salah", "keliru", "belum_jelas"]),
  explanation: z.string(), correction: z.string(), importance: z.enum(["utama", "detail"]),
  source_urls: z.array(z.string()),
}).strict();
export const ModelSchema = z.object({
  verdict: z.enum(["FAKTA", "HOAKS", "MENYESATKAN", "SEBAGIAN_BENAR", "BELUM_TERVERIFIKASI"]),
  summary: z.string(), claims: z.array(ClaimSchema), red_flags: z.array(z.string()),
  sources: z.array(z.object({ title: z.string(), url: z.string(), publisher: z.string(), published_at: z.string() }).strict()),
  meta: z.object({ title: z.string(), platform: z.string(), author: z.string(), published_at: z.string() }).strict(),
  reference_date: z.string(),
  content_review: z.object({ all_items_read: z.boolean(), all_core_claims_covered: z.boolean(), issues: z.array(z.string()) }).strict(),
}).strict();

// Native fetch keeps retries under one shared policy; no hidden SDK retries.
type ResponseData = {
  status?: string;
  output?: {
    type?: string; status?: string;
    action?: { type?: string; url?: string; sources?: { url?: string; title?: string }[] };
    content?: { type?: string; text?: string; annotations?: { type?: string; url?: string; title?: string }[] }[];
  }[];
};

export function extractResponse(data: ResponseData, diagnostic: AiDiagnostic = { origin: "openai" }) {
  const failed = (reason: string) => new AiServiceError("ai_failed", { ...diagnostic, reason });
  if (data.status !== "completed") throw failed(data.status === "incomplete" ? "incomplete_response" : "response_not_completed");
  const sources: Source[] = [];
  const seen = new Set<string>();
  const add = (raw: string | undefined, title = "") => {
    const url = evidenceUrl(raw);
    if (!url || seen.has(url) || sources.length >= 80) return;
    seen.add(url);
    const host = new URL(url).hostname.replace(/^www\./, "");
    sources.push({ url, title: title.slice(0, 160) || host, publisher: host });
  };
  let searched = false;
  const text: string[] = [];
  for (const item of data.output ?? []) {
    if (item.type === "web_search_call" && item.status === "completed") {
      searched = true;
      for (const source of item.action?.sources ?? []) add(source.url, source.title);
      if (item.action?.type === "open_page") add(item.action.url);
    }
    for (const part of item.content ?? []) {
      if (part.type === "refusal") throw failed("refusal");
      if (part.type === "output_text") {
        if (part.text) text.push(part.text);
        for (const citation of part.annotations ?? []) if (citation.type === "url_citation") add(citation.url, citation.title);
      }
    }
  }
  // No search-free fallback. Do not silently turn model memory into evidence.
  if (!searched) throw failed("search_missing");
  const parsed = parseModelJson(text.join("\n"));
  if (!parsed || !ModelSchema.safeParse(parsed).success) throw failed("invalid_output");
  return { parsed, sources };
}

export async function askOpenAI(user: string, plan: Plan, deadline = Date.now() + 100_000, media?: { type: ContentType; images: VisualInput[] }) {
  const contentType = media?.type || "article";
  const model = modelForContent(contentType);
  if (contentType !== "article" && plan !== "advance") {
    throw new AiServiceError("ai_unavailable", { origin: "configuration", reason: "media_plan" });
  }
  const usesSol = model === GPT_6_2_SOL || model.startsWith(`${GPT_6_2_SOL}-`);
  const reasoning = usesSol && contentType !== "media"
    ? { effort: contentType === "video" ? "high" : "medium" }
    : undefined;
  const content: unknown[] = [{ type: "input_text", text: user }];
  for (const image of media?.images || []) {
    content.push({ type: "input_text", text: image.label }, { type: "input_image", image_url: `data:image/jpeg;base64,${Buffer.from(image.bytes).toString("base64")}`, detail: "high" });
  }
  if (!hasOpenAIKeys() || !model) throw new Error("openai_off");
  const schema = z.toJSONSchema(ModelSchema);
  delete schema.$schema;
  const response = await withOpenAIKey((key, signal, requestId) => fetch("https://api.openai.com/v1/responses", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, "X-Client-Request-Id": requestId },
    body: JSON.stringify({
      model, reasoning, store: false, instructions: SYSTEM_PROMPT, input: media ? [{ role: "user", content }] : user,
      tools: [{ type: "web_search", search_context_size: "medium" }], tool_choice: "required",
      max_tool_calls: 6, include: ["web_search_call.action.sources"], max_output_tokens: 7000,
      text: { format: { type: "json_schema", name: "realorna_fact_check", strict: true, schema } },
    }), signal,
  }), deadline);
  if (!response.ok) throw new AiServiceError([400, 401, 403, 404].includes(response.status) ? "ai_unavailable" : "ai_failed",
    providerDiagnostic(response, await response.clone().json().catch(() => ({}))));
  let data: ResponseData;
  try { data = await response.json() as ResponseData; }
  catch { throw new AiServiceError("ai_failed", { ...providerDiagnostic(response), reason: "invalid_json" }); }
  return extractResponse(data, providerDiagnostic(response));
}

const MEDIA_EXT: Record<string, string> = {
  "video/mp4": "mp4", "audio/mp4": "m4a", "audio/mpeg": "mp3", "video/mpeg": "mpeg",
  "audio/wav": "wav", "audio/x-wav": "wav", "video/webm": "webm", "audio/webm": "webm",
};
export async function transcribeWithOpenAI(media: { mime: string; bytes: Uint8Array }, deadline = Date.now() + 90_000): Promise<string | null> {
  const model = process.env.OPENAI_TRANSCRIBE_MODEL?.trim() || "gpt-transcribe";
  const ext = MEDIA_EXT[media.mime];
  if (!hasOpenAIKeys() || !ext || !media.bytes.length || media.bytes.length > 6_000_000) throw new AiServiceError("ai_unavailable", { origin: "configuration", reason: "transcription_input" });
  const response = await withOpenAIKey((key, signal, requestId) => {
    const body = new FormData();
    body.set("model", model);
    body.set("file", new Blob([new Uint8Array(media.bytes)], { type: media.mime }), `speech.${ext}`);
    return fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { Authorization: `Bearer ${key}`, "X-Client-Request-Id": requestId }, body, signal });
  }, deadline);
  if (!response.ok) throw new AiServiceError([400, 401, 403, 404].includes(response.status) ? "ai_unavailable" : "ai_failed",
    providerDiagnostic(response, await response.clone().json().catch(() => ({}))));
  let data: { text?: unknown };
  try { data = await response.json(); }
  catch { throw new AiServiceError("ai_failed", { ...providerDiagnostic(response), reason: "transcription_invalid_json" }); }
  if (typeof data.text !== "string" || data.text.length > 64000) throw new AiServiceError("ai_failed", { ...providerDiagnostic(response), reason: "transcription_incomplete" });
  // Empty transcript is explicitly recorded as no speech. Never replace an API
  // failure with a caption-only result. ASR may still mishear words/numbers.
  return data.text.trim() || null;
}
