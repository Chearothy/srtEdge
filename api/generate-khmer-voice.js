/* Vercel serverless function  ->  POST /api/generate-khmer-voice   body: { "text": "..." }
   Calls the Hugging Face Space (a Gradio app) over plain HTTP - no dependencies, no Python needed - and returns
     { ok: true, url: "data:audio/...;base64,..." }      (or the Space's own file URL when the clip is large)
   The page plays `url` in a hidden <audio> element, so nobody is redirected to another website.

   Optional environment variables (Vercel -> Settings -> Environment Variables):
     HF_TOKEN          Hugging Face token, only if the Space is private or rate-limited
     KHMER_TTS_SPACE   "owner/space-name" (default: muyleanging/VoxPocket-TTS-Demo)
     KHMER_TTS_API     endpoint name of the Space (default: predict)  */
const SPACE = process.env.KHMER_TTS_SPACE || 'muyleanging/VoxPocket-TTS-Demo';
const API = (process.env.KHMER_TTS_API || 'predict').replace(/^\//, '');
const TOKEN = process.env.HF_TOKEN || '';
const MAX_INLINE = parseInt(process.env.KHMER_MAX_INLINE || '', 10) || 3.2 * 1024 * 1024;   // Vercel response limit is 4.5 MB

const hdr = (extra = {}) => ({ ...(TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {}), ...extra });

async function http(url, opt = {}, ms = 50000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try { return await fetch(url, { ...opt, signal: c.signal }); } finally { clearTimeout(t); }
}

async function spaceHost() {
  if (process.env.KHMER_TTS_HOST) return process.env.KHMER_TTS_HOST.replace(/\/$/, '');
  if (/^https?:\/\//.test(SPACE)) return SPACE.replace(/\/$/, '');
  try {                                                         // the official address of the Space
    const r = await http('https://huggingface.co/api/spaces/' + SPACE, { headers: hdr() }, 8000);
    if (r.ok) { const j = await r.json(); if (j.host) return String(j.host).replace(/\/$/, ''); }
  } catch (e) { /* fall through */ }
  return 'https://' + SPACE.toLowerCase().replace(/[\/._]/g, '-') + '.hf.space';
}

async function findBase(host) {                                // Gradio 4 uses "", Gradio 5+ uses "/gradio_api"
  for (const prefix of ['/gradio_api', '']) {
    try {
      const r = await http(host + prefix + '/info', { headers: hdr() }, 12000);
      if (r.ok) return { prefix, info: await r.json() };
    } catch (e) { /* try the next one */ }
  }
  return { prefix: '/gradio_api', info: null };
}

function buildData(info, text) {                               // text goes to the text input, other inputs keep their defaults
  const ep = info && info.named_endpoints && info.named_endpoints['/' + API];
  if (!ep) return [text];
  const ps = ep.parameters || [];
  const isStr = p => /str/i.test(JSON.stringify(p.python_type || p.type || ''));
  let ti = ps.findIndex(p => isStr(p) && /text|prompt|input|sentence/i.test((p.label || '') + ' ' + (p.parameter_name || '')));
  if (ti < 0) ti = ps.findIndex(isStr);
  if (ti < 0) ti = 0;
  return ps.map((p, i) => (i === ti ? text : (p.parameter_has_default ? p.parameter_default : null)));
}

function findFile(x) {
  if (!x) return null;
  if (typeof x === 'string') return null;
  if (Array.isArray(x)) { for (const i of x) { const r = findFile(i); if (r) return r; } return null; }
  if (typeof x === 'object') {
    if (x.url) return { url: x.url };
    if (x.path) return { path: x.path };
    for (const k of Object.keys(x)) { const r = findFile(x[k]); if (r) return r; }
  }
  return null;
}

async function generate(text) {
  const host = await spaceHost();
  const { prefix, info } = await findBase(host);
  const submit = await http(host + prefix + '/call/' + API, {
    method: 'POST', headers: hdr({ 'Content-Type': 'application/json' }), body: JSON.stringify({ data: buildData(info, text) })
  }, 30000);
  let job = null;
  try { job = await submit.json(); } catch (e) { /* not JSON */ }
  if (!submit.ok || !job || !job.event_id)
    throw new Error('The Space is not answering (it may be sleeping or starting). Try again in a minute.');
  const stream = await http(host + prefix + '/call/' + API + '/' + job.event_id, { headers: hdr() }, 50000);
  const body = await stream.text();
  let out = null, err = null;
  for (const blk of body.split(/\r?\n\r?\n/)) {                // server-sent events: "event: complete" + "data: [...]"
    const ev = (blk.match(/^event:\s*(.+)$/m) || [])[1];
    const d = (blk.match(/^data:\s*(.*)$/m) || [])[1];
    if (ev === 'complete' && d) { try { out = JSON.parse(d); } catch (e) { /* ignore */ } }
    if (ev === 'error') err = d;
  }
  if (!out) throw new Error(err && err !== 'null' ? err : 'The Space reported an error (it may be busy). Try again.');
  const f = findFile(out);
  if (!f) throw new Error('The Space did not return an audio file.');
  let fileUrl;
  if (f.url) { const u = new URL(f.url, host); fileUrl = host + u.pathname + u.search; }      // always fetch through the Space's public address
  else fileUrl = host + prefix + '/file=' + f.path;
  const a = await http(fileUrl, { headers: hdr() }, 30000);
  if (!a.ok) throw new Error('Could not download the audio (' + a.status + ').');
  const buf = Buffer.from(await a.arrayBuffer());
  if (!buf.length) throw new Error('The Space returned an empty audio file.');
  if (buf.length > MAX_INLINE) return { url: fileUrl, bytes: buf.length };
  const ext = (fileUrl.split('?')[0].match(/\.(\w+)$/) || [])[1] || 'wav';
  const mime = (a.headers.get('content-type') || '').startsWith('audio/') ? a.headers.get('content-type').split(';')[0]
    : { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac' }[ext.toLowerCase()] || 'audio/wav';
  return { url: 'data:' + mime + ';base64,' + buf.toString('base64'), bytes: buf.length };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Use POST.' }); }
  let b = req.body;
  if (Buffer.isBuffer(b)) b = b.toString('utf8');
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  const text = String((b && b.text) || '').trim();
  if (!text) return res.status(400).json({ error: 'Type some Khmer text first.' });
  if (text.length > 1500) return res.status(400).json({ error: 'The text is too long (max 1500 characters).' });
  try {
    const r = await generate(text);
    return res.status(200).json({ ok: true, ...r });
  } catch (e) {
    const m0 = (e && e.message) || String(e);
    const msg = e && e.name === 'AbortError' ? 'The Space took too long (it may be waking up). Try again in a minute.'
      : /fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET/i.test(m0) ? 'Could not reach the Space. It may be sleeping or offline. Try again in a minute.' : m0;
    return res.status(502).json({ error: 'Khmer voice failed: ' + msg });
  }
};
