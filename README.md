# Rothy Dubber Free

One project, two ways to run it. Edit `index.html` once and both update.

```
index.html      the whole app (website)
api/visit.js    visitor counter (Vercel serverless function)
khmer-tts/      NEW: Khmer TTS Studio module (index.html, style.css, app.js, gradio-client.js, README.md)
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

## Khmer TTS Studio
New nav button **🎙 Khmer TTS** (also reachable at `/khmer-tts/` and `/#khmer-tts`). It calls the public Hugging Face Space `muyleanging/VoxPocket-TTS-Demo` through the included same-origin `/api/tts` proxy on Vercel (with direct-browser fallback). No Hugging Face token is required. Details in `khmer-tts/README.md`.
