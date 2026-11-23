// Same-origin proxy for the public VoxPocket Gradio Space.
// Restrict the upstream host and paths; no arbitrary URL forwarding.
const UPSTREAM = "https://muyleanging-voxpocket-tts-demo.hf.space";

module.exports = async (req, res) => {
  const raw = (req.url || "").split("?")[0];
  const prefix = "/api/tts";
  if (!raw.startsWith(prefix)) {
    res.statusCode = 404; return res.end("Not found");
  }
  let path = raw.slice(prefix.length) || "/config";
  if (!path.startsWith("/")) path = "/" + path;
  if (path.includes("..") || path.includes("\\") || path.length > 2000) {
    res.statusCode = 400; return res.end("Invalid path");
  }
  // Only the Gradio config, queue calls/events and file downloads are needed.
  const allowed = path === "/config" || path === "/gradio_api/upload" ||
    /^\/gradio_api\/call\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)?$/.test(path) ||
    /^\/gradio_api\/file=/.test(path);
  if (!allowed) { res.statusCode = 404; return res.end("Unsupported upstream path"); }

  const url = UPSTREAM + path;
  const headers = {};
  for (const key of ["accept", "content-type"]) {
    if (req.headers[key]) headers[key] = req.headers[key];
  }
  try {
    const init = { method: req.method, headers };
    if (req.method !== "GET" && req.method !== "HEAD") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      init.body = Buffer.concat(chunks);
    }
    const upstream = await fetch(url, init);
    res.statusCode = upstream.status;
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    for (const key of ["content-type", "content-length", "content-disposition", "retry-after"]) {
      const value = upstream.headers.get(key);
      if (value) res.setHeader(key, value);
    }
    if (!upstream.body) return res.end();
    const reader = upstream.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(Buffer.from(value))) await new Promise(resolve => res.once("drain", resolve));
    }
    res.end();
  } catch (err) {
    if (!res.headersSent) { res.statusCode = 502; res.setHeader("Content-Type", "application/json"); }
    res.end(JSON.stringify({ error: "Khmer TTS upstream is temporarily unreachable.", detail: String(err && err.message || err).slice(0, 200) }));
  }
};
