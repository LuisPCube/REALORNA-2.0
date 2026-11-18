import type { FactOk, Lang, MediaCoverage } from "./types";

export function coverageText(c: MediaCoverage, lang: Lang) {
  if (!c.videos) return lang === "id"
    ? `${c.slides} gambar dari ${c.items} item unggahan dibaca sesuai urutan beserta caption.`
    : `${c.slides} images across ${c.items} post items were read in order with the caption.`;
  const parts = lang === "id"
    ? [`${c.videos} video${c.slides ? ` dan ${c.slides} gambar` : ""}`, `${c.frames} frame terpilih otomatis`, c.audio_tracks ? `${c.transcribed_tracks}/${c.audio_tracks} trek audio ditranskripsikan` : "Video tidak memiliki trek audio"]
    : [`${c.videos} videos${c.slides ? ` and ${c.slides} images` : ""}`, `${c.frames} automatically selected frames`, c.audio_tracks ? `${c.transcribed_tracks}/${c.audio_tracks} audio tracks transcribed` : "The video has no audio track"];
  if (c.sampled_frames) parts.push(lang === "id" ? "Visual memakai sampel frame; bukan pemeriksaan setiap detik atau keaslian video." : "Visuals use sampled frames; this is not an every-second review or a video authenticity check.");
  return parts.join(". ");
}
export function resultLabel(verdict: FactOk["verdict"], lang: Lang) {
  if (verdict === "FAKTA" || verdict === "SEBAGIAN_BENAR") return "Real";
  if (verdict === "HOAKS" || verdict === "MENYESATKAN") return "Nah (Hoax)";
  return lang === "id" ? "Belum cukup bukti" : "Not enough evidence";
}
export function reportText(result: FactOk, lang: Lang) {
  const id = lang === "id";
  return ["Realorna", ...(result.demo ? [id ? "CONTOH ILUSTRATIF — bukan data pasar aktual" : "ILLUSTRATIVE EXAMPLE — not actual market data"] : []),
    resultLabel(result.verdict, lang), result.meta.title, result.summary, "",
    ...result.claims.flatMap(c => [
      `${({ benar: "✓", salah: "✕", keliru: "~", belum_jelas: "?" })[c.status]} ${c.text}`,
      ...(c.correction ? [`✓ ${id ? "Koreksi" : "Correction"}: ${c.correction}`] : []),
      c.explanation,
      ...(c.source_urls ?? []).map(url => `${id ? "Bukti" : "Evidence"}: ${url}`),
    ]),
    ...(result.coverage ? [`${id ? "Cakupan" : "Coverage"}: ${coverageText(result.coverage, lang)}`] : []),
    ...(result.reference_date ? [`${id ? "Konteks waktu" : "Time context"}: ${result.reference_date}`] : []),
    ...(result.checked_at ? [`${id ? "Diperiksa" : "Checked"}: ${result.checked_at}`] : []),
    ...(!result.demo ? [result.url] : []),
  ].filter(Boolean).join("\n");
}
