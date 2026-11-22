#!/usr/bin/env python3
"""
Khmer Dubber Studio - local runner. Same app as the website: it serves index.html (next to this file)
and adds native-ffmpeg Cut clip. Edit index.html once and both the website and this runner update.

  python studio.py                      open the full app (Dubber + Cut clip) in your browser
  python studio.py movie.mp4 --minutes 3   cut from the command line (no browser)

Dubbing pipeline: the page streams  clean audio -> transcribe -> translate -> Khmer voice  at the same time.
With studio.py, step 0 (denoise + loudness + silence-aware chunking) runs in native ffmpeg.
  python studio.py movie.mp4 --size 25 --zip | --seconds 90 | --precise | --start 30 --end 100

Cut clip runs with native ffmpeg: no size limit, no engine download, no API.
Needs Python 3.8+ and ffmpeg (https://ffmpeg.org  or:  pip install imageio-ffmpeg).
"""
import argparse, atexit, base64, inspect, json, math, mimetypes, os, re, shutil, socket, subprocess, sys, tempfile, threading, time, uuid, webbrowser, zipfile, zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlparse

try:                                   # Khmer Voice (Hugging Face Space) - optional: pip install gradio_client
    from gradio_client import Client
except ImportError:
    Client = None

NOWIN = getattr(subprocess, "CREATE_NO_WINDOW", 0)
HTML_PATH = Path(__file__).resolve().with_name("index.html")


# ------------------------------------------------------------------ cutting core
def find_ffmpeg():
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        raise RuntimeError("ffmpeg not found. Install it from https://ffmpeg.org or run: pip install imageio-ffmpeg")


def get_duration(ff, path):
    p = subprocess.run([ff, "-hide_banner", "-i", path], capture_output=True, text=True, creationflags=NOWIN)
    m = re.search(r"Duration:\s*(\d+):(\d+):([\d.]+)", p.stderr)
    if not m:
        raise RuntimeError("Could not read the video length. Is this a valid video file?")
    return int(m[1]) * 3600 + int(m[2]) * 60 + float(m[3])


def cut(path, out_dir=None, seconds=None, size_mb=None, precise=False, make_zip=False, start=0.0, end=None,
        progress=None, log=print):
    """Cut `path` into clips. Returns [{name, path, start, end, size}]."""
    ff = find_ffmpeg()
    dur = get_duration(ff, path)
    end = min(end or dur, dur)
    total = max(0.1, end - start)
    if size_mb:
        seconds = size_mb * 1048576 / (os.path.getsize(path) / dur)
    if not seconds or seconds < 1:
        raise ValueError("Clip length must be at least 1 second.")
    base, ext = os.path.splitext(os.path.basename(path))
    ext = ext.lower() if ext.lower() in (".mp4", ".mkv", ".webm") else ".mp4"
    out_dir = out_dir or os.path.join(os.path.dirname(os.path.abspath(path)), base + "_clips")
    os.makedirs(out_dir, exist_ok=True)
    for f in os.listdir(out_dir):
        if re.fullmatch(re.escape(base) + r"_clip_\d+" + re.escape(ext), f):
            os.remove(os.path.join(out_dir, f))
    lst = os.path.join(out_dir, ".segments.csv")
    cmd = [ff, "-y", "-hide_banner", "-loglevel", "error", "-progress", "pipe:1", "-nostats"]
    if start > 0:
        cmd += ["-ss", str(start)]
    cmd += ["-i", path] + (["-t", str(total)] if end < dur else []) + ["-map", "0:v?", "-map", "0:a?"]
    cmd += (["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "aac", "-b:a", "160k",
             "-force_key_frames", f"expr:gte(t,n_forced*{seconds})"] if precise else ["-c", "copy"])
    cmd += ["-f", "segment", "-segment_time", f"{seconds:.3f}", "-segment_start_number", "1", "-reset_timestamps", "1",
            "-segment_list", lst, "-segment_list_type", "csv", os.path.join(out_dir, f"{base}_clip_%03d{ext}")]
    log(f"Cutting {total:.0f}s into clips of about {seconds:.0f}s ({'exact / re-encode' if precise else 'fast / no re-encode'}) ...")
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, creationflags=NOWIN)
    for line in p.stdout:
        m = re.match(r"out_time_ms=(\d+)", line)
        if m and progress:
            progress(min(0.99, int(m[1]) / 1e6 / total))
    err = p.stderr.read()
    if p.wait() != 0:
        raise RuntimeError("ffmpeg failed:\n" + err.strip()[-800:])
    clips = []
    if os.path.exists(lst):
        for row in open(lst):
            c = row.strip().split(",")
            if len(c) >= 3:
                fp = os.path.join(out_dir, c[0])
                clips.append(dict(name=c[0], path=fp, start=start + float(c[1]), end=start + float(c[2]), size=os.path.getsize(fp)))
        os.remove(lst)
    if make_zip and clips:
        make_zip_file(clips, os.path.join(out_dir, base + "_clips.zip"))
    log(f"Done: {len(clips)} clips -> {out_dir}")
    if progress:
        progress(1.0)
    return clips


