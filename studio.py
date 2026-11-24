#!/usr/bin/env python3
"""
Khmer Dubber Studio - local runner. Same app as the website: it serves index.html (next to this file)
and adds native-ffmpeg Cut clip. Edit index.html once and both the website and this runner update.

  python studio.py                      open the full app (Dubber + Cut clip) in your browser
  python studio.py movie.mp4 --minutes 3   cut from the command line (no browser)
  python studio.py movie.mp4 --size 25 --zip | --seconds 90 | --precise | --start 30 --end 100

Cut clip runs with native ffmpeg: no size limit, no engine download, no API.
Needs Python 3.8+ and ffmpeg (https://ffmpeg.org  or:  pip install imageio-ffmpeg).
"""
import argparse, atexit, base64, json, math, os, re, shutil, socket, subprocess, sys, tempfile, threading, uuid, webbrowser, zipfile, zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, urlparse
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

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

    def proxy_tts(self, method, body=None):
        # Same-origin bridge for Gradio; avoids browser CORS / Edge restrictions.
        path = urlparse(self.path).path[len("/api/tts"):]
        if not path.startswith("/") or ".." in path or "\\" in path or len(path) > 2000:
            return self.send_json({"error": "Invalid TTS path"}, 400)
        allowed = (path == "/config" or path == "/gradio_api/upload" or
                   re.fullmatch(r"/gradio_api/call/[A-Za-z0-9_-]+(?:/[A-Za-z0-9_-]+)?", path) or
                   path.startswith("/gradio_api/file="))
        if not allowed:
            return self.send_json({"error": "Unsupported TTS path"}, 404)
        headers = {}
        for key in ("Content-Type", "Accept"):
            value = self.headers.get(key)
            if value: headers[key] = value
        request = Request("https://muyleanging-voxpocket-tts-demo.hf.space" + path,
                          data=body, headers=headers, method=method)
        try:
            upstream = urlopen(request, timeout=360)
            status, content_type = upstream.status, upstream.headers.get("Content-Type", "application/octet-stream")
            payload = upstream.read()
        except HTTPError as e:
            status, content_type, payload = e.code, e.headers.get("Content-Type", "text/plain"), e.read()
        except (URLError, TimeoutError) as e:
            return self.send_json({"error": "Khmer TTS upstream is temporarily unreachable", "detail": str(e)}, 502)
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        if urlparse(self.path).path.startswith("/api/tts/"):
            return self.proxy_tts("GET")
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
                return self.send_json({"ok": True, "ffmpeg": find_ffmpeg(), "folder": str(ROOT)})
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
        self.send_json({"error": "not found"}, 404)

    def do_POST(self):
        u = urlparse(self.path)
        n = int(self.headers.get("Content-Length") or 0)
        if u.path.startswith("/api/tts/"):
            body = self.rfile.read(n) if n else b""
            return self.proxy_tts("POST", body)
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
