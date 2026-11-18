# Realorna — OpenAI + Real / Nah

Updated 8 November 2026. For this release, follow **MEDIA-DEPLOY.md** before redeploying.

| Content | Processing |
| --- | --- |
| Article, either plan | GPT-6 LUNA (`OPENAI_TEXT_MODEL`) + web search |
| Downloaded speech | GPT Transcribe (`OPENAI_TRANSCRIBE_MODEL`) |
| Frames, transcript, charts and post images | GPT-6.1 Terra (`OPENAI_MEDIA_MODEL`) + web search |

Defaults are `gpt-6-luna`, `gpt-transcribe`, and `gpt-6.1-terra`. `OPENAI_MODEL` and the old `OPENAI_ADVANCE_MODEL` are ignored. Existing API keys, database and authentication configuration remain server-side. Use the Container deployment shipped in this ZIP so the production server has yt-dlp, gallery-dl, Python and FFmpeg.

Reports use ✓ supported, ✕ false, ~ minor correction and ? unverified. Real means the checked core claims have supporting evidence; Nah means a core claim is contradicted. Unknown evidence, incomplete media or unreadable content must not be forced into a binary result. Historical claims are checked against their own event date. A publisher's identity cannot prove its article true.

The backend sends actual audio and JPEG inputs, not social page URLs disguised as media. Carousels preserve all slide items. Video review combines the downloaded audio transcript with automatically sampled frames; it does not inspect every moment or detect deepfakes. Every report displays its coverage when media was processed.

A failed check keeps its original URL/plan/attempt and has a free saved retry. Provider charges may recur when retrying. Missing runtime tools are detected before consuming a media attempt. Shared download and OpenAI leases limit concurrency; real provider 429/Retry-After behavior is preserved.

See **VERIFICATION.md** for what passed locally and what still requires a live Preview acceptance check. Successful live platform extraction and real OpenAI verification were not established in this environment.