def make_zip_file(clips, zp):
    with zipfile.ZipFile(zp, "w", zipfile.ZIP_STORED, allowZip64=True) as z:     # video is already compressed
        for c in clips:
            z.write(c["path"], c["name"])
    return zp



# ------------------------------------------------------------------ audio pre-processing for the dubbing pipeline
# Clean speech (high-pass, low-pass, noise reduction, compression, loudness) and split at SILENCES into chunks,
# so transcription can start on chunk 1 while the rest is still being prepared.
AUDIO_FILTER = ("highpass=f=90,lowpass=f=7600,afftdn=nf=-28,"
                "acompressor=threshold=0.09:ratio=3:attack=5:release=200,"
                "loudnorm=I=-18:TP=-1.5:LRA=11,alimiter=limit=0.95")


def plan_cuts(ff, path, dur, target=40.0, lo=20.0, hi=55.0):
    """Chunk boundaries at the quietest moments, about `target` seconds apart."""
    p = subprocess.run([ff, "-hide_banner", "-nostats", "-i", path, "-vn", "-ac", "1", "-ar", "16000",
                        "-af", "silencedetect=noise=-32dB:d=0.25", "-f", "null", "-"],
                       capture_output=True, text=True, creationflags=NOWIN)
    st = [float(x) for x in re.findall(r"silence_start: ([\d.]+)", p.stderr)]
    en = [float(x) for x in re.findall(r"silence_end: ([\d.]+)", p.stderr)]
    mids = [(a + b) / 2 for a, b in zip(st, en)]
    cuts, cur = [0.0], 0.0
    while dur - cur > hi:
        cand = [m for m in mids if cur + lo <= m <= cur + hi]
        cur = min(cand, key=lambda m: abs(m - (cur + target))) if cand else cur + target
        cuts.append(cur)
    cuts.append(dur)
    if len(cuts) > 2 and cuts[-1] - cuts[-2] < 6:
        del cuts[-2]
    return list(zip(cuts[:-1], cuts[1:]))


def prep_worker(s, target=40.0, clean=True):
    try:
        ff = find_ffmpeg()
        plan = plan_cuts(ff, s["path"], s["dur"], target)
        s["prep"] = dict(total=len(plan), chunks=[], done=False, error=None)
        for i, (a, b) in enumerate(plan):
            out = str(TMP / s["id"] / f"chunk_{i:04d}.wav")
            cmd = [ff, "-y", "-hide_banner", "-loglevel", "error", "-ss", f"{a:.3f}", "-t", f"{b - a:.3f}", "-i", s["path"],
                   "-vn", "-ac", "1", "-ar", "16000"] + (["-af", AUDIO_FILTER] if clean else []) + ["-c:a", "pcm_s16le", out]
            r = subprocess.run(cmd, capture_output=True, text=True, creationflags=NOWIN)
            if r.returncode != 0:
                raise RuntimeError("ffmpeg: " + r.stderr.strip()[-300:])
            s["prep"]["chunks"].append(dict(i=i, start=a, end=b, path=out))
        s["prep"]["done"] = True
    except Exception as e:
        s.setdefault("prep", dict(total=0, chunks=[], done=False))["error"] = str(e)


