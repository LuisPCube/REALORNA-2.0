# Realorna media deployment

Apply the included Git patch to the existing repository, or use the complete source in the `realorna` folder for a fresh checkout. Keep the existing database and authentication secret when deploying through Vercel.

## Vercel settings

1. Set **Root Directory** to the folder containing `package.json` and `Dockerfile.vercel` (the `realorna` folder in this ZIP).
2. Use **Container** as the framework/runtime. `Dockerfile.vercel` and `vercel.json` select it. Clear old custom npm build/output overrides if they prevent Container detection. The Dockerfile builds the app and installs Python, yt-dlp with EJS, gallery-dl, Node and FFmpeg/ffprobe.
3. Allow a **300-second function duration** in the project's Functions settings. Media checks have a 270-second application deadline; media download/preparation has its own 100-second budget. Very slow media still fails with a free saved retry.
4. Keep existing `DATABASE_URL`, `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`, and any admin variables. Startup applies pending SQL migrations and preserves existing accounts, attempts, and reports.
5. Configure the following server-side OpenAI variables for Production and, separately, Preview if used:

```text
OPENAI_API_KEY=<your existing OpenAI API key>
OPENAI_TEXT_MODEL=gpt-6.2-sol
OPENAI_VIDEO_MODEL=gpt-6.2-sol
OPENAI_MEDIA_MODEL=gpt-6.1-terra
OPENAI_TRANSCRIBE_MODEL=gpt-transcribe
```

Model values are built-in defaults, so only the key is strictly necessary. `OPENAI_API_KEYS` remains available for authorized key pools. Remove obsolete `OPENAI_MODEL` and `OPENAI_ADVANCE_MODEL`: they are ignored. `OPENAI_REGULAR_MODEL` is only a legacy fallback for the article model; `OPENAI_TEXT_MODEL` takes priority. Old Gemini/xAI keys are unused. Never use `VITE_` for secrets.

Vercel currently documents Container Runtime as beta and available on all plans. It is required for this all-in-one media deployment; an ordinary Node Function does not automatically include the Python media tools. If this project cannot select Container Runtime, this ZIP's media path is not deployment-ready on that project: use a supported container host or provide an external media worker integration before enabling media sales. The application detects missing tools before creating a media check or consuming its attempt.

Official deployment reference: https://vercel.com/docs/functions/runtimes/container

## Actual routing

| Input | Model / processing |
| --- | --- |
| Readable news/article, Regular or Advance | GPT-6.2 Sol at medium effort + mandatory web search |
| Public video | yt-dlp download, local FFmpeg audio extraction and automatic frame selection |
| Speech in downloaded audio | GPT Transcribe |
| Video frames + transcript + caption | GPT-6.2 Sol at high effort + mandatory web search |
| Instagram `/p/` carousel / supported image collection | gallery-dl retrieves every item, caption and order; Terra reads every image and verifies claims using web search |
| X/Twitter post | gallery-dl collection extraction; a complete GraphQL fallback is available. Incomplete syndication data is rejected |
| Result | Real, Nah, minor correction, or insufficient evidence; per-claim explanation and evidence links |

A URL is not sent to GPT as if it were an MP4. The backend sends actual audio bytes to transcription and actual image bytes to the visual model. No extra transcription API subscription is needed beyond enabled OpenAI API access; API usage is separately billable.

## Coverage and limits

- Direct public YouTube video/Shorts, Instagram reel/video/post, TikTok video/photo, X/Twitter status/video/photo and Facebook video/reel/watch links are recognized. Twitter `/video/1` and Instagram `img_index=2` do not restrict the check to only that item.
- Profiles, feeds, playlists and live streams are not checked as whole collections. Stories, private posts and login-only material are outside this implementation. No account cookies or login bypass are included.
- Up to **20 media items**, **3 videos**, **5 minutes of combined video**, **80 MB per downloaded file**, and **150 MB total downloaded media**. Images are bounded; a maximum of **24 visual inputs** and **18 MB of prepared JPEG data** is sent to the model. Over-limit content fails instead of being silently truncated.
- Video visual review uses uniformly spaced frames plus scene changes. Brief on-screen text between selected frames may be missed. This checks factual claims in the available material; it does not establish that every frame is authentic or detect deepfakes. Reports display the frame/audio/slide coverage.
- All carousel items must be present in their original order. Missing items, missing context or unreadable text prevent a fully verified result. The model must also state whether all material claims were covered within the eight-claim report limit.
- Platform extractors can break, or the platform can deny a server access to a public post. A public URL is not a guarantee of download access. The app reports `media_unavailable`, `media_partial`, `media_timeout` or another precise failure instead of guessing a binary result from the caption.
- No universal claim-verification accuracy guarantee is possible. Evidence links establish retrieval provenance; interpretation, dates, numbers and source relevance still require correct model analysis.

## Progress, retries and rate limits

The UI polls the owned order for actual server stages: reading, downloading, preparing media, transcribing, and verifying. It shows elapsed time, without fabricated percentage/checkmarks.

Download/preparation uses one shared database lease. ASR and verification share the existing OpenAI request gate across users and instances. Provider Retry-After and quota/busy distinctions remain intact. A timed-out OpenAI POST is not silently repeated. Transient safe retries are bounded.

Failures keep their original check ID, URL, plan, and consumed attempt. **Coba lagi gratis / Retry for free** reruns that saved check using the same attempt. The provider may charge again for transcription and analysis.

## Testing and rollout

`VERIFICATION.md` records previous test runs. The local test commands are listed in `SETUP.md`.

Before selling media checks, deploy a Preview and run one accessible public video per intended platform and a multi-slide post using your own configured API project. Confirm audio, visible claims, dated evidence and the reported coverage. Treat this as a release acceptance check, not something already completed in this ZIP.
