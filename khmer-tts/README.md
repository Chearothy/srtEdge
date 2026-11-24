# Khmer TTS Studio (module)

Standalone Khmer text-to-speech page for Rothy Dubber Free. Lives entirely in this folder:

| File | Purpose |
|---|---|
| `index.html` | Page (open directly at `/khmer-tts/`, or embedded in the main site via the "🎙 Khmer TTS" nav button) |
| `style.css` | Dark, responsive, mobile-first UI |
| `app.js` | State, validation, voices, audio player, download, error handling |
| `gradio-client.js` | ~150-line dependency-free client for the public Gradio HTTP API |

## How it works
Browser → same-origin `/api/tts` proxy → public Hugging Face Space `muyleanging/VoxPocket-TTS-Demo` → WAV → Browser. The proxy avoids common browser CORS/Edge failures and needs no Hugging Face token. If the proxy is unavailable (for example, when opened directly from disk), the app tries the direct browser connection as a fallback.

Endpoints used (names taken from the Space's `app.py`, and re-checked live from the Space's `/config` every time the page opens):

1. `pick_voice(name)` → `[reference clip, clip transcript]`. Voices: **Woman 1, Woman 2, Man 1** (the "Upload my own voice" option is intentionally not offered). The clip is also used for **Preview**.
2. `clone(text, style, clip, clip_text, cfg, steps, seed)` → `[audio, note]`. The built-in voices are the Space's reference clips, exactly as in the Space's own UI.

Protocol: `POST /gradio_api/call/{api}` then read Server-Sent Events from `GET /gradio_api/call/{api}/{event_id}` (this goes through the Space's Gradio queue).

Voice/style lists and slider ranges are read from the Space at runtime; the built-in fallback lists only show before the Space answers.

## Limits and behaviour
- Max **1500 characters** per request (Space limit). Longer text is blocked with a message, never silently cut.
- The proxy improves connectivity but cannot increase the public Space's shared GPU allowance. The Space runs on ZeroGPU: first request after idle can take ~1 minute, and anonymous visitors share a limited free GPU quota. If it is exhausted, the page shows the Space's message.
- If the Space is asleep/stopped, the status pill and error message say so and link to the Space.
- Only one request at a time; Cancel is available while generating.
- Download saves the real file returned by the Space (extension taken from its type, normally `.wav`), named `khmer-tts-<voice>-<date>-<time>.wav`. Empty/invalid files are rejected.

## Embedding / navigation
The main `index.html` loads `khmer-tts/?embed=1` in an iframe the first time the button is pressed (kept alive afterwards). URL hash: `/#khmer-tts`. Direct access: `/khmer-tts/`.


## Reliability update
- Added `api/tts.js`, a same-origin Vercel proxy restricted to the VoxPocket Space and the Gradio endpoints used by this page.
- The studio first connects through `/api/tts`; if that route is unavailable, it attempts direct Space access where browser CORS permits.
- No token is embedded in the project. Never put a private Hugging Face token in browser JavaScript.
- The upstream is a community Space with shared free GPU capacity. Quota exhaustion, Space downtime, or model/API changes cannot be fixed by this client-side project alone.


## Piseth and Srey Mom custom voices
Use the two upload fields in the Voice card to upload each person's consented reference recording (recommended: 10–30 seconds, clear speech, little background noise, maximum 15 MB). After upload, select Piseth or Srey Mom and generate Khmer speech. These are user-provided reference samples; they are not bundled identities. The upload feature requires the hosted same-origin proxy route on Vercel. A model may not reproduce a speaker perfectly, and Khmer pronunciation quality depends on the underlying model.