# ------------------------------------------------------------------ Khmer Voice (Hugging Face Space, headless)
HF_SPACE = os.environ.get("KHMER_TTS_SPACE", "muyleanging/VoxPocket-TTS-Demo")
STATIC_DIR = Path(__file__).resolve().with_name("static")        # served at  /static/...
VOICE_DIR = STATIC_DIR / "khmer_voice"
_tts = {"client": None}
_tts_lock = threading.Lock()


def _tts_client():
    if Client is None:
        raise RuntimeError("gradio_client is not installed. Run:  pip install gradio_client")
    with _tts_lock:
        if _tts["client"] is None:
            kw = {"verbose": False}
            tok = os.environ.get("HF_TOKEN")
            if tok:                                                # optional, for private / rate-limited Spaces
                kw["token" if "token" in inspect.signature(Client.__init__).parameters else "hf_token"] = tok
            _tts["client"] = Client(HF_SPACE, **kw)
        return _tts["client"]


def _find_audio(x):
    """gradio_client downloads the result and returns a local path (str), a dict, or a tuple/list containing one."""
    if isinstance(x, str):
        return x if os.path.isfile(x) else None
    if isinstance(x, dict):
        for k in ("path", "value", "name"):
            r = _find_audio(x.get(k))
            if r:
                return r
    if isinstance(x, (list, tuple)):
        for i in x:
            r = _find_audio(i)
            if r:
                return r
    return None


def _text_param(client):
    """Name of the text input of /predict (so extra inputs such as speed/voice keep their defaults)."""
    try:
        params = client.view_api(return_format="dict", print_info=False)["named_endpoints"]["/predict"]["parameters"]
    except Exception:
        return None
    best = None
    for p in params:
        t = str((p.get("python_type") or {}).get("type", "")).lower()
        label = (str(p.get("label", "")) + " " + p["parameter_name"]).lower()
        if "str" in t and any(w in label for w in ("text", "prompt", "input", "sentence")):
            return p["parameter_name"]
        if best is None and "str" in t:
            best = p["parameter_name"]
    return best or (params[0]["parameter_name"] if params else None)


def khmer_tts(text):
    """Text -> audio file saved in ./static/khmer_voice. Returns the local URL the page can play."""
    text = (text or "").strip()
    if not text:
        raise ValueError("Type some Khmer text first.")
    if len(text) > 1500:
        raise ValueError("The text is too long (max 1500 characters).")
    client = _tts_client()
    name = _text_param(client)
    try:
        res = client.predict(**{name: text}, api_name="/predict") if name else client.predict(text, api_name="/predict")
    except TypeError:
        res = client.predict(text, api_name="/predict")
    src = _find_audio(res)
    if not src:
        raise RuntimeError("The Space did not return an audio file.")
    VOICE_DIR.mkdir(parents=True, exist_ok=True)
    out = f"khmer_{int(time.time())}_{uuid.uuid4().hex[:6]}{Path(src).suffix or '.wav'}"
    shutil.copyfile(src, VOICE_DIR / out)
    for old in sorted(VOICE_DIR.iterdir(), key=lambda f: f.stat().st_mtime)[:-40]:      # keep the 40 newest
        try:
            old.unlink()
        except OSError:
            pass
    return "/static/khmer_voice/" + out

