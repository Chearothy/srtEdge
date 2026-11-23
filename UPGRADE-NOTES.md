# Rothy Dubber Free — Khmer TTS upgrade

## Included
- Same-origin VoxPocket Gradio proxy at `api/tts.js` for Vercel deployments.
- Local Python proxy route in `studio.py` for the local runner.
- Khmer TTS attempts the same-origin proxy first and falls back to direct Space access where CORS permits.
- Added custom reference voice upload slots for Piseth and Srey Mom, with transcript fields.
- Kept the existing main site design and Khmer TTS visual styling.

## Setup
### Vercel
Upload the complete project folder to the same GitHub repository and redeploy on Vercel. Keep the `api` directory at the project root. The proxy requires no Hugging Face token.

### Local computer
Run `python studio.py` from this folder. The local Python server proxies Gradio traffic through `/api/tts`.

### Custom voices
Upload a consented recording for Piseth and another for Srey Mom. Enter the exact words spoken in each reference clip when possible. Choose the corresponding voice in the Voice list after upload.

## Important limits
- The voice model is the external community Hugging Face Space `muyleanging/VoxPocket-TTS-Demo`; this project does not host or own its GPU.
- Shared ZeroGPU quota, Space downtime, upstream API changes, network access, and hosting execution limits can still interrupt generation.
- The proxy fixes common browser CORS / Edge access failures; it cannot bypass exhausted GPU quota.
- Reference voice cloning is approximate, not a guaranteed 100% match. Obtain the speaker's permission before uploading or generating their voice.
- Custom uploads are temporary Space-side inputs for the current browser session; re-upload them after a refresh if needed.
