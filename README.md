# Rothy Dubber Free

One project, two ways to run it. Edit `index.html` once and both update.

```
index.html      the whole app (website)
api/visit.js    visitor counter (Vercel serverless function)
studio.py       local runner: serves index.html + native-ffmpeg "Cut clip" (no size limit)
vercel.json     Vercel settings
```

## Run on your computer
```
python studio.py                 # opens the app; needs Python 3.8+ and ffmpeg
python studio.py movie.mp4 --minutes 3     # cut from the command line
```
`studio.py` must stay in the same folder as `index.html`.

## Host on GitHub + Vercel
1. Create a GitHub repo and upload everything in this folder (keep the `api` folder at the root).
2. Vercel → **Add New → Project** → import the repo → **Deploy** (no build settings needed).
3. Visitor counter (free): Vercel project → **Storage** → **Create** → **Upstash Redis** → free plan → **Connect to Project**.
   Then **Deployments → ⋯ → Redeploy** so the function can see the new variables.
4. Open your site. The first visit on a device adds 1 to the number (starts at 3,124).
   Add `?debug` to the address to see an alert explaining why the counter is not live.

## Notes
- On Vercel, **Cut clip** runs inside the browser (ffmpeg.wasm), so very large files depend on the device's memory.
  The local `studio.py` uses native ffmpeg and has no size limit.
- The counter counts devices (a browser's local storage), not people; clearing site data counts again.
- Change the starting number with `BASE` in `api/visit.js`.

## Fast dubbing pipeline (new)
```
audio clean-up -> split at silences -> [chunk 1] [chunk 2] ...
                      transcribe (gemini-3.5-transcribe, streamed)
                         -> translate (gemini-3.5-flash-lite, small batches, strict Khmer TTS-ready rules)
                            -> Khmer voice (gemini-3.8-flash-lite-tts)
```
All stages run at the same time: translation starts as soon as the first sentence is transcribed, and the first
Khmer audio is generated while the rest of the video is still being transcribed.

- **Pipeline tab**: "Stream" turns the new pipeline on (off = the old one-step-after-another mode),
  "Clean audio first" controls the pre-processing, "Speed" sets how many requests run at once
  (use *Safe* with a single free key).
- **With `python studio.py`** the pre-processing runs in native ffmpeg (denoise, EQ, compressor, loudness, silence detection).
  **On Vercel** the same steps run in the browser (Web Audio), so very long videos depend on the device's memory.
- If a model name is not available for your key, the app logs it and falls back to the next model in its list.

## Khmer Voice
Press **🗣 Khmer Voice** in the navbar, type Khmer text, press it again: the voice is generated through the Hugging Face
Space `muyleanging/VoxPocket-TTS-Demo` and played inside the page (hidden `<audio>`), no redirect.

- **On Vercel (git push, nothing else to set up):** `api/generate-khmer-voice.js` calls the Space over HTTP (no dependencies).
  `vercel.json` gives it up to 60 s because a sleeping Space can take a while to wake up.
- **Locally:** `pip install gradio_client` then `python studio.py` - the same URL `/api/generate-khmer-voice` is answered by
  `studio.py` (it uses `gradio_client`, and saves the audio in `./static/khmer_voice`).
- Optional environment variables: `HF_TOKEN` (private / rate-limited Space), `KHMER_TTS_SPACE` (another Space), `KHMER_TTS_API` (endpoint name).