# ------------------------------------------------------------------ local web app
ROOT = Path.home() / "VideoCutter"
TMP = Path(tempfile.mkdtemp(prefix="vcut_"))
atexit.register(lambda: shutil.rmtree(TMP, ignore_errors=True))
SESS = {}


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def send_json(self, obj, code=200):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(b)

    def send_file(self, path, name, mime):
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(os.path.getsize(path)))
        self.send_header("Content-Disposition", "attachment; filename*=UTF-8''" + quote(name))
        self.end_headers()
        with open(path, "rb") as f:
            shutil.copyfileobj(f, self.wfile, 4 << 20)

    def do_GET(self):
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        if u.path == "/":
            b = HTML_PATH.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(b)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            return self.wfile.write(b)
        if u.path == "/api/ping":
            try:
                return self.send_json({"ok": True, "ffmpeg": find_ffmpeg(), "folder": str(ROOT), "features": ["cut", "prep", "khmer-voice"]})
            except Exception as e:
                return self.send_json({"ok": False, "error": str(e)})
        s = SESS.get(q.get("id", ""))
        if u.path == "/api/progress" and s:
            return self.send_json({k: s.get(k) for k in ("progress", "done", "error", "clips", "folder")})
        if u.path == "/api/clip" and s and s.get("clips"):
            c = s["clips"][int(q.get("i", 0))]
            return self.send_file(c["path"], c["name"], "video/mp4")
        if u.path == "/api/zip" and s and s.get("clips"):
            zp = TMP / s["id"] / "clips.zip"
            make_zip_file(s["clips"], str(zp))
            return self.send_file(str(zp), os.path.splitext(s["name"])[0] + "_clips.zip", "application/zip")
        if u.path.startswith("/static/"):                       # audio created by /api/generate-khmer-voice
            p = (STATIC_DIR / unquote(u.path[len("/static/"):])).resolve()
            if STATIC_DIR.resolve() in p.parents and p.is_file():
                data = p.read_bytes()
                start, end, code = 0, len(data) - 1, 200
                m = re.match(r"bytes=(\d*)-(\d*)", self.headers.get("Range") or "")
                if m and (m[1] or m[2]):                         # Safari needs Range support to play audio
                    start = int(m[1]) if m[1] else max(0, len(data) - int(m[2]))
                    end = min(int(m[2]), len(data) - 1) if m[1] and m[2] else len(data) - 1
                    code = 206
                self.send_response(code)
                self.send_header("Content-Type", mimetypes.guess_type(p.name)[0] or "application/octet-stream")
                self.send_header("Accept-Ranges", "bytes")
                self.send_header("Content-Length", str(end - start + 1))
                if code == 206:
                    self.send_header("Content-Range", f"bytes {start}-{end}/{len(data)}")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                return self.wfile.write(data[start:end + 1])
        if u.path == "/api/prep_status" and s and s.get("prep"):
            p = s["prep"]
            return self.send_json({"total": p["total"], "done": p["done"], "error": p["error"],
                                   "chunks": [{"i": c["i"], "start": c["start"], "end": c["end"]} for c in p["chunks"]]})
        if u.path == "/api/chunk" and s and s.get("prep"):
            c = s["prep"]["chunks"][int(q.get("i", 0))]
            return self.send_file(c["path"], os.path.basename(c["path"]), "audio/wav")
        self.send_json({"error": "not found"}, 404)

    def do_POST(self):
        u = urlparse(self.path)
        n = int(self.headers.get("Content-Length") or 0)
        try:
            if u.path == "/api/upload":
                name = os.path.basename(parse_qs(u.query).get("name", ["video.mp4"])[0]) or "video.mp4"
                sid = uuid.uuid4().hex[:8]
                (TMP / sid).mkdir(exist_ok=True)
                path = TMP / sid / name
                with open(path, "wb") as f:
                    left = n
                    while left > 0:
                        chunk = self.rfile.read(min(4 << 20, left))
                        if not chunk:
                            break
                        f.write(chunk)
                        left -= len(chunk)
                dur = get_duration(find_ffmpeg(), str(path))
                SESS[sid] = dict(id=sid, path=str(path), name=name, dur=dur, size=os.path.getsize(path))
                return self.send_json({"id": sid, "duration": dur, "size": SESS[sid]["size"]})
            if u.path == "/api/generate-khmer-voice":
                j = json.loads(self.rfile.read(n) or b"{}")
                try:
                    return self.send_json({"ok": True, "url": khmer_tts(j.get("text"))})
                except ValueError as e:
                    return self.send_json({"error": str(e)}, 400)
                except Exception as e:
                    return self.send_json({"error": f"Khmer voice failed: {e}"}, 502)
            if u.path == "/api/prep":
                j = json.loads(self.rfile.read(n) or b"{}")
                s = SESS.get(j.get("id"))
                if not s:
                    return self.send_json({"error": "Upload the video again."}, 404)
                s["prep"] = dict(total=0, chunks=[], done=False, error=None)
                threading.Thread(target=prep_worker, args=(s, float(j.get("target") or 40), j.get("clean", True)), daemon=True).start()
                return self.send_json({"ok": True})
            if u.path == "/api/cut":
                j = json.loads(self.rfile.read(n) or b"{}")
                s = SESS.get(j.get("id"))
                if not s:
                    return self.send_json({"error": "Upload the video again."}, 404)
                base = os.path.splitext(s["name"])[0]
                folder = str(ROOT / (base + "_clips"))
                s.update(progress=0, done=False, error=None, clips=[], folder=folder)

                def work():
                    try:
                        cl = cut(s["path"], folder, j.get("seconds"), j.get("size_mb"), bool(j.get("precise")), False,
                                 progress=lambda x: s.__setitem__("progress", x), log=lambda m: None)
                        s["clips"] = cl
                        s["done"] = True
                    except Exception as e:
                        s["error"] = str(e)
                threading.Thread(target=work, daemon=True).start()
                return self.send_json({"ok": True, "folder": folder})
        except Exception as e:
            return self.send_json({"error": str(e)}, 500)
        self.send_json({"error": "not found"}, 404)


