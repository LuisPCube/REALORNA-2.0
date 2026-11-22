# Realorna

A claim-based news and public-media checker with **Real / Nah**, corrections and linked comparison evidence.

- Articles use GPT-6.2 Sol with medium effort and web search for both plans.
- Video checks use yt-dlp, FFmpeg, GPT Transcribe, and GPT-6.2 Sol with high effort and web search.
- Image posts/carousels: all slides and caption in original order → Terra + web search.
- Admins grant Regular or Advance attempts by username. The recipient can use the attempt immediately from their account.

Start with **[MEDIA-DEPLOY.md](MEDIA-DEPLOY.md)** for Vercel **Container Runtime**. **[SETUP.md](SETUP.md)** covers accounts, keys, and sending attempts. **[VERIFICATION.md](VERIFICATION.md)** records previous verification runs.

Public platforms can deny access even to public links. Missing or incomplete media fails without an invented verdict. Video visual review uses sampled frames and does not certify authenticity. Current bounds are 20 post items, 3 videos and 5 minutes of combined video. No live platform/OpenAI success or Vercel deployment is claimed by this source package.

The free IHSG examples are explicitly simulated, not current market information.
