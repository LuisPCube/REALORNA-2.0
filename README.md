# Realorna

A claim-based news and public-media checker with **Real / Nah**, corrections and linked comparison evidence.

- Articles: GPT-6 LUNA + web search, for either plan.
- Video: yt-dlp download → FFmpeg audio and selected frames → GPT Transcribe → GPT-6.1 Terra + web search.
- Image posts/carousels: all slides and caption in original order → Terra + web search.
- Existing accounts, bank transfers, admin grants, shared rate limits and same-order free retries are retained.

Start with **[MEDIA-DEPLOY.md](MEDIA-DEPLOY.md)**. This media release uses the supplied Vercel **Container Runtime** deployment, not a plain HTML file or a Node Function without media tools. **[SETUP.md](SETUP.md)** covers accounts, keys and bank configuration. **[VERIFICATION.md](VERIFICATION.md)** separates tested fixtures from unverified live behavior.

Public platforms can deny access even to public links. Missing or incomplete media fails without an invented verdict. Video visual review uses sampled frames and does not certify authenticity. Current bounds are 20 post items, 3 videos and 5 minutes of combined video. No live platform/OpenAI success or Vercel deployment is claimed by this source package.

The free IHSG examples are explicitly simulated, not current market information.