def serve():
    if not HTML_PATH.exists():
        sys.exit("index.html must be in the same folder as studio.py: " + str(HTML_PATH))
    port = 8765
    try:
        srv = ThreadingHTTPServer(("127.0.0.1", port), H)
    except OSError:
        srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
        port = srv.server_address[1]
    url = f"http://127.0.0.1:{port}/"
    print(f"Khmer Dubber Studio is running at {url}\nClips are saved in: {ROOT}\nPress Ctrl+C to stop.")
    try:
        find_ffmpeg()
    except Exception as e:
        print("WARNING:", e)
    threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


# ------------------------------------------------------------------ command line
def main():
    ap = argparse.ArgumentParser(description="Khmer Dubber Studio (local). No video = open the app.")
    ap.add_argument("video", nargs="?")
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--minutes", type=float)
    g.add_argument("--seconds", type=float)
    g.add_argument("--size", type=float, help="approximate MB per clip")
    ap.add_argument("--out")
    ap.add_argument("--start", type=float, default=0)
    ap.add_argument("--end", type=float)
    ap.add_argument("--precise", action="store_true", help="re-encode for exact lengths")
    ap.add_argument("--zip", action="store_true")
    a = ap.parse_args()
    if not a.video:
        return serve()
    secs = a.seconds or (a.minutes * 60 if a.minutes else None)
    if not secs and not a.size:
        ap.error("choose --minutes, --seconds or --size")
    try:
        cut(a.video, a.out, secs, a.size, a.precise, a.zip, a.start, a.end,
            lambda x: (sys.stdout.write(f"\r{x * 100:5.1f}%"), sys.stdout.flush()))
        print()
    except Exception as e:
        sys.exit("Error: " + str(e))


if __name__ == "__main__":
    main()
