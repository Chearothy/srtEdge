/* =====================================================================
 * Khmer TTS Studio — 100% client-side (no server, no build step)
 *
 *   • Bring-Your-Own-Token (BYOT) with automatic rotation on quota / 429
 *   • SRT → editable subtitle table (per-line voice, timing, audio status)
 *   • Sequential queue; long lines are split into ≤ 1400-character pieces
 *   • Merge all audio into one WAV (match subtitle timing or back-to-back)
 *
 * The Gradio client is imported from a CDN at runtime (see GRADIO_CDNS).
 * ===================================================================== */

/* ---------------------------------------------------------------------
 * 1. CONFIG
 * ------------------------------------------------------------------- */

// jsDelivr first (as requested); esm.sh is only a fallback if the first CDN fails.
// Tip: pin a version for production, e.g. ".../npm/@gradio/client@1.x.y/dist/index.min.js".
const GRADIO_CDNS = [
  'https://cdn.jsdelivr.net/npm/@gradio/client/dist/index.min.js',
  'https://esm.sh/@gradio/client'
];

const CFG = {
  DEFAULT_SPACE: 'muyleanging/VoxPocket-TTS-Demo',   // the Space this project already used; changeable in the UI (Advanced)
  ENDPOINT: '/predict',                   // app.predict("/predict", [chunkText, voice])
  VOICES: ['Man 1', 'Woman 1', 'Woman 2'],
  DEFAULT_VOICE: 'Man 1',
  MAX_CHUNK: 1400,                        // hard ceiling per chunk (API limit is 1500)
  TRANSIENT_RETRIES: 2                    // retries on the same token for flaky network errors
};

// The VoxPocket demo Space (muyleanging/VoxPocket-TTS-Demo) has no "/predict": it exposes
// "/pick_voice" + "/clone" instead. If the chosen Space looks like that, we use these.
const LEGACY = { pick: '/pick_voice', clone: '/clone', style: 'None (plain)', cfg: 2, steps: 10, seed: 0 };

/* ---------------------------------------------------------------------
 * 2. SMALL HELPERS
 * ------------------------------------------------------------------- */
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Length in Unicode code points (matches how Python counts characters on the server). */
const len = (s) => Array.from(s).length;

const store = {
  get(k) { try { return localStorage.getItem('ktts.' + k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem('ktts.' + k, v); } catch { /* storage blocked */ } },
  del(k) { try { localStorage.removeItem('ktts.' + k); } catch { /* ignore */ } }
};

function makeError(kind, message) { const e = new Error(message); e.kind = kind; return e; }

/* ---------------------------------------------------------------------
 * 3. SRT PARSER + TIME HELPERS
 * ------------------------------------------------------------------- */
const pad = (n, w) => String(n).padStart(w, '0');
const STAMPS_RE = /(\d{1,3}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,3}:\d{2}:\d{2}[,.]\d{1,3})/;

/** "00:01:02,345" | "01:02,345" | "62.345" | "62" → milliseconds, or null when invalid. */
function parseTime(str) {
  const s = String(str == null ? '' : str).trim();
  let m = /^(\d{1,3}):(\d{2}):(\d{2})(?:[,.](\d{1,3}))?$/.exec(s);
  if (m) return ((+m[1] * 60 + +m[2]) * 60 + +m[3]) * 1000 + (m[4] ? +m[4].padEnd(3, '0') : 0);
  m = /^(\d{1,3}):(\d{2})(?:[,.](\d{1,3}))?$/.exec(s);
  if (m) return (+m[1] * 60 + +m[2]) * 1000 + (m[3] ? +m[3].padEnd(3, '0') : 0);
  m = /^(\d+)(?:[,.](\d{1,3}))?$/.exec(s);
  if (m) return +m[1] * 1000 + (m[2] ? +m[2].padEnd(3, '0') : 0);
  return null;
}
/** milliseconds → "HH:MM:SS,mmm" ('' for null). */
function fmtTime(ms) {
  if (ms == null || Number.isNaN(ms)) return '';
  ms = Math.max(0, Math.round(ms));
  return pad(Math.floor(ms / 3600000), 2) + ':' + pad(Math.floor(ms / 60000) % 60, 2) + ':' +
    pad(Math.floor(ms / 1000) % 60, 2) + ',' + pad(ms % 1000, 3);
}

/** Returns [{start, end, text}] – one entry per cue. Numbers are dropped, timing is kept. */
function parseSrt(raw) {
  const text = String(raw).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const cues = [];
  for (const block of text.split(/\n{2,}/)) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    const t = lines.findIndex((l) => STAMPS_RE.test(l));
    let start = null, end = null, body;
    if (t >= 0) {
      const m = STAMPS_RE.exec(lines[t]);
      start = parseTime(m[1]); end = parseTime(m[2]);
      body = lines.slice(t + 1);
    } else body = lines.filter((l) => !/^\d+$/.test(l));      // malformed block: keep text only
    const cleaned = body
      .map((l) => l.replace(/<[^>]*>/g, '').replace(/\{\\[^}]*\}/g, '').replace(/\s+/g, ' ').trim())
      .filter(Boolean).join(' ');
    if (cleaned) cues.push({ start, end, text: cleaned });
  }
  return cues;
}

/* ---------------------------------------------------------------------
 * 4. CHUNKING  (every chunk ≤ max characters)
 * ------------------------------------------------------------------- */

/** Last resort for text with no sentence marks: split on spaces, then on grapheme clusters. */
function hardSplit(s, max) {
  const graphemes = (str) => (typeof Intl !== 'undefined' && Intl.Segmenter)
    ? Array.from(new Intl.Segmenter('km', { granularity: 'grapheme' }).segment(str), (x) => x.segment)
    : Array.from(str);
  const out = [];
  let cur = '';
  for (const w of s.split(' ')) {
    let word = w;
    while (len(word) > max) {                      // a single "word" longer than max
      if (cur) { out.push(cur); cur = ''; }
      let piece = '', n = 0;
      const rest = [];
      for (const g of graphemes(word)) {
        const gl = len(g);
        if (rest.length === 0 && n + gl <= max) { piece += g; n += gl; } else rest.push(g);
      }
      out.push(piece);
      word = rest.join('');
    }
    if (!word) continue;
    if (!cur) cur = word;
    else if (len(cur) + 1 + len(word) <= max) cur += ' ' + word;
    else { out.push(cur); cur = word; }
  }
  if (cur) out.push(cur);
  return out;
}

/** Split one over-long line at sentence marks (។ ៕ . ! ?) and re-pack into pieces ≤ max. */
function splitLong(line, max) {
  const sentences = line.match(/[^។៕!?.]+[។៕!?.]*\s*/g) || [line];
  const out = [];
  let cur = '';
  for (let s of sentences) {
    s = s.trim();
    if (!s) continue;
    if (len(s) > max) {
      if (cur) { out.push(cur); cur = ''; }
      out.push(...hardSplit(s, max));
    } else if (!cur) cur = s;
    else if (len(cur) + 1 + len(s) <= max) cur += ' ' + s;
    else { out.push(cur); cur = s; }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Combines text lines (one per line / subtitle cue) into chunks.
 * Guarantee: len(chunk) <= max for every chunk.
 */
function chunkText(text, max = CFG.MAX_CHUNK) {
  const units = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (!line) continue;
    if (len(line) <= max) units.push(line); else units.push(...splitLong(line, max));
  }
  const chunks = [];
  let cur = '', curLen = 0;
  for (const u of units) {
    const ul = len(u);
    if (!cur) { cur = u; curLen = ul; }
    else if (curLen + 1 + ul <= max) { cur += ' ' + u; curLen += 1 + ul; }
    else { chunks.push(cur); cur = u; curLen = ul; }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/* ---------------------------------------------------------------------
 * 5. TOKENS (localStorage) + ERROR CLASSIFICATION
 * ------------------------------------------------------------------- */
function parseTokens(raw) {
  const seen = new Set(), valid = [];
  let ignored = 0;
  for (const line of String(raw).split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (!/^hf_\S{8,}$/.test(t)) { ignored++; continue; }
    if (!seen.has(t)) { seen.add(t); valid.push(t); }
  }
  return { valid, ignored };
}

/** Gradio can throw Error objects, status objects ({stage:"error", message}) or plain strings. */
function errText(e) {
  if (e == null) return '';
  if (typeof e === 'string') return e;
  const parts = [e.message, e.title, e.detail, e.error, e.status, e.code, e.http_status, e.http_status_code]
    .filter((x) => x != null && x !== '');
  if (parts.length) return parts.join(' | ');
  try { return JSON.stringify(e); } catch { return String(e); }
}

/**
 * 'quota'     → this token is out of GPU quota / rate-limited (429)      → rotate
 * 'auth'      → token rejected (401/403/invalid)                          → rotate
 * 'transient' → network hiccup / queue full / 5xx                          → retry
 * 'fatal'     → anything else                                               → stop and show
 */
function classifyError(e) {
  if (e && e.kind === 'cancelled') return 'cancelled';
  if (e && e.kind) return 'fatal';             // our own errors (cdn, api, remote…)
  const m = errText(e);
  if (/\b429\b|quota|rate.?limit|too many requests|exceeded|zerogpu|gpu (limit|usage)|limit reached|sign-?in required|create a free account/i.test(m)) return 'quota';
  if (/\b40[13]\b|unauthori[sz]ed|forbidden|invalid (user )?token|invalid credentials|token (is )?(invalid|expired)/i.test(m)) return 'auth';
  if (/\b50[234]\b|queue (is )?full|busy|timed? ?out|network|failed to fetch|load failed|abort|connection|could not (connect|get)|starting|sleeping|overloaded/i.test(m)) return 'transient';
  return 'fatal';
}

/* ---------------------------------------------------------------------
 * 6. GRADIO CLIENT (CDN, lazy) + PER-TOKEN SESSIONS
 * ------------------------------------------------------------------- */
let GradioMod = null;
async function loadGradio() {
  if (GradioMod) return GradioMod;
  let last;
  for (const url of GRADIO_CDNS) {
    try { GradioMod = await import(url); return GradioMod; }
    catch (e) { last = e; console.warn('[khmer-tts] CDN failed:', url, e); }
  }
  throw makeError('cdn', 'Could not load the Gradio client from the CDN. Check your internet connection or ad-blocker. ' + errText(last));
}

async function connectSpace(space, token) {
  const G = await loadGradio();
  const opts = token ? { hf_token: token } : {};
  if (G.Client && typeof G.Client.connect === 'function') return G.Client.connect(space, opts);   // current API
  if (typeof G.client === 'function') return G.client(space, opts);                               // older API
  throw makeError('cdn', 'The loaded Gradio client has an unexpected shape (no Client / client export).');
}

/** Decide which API shape the Space offers: '/predict' (as specified) or the older pick_voice+clone pair. */
async function detectMode(app) {
  let named = null;
  try {
    const info = await app.view_api();
    named = Object.keys((info && info.named_endpoints) || {}).map((k) => k.replace(/^\//, ''));
  } catch { return 'predict'; }                   // can't introspect → just try /predict
  const want = CFG.ENDPOINT.replace(/^\//, '');
  if (named.includes(want)) return 'predict';
  if (named.includes('clone') && named.includes('pick_voice')) return 'legacy';
  throw makeError('api', 'This Space does not expose "' + CFG.ENDPOINT + '". Endpoints found: ' + (named.join(', ') || 'none') + '. Check the Space name under Advanced.');
}

/** Extracts the audio URL from a Gradio file output. */
function fileUrl(d) {
  if (!d) return null;
  if (typeof d === 'string') return d;
  return d.url || null;
}

/** One TTS call for one chunk on one connected session. Returns the audio URL. */
async function callTTS(session, text, voice) {
  let first;
  if (session.mode === 'predict') {
    const r = await session.app.predict(CFG.ENDPOINT, [text, voice]);
    first = r && r.data && r.data[0];
  } else {
    let sample = session.samples.get(voice);
    if (!sample) {
      const p = await session.app.predict(LEGACY.pick, [voice]);
      sample = { fd: p.data[0], text: p.data[1] == null ? '' : String(p.data[1]) };
      session.samples.set(voice, sample);
    }
    const r = await session.app.predict(LEGACY.clone,
      [text, LEGACY.style, sample.fd, sample.text, LEGACY.cfg, LEGACY.steps, LEGACY.seed]);
    first = r && r.data && r.data[0];
  }
  const url = fileUrl(first);
  if (!url) throw makeError('remote', 'The Space finished but returned no audio file.');
  return url;
}

/* ---------------------------------------------------------------------
 * 7. STATE
 * ------------------------------------------------------------------- */
const state = {
  rows: [],              // subtitle lines (see newRow)
  tokens: [],            // saved valid tokens
  pool: [null],          // tokens used for the current run (null = anonymous)
  cur: 0,                // pool index currently in use
  dead: new Set(),       // pool indexes exhausted / rejected in this run
  sessions: new Map(),   // pool index → { app, mode, samples }
  space: CFG.DEFAULT_SPACE,
  busy: false,
  cancelled: false,
  cancelReject: null,
  undo: [],
  playingId: null,
  edgeId: null,          // line currently read / recorded with the Edge voice
  query: '',
  timer: null
};
let uid = 0;
const defaultVoice = () => $('voice').value || CFG.DEFAULT_VOICE;

/** One subtitle line. start/end are milliseconds (or null for plain text). */
function newRow(o) {
  return Object.assign({
    id: ++uid, start: null, end: null, text: '', voice: defaultVoice(), edgeVoice: 'Piseth', sel: false,
    status: 'none',          // none | queued | working | done | failed
    error: '', url: '', blob: null, blobUrl: '', ext: 'wav', audioDur: null, tokenIdx: null, stale: false
  }, o || {});
}
const hasAudio = (r) => !!(r.blobUrl || r.url);
const rowById = (id) => state.rows.find((r) => r.id === id);
const tokenLabel = (i) => (state.pool[i] ? 'Token #' + (i + 1) : 'no token (anonymous)');

function clearAudio(r) {
  if (state.playingId === r.id) { player.pause(); state.playingId = null; }
  Object.assign(r, { status: 'none', error: '', url: '', blob: null, blobUrl: '', audioDur: null, stale: false, tokenIdx: null });
}

/* ---- undo ---- */
const snapshot = () => state.rows.map((r) => Object.assign({}, r));
function pushUndo(snap) {
  state.undo.push(snap || snapshot());
  if (state.undo.length > 40) state.undo.shift();
  refreshMeta();
}
function undo() {
  const s = state.undo.pop();
  if (!s) return;
  player.pause(); state.playingId = null;
  state.rows = s; renderAll(); toast('Undone');
}

/* ---- gradio sessions + token rotation (unchanged logic) ---- */
async function getSession(idx) {
  let s = state.sessions.get(idx);
  if (s) return s;
  const app = await connectSpace(state.space, state.pool[idx]);
  s = { app, mode: await detectMode(app), samples: new Map() };
  state.sessions.set(idx, s);
  return s;
}
function nextAliveToken() {
  const n = state.pool.length;
  for (let k = 0; k < n; k++) {
    const i = (state.cur + k) % n;
    if (!state.dead.has(i)) { state.cur = i; return i; }
  }
  return -1;
}
/** Races a promise against the Cancel button (Gradio's predict() itself can't be aborted). */
function cancellable(promise) {
  return Promise.race([
    promise,
    new Promise((_, reject) => { state.cancelReject = () => reject(makeError('cancelled', 'Cancelled.')); })
  ]);
}
/**
 * Synthesises ONE piece of text. If the current token hits quota/429 (or is rejected) it is marked
 * exhausted, the next token is selected and the SAME text is retried automatically.
 * Throws {kind:'exhausted'} when every token is exhausted.
 */
async function synthesizeWithRotation(text, voice, onToken) {
  let transient = 0;
  for (;;) {
    if (state.cancelled) throw makeError('cancelled', 'Cancelled.');
    const idx = nextAliveToken();
    if (idx === -1) throw makeError('exhausted', '');
    onToken(idx);
    try {
      const session = await cancellable(getSession(idx));
      const url = await cancellable(callTTS(session, text, voice));
      return { url, idx };
    } catch (e) {
      const kind = classifyError(e);
      if (kind === 'cancelled') throw e;
      state.sessions.delete(idx);
      if (kind === 'quota' || kind === 'auth') {
        state.dead.add(idx);
        console.warn('[khmer-tts] ' + tokenLabel(idx) + ' → ' + kind + ':', errText(e));
        if (state.pool.length - state.dead.size > 0)
          setNote(tokenLabel(idx) + (kind === 'quota' ? ' hit its quota' : ' was rejected') + ' → switching to the next token…');
        continue;
      }
      if (kind === 'transient' && transient < CFG.TRANSIENT_RETRIES) {
        transient++;
        setNote('Temporary problem (' + errText(e).slice(0, 80) + '). Retrying…');
        await sleep(1500 * transient);
        continue;
      }
      throw e;
    }
  }
}

/* ---------------------------------------------------------------------
 * 8. AUDIO UTILITIES (decode, join, WAV encode, download)
 * ------------------------------------------------------------------- */
let audioCtx = null;
function getCtx() {
  if (audioCtx) return audioCtx;
  const C = window.AudioContext || window.webkitAudioContext;
  if (!C) throw makeError('audio', 'This browser cannot decode audio.');
  try { audioCtx = new C({ sampleRate: 24000 }); } catch { audioCtx = new C(); }   // 24 kHz keeps long merges small
  return audioCtx;
}
function decodeBlob(blob) {
  return blob.arrayBuffer().then((ab) => new Promise((res, rej) => getCtx().decodeAudioData(ab, res, rej)));
}
async function fetchBlob(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  const b = await resp.blob();
  if (b.size < 512) throw new Error('empty audio file');
  return /^audio\//i.test(b.type) ? b : new Blob([b], { type: 'audio/wav' });
}
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'voice';
function extFromBlob(blob, url) {
  const map = { 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/ogg': 'ogg', 'audio/flac': 'flac', 'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/aac': 'aac' };
  const t = (blob && blob.type || '').toLowerCase();
  if (map[t]) return map[t];
  const m = /\.([a-z0-9]{2,5})(?:$|[?#])/i.exec(url || '');
  return m && /^(wav|mp3|ogg|flac|webm|aac|m4a)$/i.test(m[1]) ? m[1].toLowerCase() : 'wav';
}
function probeDuration(src) {
  return new Promise((resolve) => {
    const a = new Audio();
    a.preload = 'metadata';
    const done = (v) => { clearTimeout(t); a.removeAttribute('src'); resolve(v); };
    const t = setTimeout(() => done(null), 6000);
    a.onloadedmetadata = () => done(isFinite(a.duration) && a.duration > 0 ? a.duration : null);
    a.onerror = () => done(null);
    a.src = src;
  });
}
async function audioDurationOf(blob, src) {
  const d = await probeDuration(src);
  if (d) return d;
  if (blob) { try { return (await decodeBlob(blob)).duration; } catch { /* ignore */ } }
  return null;
}
function wavHeader(samples, sr) {
  const b = new ArrayBuffer(44), v = new DataView(b);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + samples * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, samples * 2, true);
  return b;
}
/** items: [{buf: AudioBuffer, at: seconds}] (non-overlapping) → mono 16-bit WAV Blob. */
function mixToWav(items) {
  const sr = items[0].buf.sampleRate;
  let end = 0;
  items.forEach((i) => { end = Math.max(end, i.at + i.buf.duration); });
  const pcm = new Int16Array(Math.ceil(end * sr) + 1);
  for (const { buf, at } of items) {
    const off = Math.round(at * sr), n = buf.numberOfChannels, chans = [];
    for (let c = 0; c < n; c++) chans.push(buf.getChannelData(c));
    const L = Math.min(buf.length, pcm.length - off);
    for (let i = 0; i < L; i++) {
      let s = 0;
      for (let c = 0; c < n; c++) s += chans[c][i];
      s /= n;
      pcm[off + i] = s < 0 ? Math.max(-1, s) * 0x8000 : Math.min(1, s) * 0x7fff;
    }
  }
  return new Blob([wavHeader(pcm.length, sr), pcm], { type: 'audio/wav' });
}
function downloadBlob(blob, name) {
  const u = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = u; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(u), 60000);
}

/* ---------------------------------------------------------------------
 * 9. UI HELPERS
 * ------------------------------------------------------------------- */
let toastT = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2800);
}
function setPill(s, text) { $('spacePill').dataset.state = s; $('spaceTxt').textContent = text; }
function showError(msg, link) {
  const el = $('err');
  el.textContent = '';
  const span = document.createElement('span'); span.textContent = msg; el.appendChild(span);
  if (link) {
    const a = document.createElement('a');
    a.href = 'https://huggingface.co/spaces/' + state.space; a.target = '_blank'; a.rel = 'noopener';
    a.textContent = ' Open the Space ↗'; el.appendChild(a);
  }
  el.hidden = false;
}
function clearError() { const el = $('err'); el.hidden = true; el.textContent = ''; }
function setNote(t) { $('progNote').textContent = t || ''; }
function setProgress(done, total, partial) {
  const pct = total ? Math.min(100, ((done + (partial || 0)) / total) * 100) : 0;
  $('bar').style.setProperty('--w', pct + '%');
}

/* ---- tokens UI ---- */
function renderTokenStatus(extra) {
  const n = state.tokens.length;
  $('setSum').replaceChildren('⚙ Tokens & voice', mk('span', 'sumtxt', { textContent: n ? n + ' token' + (n > 1 ? 's' : '') + ' · ' + defaultVoice() : 'no token yet' }));
  $('tokCount').textContent = n + ' saved';
  const note = $('tokNote');
  note.className = 'note' + (n ? ' ok' : '');
  note.textContent = (n
    ? n + ' token' + (n > 1 ? 's' : '') + ' ready. If one runs out of quota the app switches to the next automatically.'
    : 'No token: the free anonymous GPU quota is small. Add tokens for more.') + (extra ? ' ' + extra : '');
}
function saveTokens() {
  const { valid, ignored } = parseTokens($('tokens').value);
  state.tokens = valid;
  if (valid.length) store.set('tokens', valid.join('\n')); else store.del('tokens');
  $('tokens').value = valid.join('\n');
  state.sessions.clear();
  renderTokenStatus(ignored ? '(' + ignored + ' invalid line' + (ignored > 1 ? 's' : '') + ' ignored: tokens start with "hf_")' : '');
  if (ignored) $('tokNote').className = 'note warn';
}
$('tokSave').onclick = saveTokens;
$('tokClear').onclick = () => { $('tokens').value = ''; saveTokens(); };
$('tokToggle').onclick = () => {
  const masked = $('tokens').classList.toggle('masked');
  $('tokToggle').textContent = masked ? '👁 Show' : '🙈 Hide';
};

/* ---------------------------------------------------------------------
 * 10. TABLE RENDERING
 * ------------------------------------------------------------------- */
const els = new Map();                       // row id → DOM element
const player = new Audio();                  // one shared player: only one line plays at a time
player.preload = 'auto';

function mk(tag, cls, props) { const e = document.createElement(tag); if (cls) e.className = cls; if (props) Object.assign(e, props); return e; }
function iconBtn(act, icon, title, extra) {
  const b = mk('button', 'ib ' + (extra || ''), { type: 'button', textContent: icon, title });
  b.dataset.act = act; b.setAttribute('aria-label', title);
  return b;
}
function timeCell(label, cls) {
  const w = mk('label', 'c-time ' + (label === 'Start' ? 't-start' : 't-end'));
  w.append(mk('span', 'lbl', { textContent: label }));
  const i = mk('input', 'ed inp tin ' + cls, { type: 'text', placeholder: '00:00:00,000', spellcheck: false, autocomplete: 'off' });
  i.setAttribute('inputmode', 'decimal'); i.setAttribute('aria-label', label + ' time');
  w.append(i);
  return w;
}

function buildRow(r) {
  const row = mk('div', 'srow'); row.dataset.id = r.id; row.setAttribute('role', 'listitem');

  const head = mk('div', 'rhead');
  const sel = mk('label', 'c-sel');
  const cb = mk('input', 'ed f-sel', { type: 'checkbox', checked: !!r.sel }); cb.setAttribute('aria-label', 'Select line');
  sel.append(cb);
  head.append(sel, mk('span', 'c-num'), timeCell('Start', 'f-start'), timeCell('End', 'f-end'), mk('span', 'c-dur'));

  const tw = mk('div', 'c-text');
  const ta = mk('textarea', 'ed f-text khmer', { rows: 2, spellcheck: false, value: r.text });
  ta.lang = 'km'; ta.setAttribute('aria-label', 'Subtitle text');
  tw.append(ta);

  const meta = mk('div', 'rmeta');
  const vw = mk('div', 'c-voice');
  const vs = mk('select', 'ed f-voice'); vs.setAttribute('aria-label', 'Voice');
  CFG.VOICES.forEach((v) => vs.append(mk('option', '', { value: v, textContent: v })));
  vs.value = r.voice;
  vw.append(vs);
  const ew = mk('div', 'c-voice c-edgev edge-only');
  const es = mk('select', 'f-edgevoice'); es.setAttribute('aria-label', 'Edge voice (Piseth / Sreymom)');
  ['Piseth', 'Sreymom'].forEach((n) => es.append(mk('option', '', { value: n, textContent: n })));
  es.value = r.edgeVoice || 'Piseth';
  ew.append(es);
  const act = mk('div', 'c-act');
  const ep = iconBtn('edgeplay', '🔊', 'Play with Edge voice (Piseth / Sreymom)');
  ep.classList.add('edge-only');
  act.append(
    ep, iconBtn('play', '▶', 'Play'), iconBtn('regen', '↻', 'Generate / regenerate', 'ed'),
    iconBtn('dl', '⬇', 'Download this line'), iconBtn('dup', '⧉', 'Duplicate line', 'ed'),
    iconBtn('cut', '✂', 'Split at cursor', 'ed'), iconBtn('del', '🗑', 'Delete line', 'ed del')
  );
  meta.append(vw, ew, mk('div', 'c-status'), act);

  row.append(head, tw, meta);
  row.querySelector('.f-start').value = fmtTime(r.start);
  row.querySelector('.f-end').value = fmtTime(r.end);
  return row;
}

/** Refreshes the dynamic parts of one row (duration, status, buttons, highlight). */
function updateRow(r) {
  const e = els.get(r.id);
  if (!e) return;
  e.classList.toggle('sel', !!r.sel);
  const playing = state.playingId === r.id && !player.paused;
  e.classList.toggle('playing', state.playingId === r.id || state.edgeId === r.id);

  const slot = (r.start != null && r.end != null) ? (r.end - r.start) / 1000 : null;
  const d = e.querySelector('.c-dur');
  d.textContent = slot == null ? '—' : slot.toFixed(2) + 's';
  d.classList.toggle('over', slot != null && r.audioDur != null && r.audioDur > slot + 0.05);
  d.title = r.audioDur != null ? 'Audio length: ' + r.audioDur.toFixed(2) + 's' + (d.classList.contains('over') ? ' (longer than the slot)' : '') : '';

  const s = e.querySelector('.c-status');
  s.className = 'c-status ' + r.status;
  s.replaceChildren(); s.title = '';
  if (r.status === 'none') s.textContent = '— no audio';
  else if (r.status === 'queued') s.textContent = '⏳ queued';
  else if (r.status === 'working') s.textContent = '⚙ generating… ' + (r.tokenIdx != null ? tokenLabel(r.tokenIdx) : '');
  else if (r.status === 'failed') { s.textContent = '✗ ' + (r.error || 'failed'); s.title = r.error || ''; }
  else {
    s.append('✓ ' + (r.audioDur != null ? r.audioDur.toFixed(2) + 's' : 'ready'));
    if (r.stale) { s.append(' · '); s.append(mk('span', 'stale', { textContent: 'outdated' })); s.title = 'Text or voice changed after this audio was made'; }
  }
  const ok = hasAudio(r);
  const play = e.querySelector('[data-act=play]'), dl = e.querySelector('[data-act=dl]');
  play.disabled = !ok; dl.disabled = !ok;
  play.textContent = playing ? '⏸' : '▶'; play.title = playing ? 'Pause' : 'Play';
  e.querySelector('[data-act=regen]').title = ok ? 'Regenerate this line' : 'Generate this line';
  const ep = e.querySelector('[data-act=edgeplay]');
  if (ep) {
    const on = edge.rowId === r.id;
    ep.disabled = !edge.ok;
    ep.textContent = on ? '⏹' : '🔊';
    ep.title = on ? 'Stop' : 'Play with Edge voice (' + (r.edgeVoice || 'Piseth') + ')';
  }
}

function renderAll() {
  const frag = document.createDocumentFragment();
  els.clear();
  state.rows.forEach((r, i) => {
    const e = buildRow(r);
    e.querySelector('.c-num').textContent = i + 1;
    els.set(r.id, e); frag.append(e);
  });
  $('rows').replaceChildren(frag);
  state.rows.forEach(updateRow);
  applyBusy(); applyFilter(); refreshMeta(); scheduleSave();
}

function applyFilter() {
  const q = state.query.trim().toLowerCase();
  state.rows.forEach((r, i) => {
    const e = els.get(r.id);
    if (e) e.hidden = !!q && !(r.text.toLowerCase().includes(q) || String(i + 1) === q);
  });
}

/** Counts, enabled/disabled buttons, select-all state, merge summary. */
function refreshMeta() {
  const rows = state.rows, b = state.busy;
  const withAudio = rows.filter(hasAudio).length;
  const nSel = rows.filter((r) => r.sel).length;
  const failed = rows.filter((r) => r.status === 'failed').length;
  const todo = rows.filter((r) => r.text.trim() && (r.status !== 'done' || r.stale)).length;
  $('counts').textContent = rows.length + ' subtitle(s) · ' + withAudio + ' with audio' + (nSel ? ' · ' + nSel + ' selected' : '');
  $('emptyMsg').hidden = rows.length > 0;
  const dis = (id, v) => { $(id).disabled = b || v; };
  dis('genSel', nSel === 0); dis('genAll', todo === 0); dis('retry', failed === 0);
  dis('addRow', false); dis('mergeSel', nSel < 2); dis('sortTime', rows.length < 2);
  dis('extend', withAudio === 0); dis('importMore', false); dis('clearAll', rows.length === 0);
  $('undo').disabled = b || state.undo.length === 0;
  dis('applyVoice', rows.length === 0);
  $('mergeBtn').disabled = b || withAudio === 0;
  $('exportSrt').disabled = rows.length === 0;
  $('edgePrev').disabled = b || !edge.ok;                  // stays clickable with nothing ticked so it can say “select some lines”
  $('selCount').textContent = 'Selected: ' + nSel + ' / ' + rows.length;
  $('selCount').classList.toggle('has', nSel > 0);
  $('selAllBtn').disabled = b || rows.length === 0 || nSel === rows.length;
  $('unselAllBtn').disabled = b || nSel === 0;
  $('edgeAll').disabled = b || !edge.ok || !rows.some((r) => r.text.trim());
  $('edgeSel').disabled = b || !edge.ok || nSel === 0;
  const all = $('selAll');
  all.checked = rows.length > 0 && nSel === rows.length;
  all.indeterminate = nSel > 0 && nSel < rows.length;
  $('mergeSum').textContent = withAudio
    ? withAudio + ' of ' + rows.length + ' lines have audio and will be merged in table order.'
    : 'Generate some lines first, then merge them into a single audio file.';
}

/** While generating, structural edits are locked (play / download / cancel / search stay usable). */
function applyBusy() {
  const b = state.busy;
  document.querySelectorAll('#rows .ed').forEach((e) => { e.inert = b; });
  ['settings', 'importCard'].forEach((id) => { $(id).inert = b; });
  $('outCard').querySelectorAll('select,input').forEach((e) => { e.disabled = b; });
}

/* ---- persistence of the table (text / timing / voice; audio is not stored) ---- */
let saveT = null;
function scheduleSave() {
  clearTimeout(saveT);
  saveT = setTimeout(() => {
    if (!state.rows.length) { store.del('rows'); return; }
    store.set('rows', JSON.stringify(state.rows.map((r) => ({ s: r.start, e: r.end, t: r.text, v: r.voice, ev: r.edgeVoice }))));
  }, 600);
}
function restoreRows() {
  try {
    const arr = JSON.parse(store.get('rows') || '[]');
    if (Array.isArray(arr) && arr.length) {
      state.rows = arr.map((x) => newRow({ start: x.s, end: x.e, text: String(x.t || ''), voice: CFG.VOICES.includes(x.v) ? x.v : defaultVoice(), edgeVoice: x.ev === 'Sreymom' ? 'Sreymom' : 'Piseth' }));
      toast('Restored ' + state.rows.length + ' lines (audio has to be generated again)');
    }
  } catch { /* ignore corrupt data */ }
}

/* ---------------------------------------------------------------------
 * 11. TABLE EDITING OPERATIONS
 * ------------------------------------------------------------------- */
const growTa = (ta) => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight + 2, 240) + 'px'; };

/** Asks what to do with the lines already in the table → 'replace' | 'append' | 'cancel'. */
function askClear() {
  const n = state.rows.length;
  if (!n) return Promise.resolve('append');                // empty table: nothing to ask
  const audio = state.rows.filter(hasAudio).length;
  $('mText').textContent = 'The table already has ' + n + ' line' + (n > 1 ? 's' : '') +
    (audio ? ' (' + audio + ' with audio)' : '') + '. Do you want to clear them first?';
  const m = $('modal');
  m.hidden = false;
  $('mClear').focus();
  return new Promise((resolve) => {
    const finish = (v) => { m.hidden = true; document.removeEventListener('keydown', onKey); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') finish('cancel'); };
    document.addEventListener('keydown', onKey);
    $('mClear').onclick = () => finish('replace');
    $('mKeep').onclick = () => finish('append');
    $('mCancel').onclick = () => finish('cancel');
    m.onclick = (e) => { if (e.target === m) finish('cancel'); };
  });
}
/** Puts new rows into the table, either replacing everything or appending. (Undo keeps the old table.) */
function placeRows(rows, mode) {
  pushUndo();
  if (mode === 'replace') { player.pause(); state.playingId = null; state.rows = rows; }
  else state.rows = state.rows.concat(rows);
  renderAll();
}

function loadSrtFile(file, append) {
  clearError();
  if (!file) return;
  if (!/\.srt$/i.test(file.name)) { showError('Please choose a .srt subtitle file.'); return; }
  if (file.size > 10 * 1024 * 1024) { showError('That file is larger than 10 MB. Please use a smaller .srt file.'); return; }
  const reader = new FileReader();
  reader.onerror = () => showError('Could not read the file. Please try again.');
  reader.onload = async () => {
    const cues = parseSrt(reader.result);
    if (!cues.length) { showError('No subtitle text was found in this file. Is it a valid .srt?'); return; }
    // "Import another SRT…" always appends; the main upload asks when the table already has lines
    const mode = append ? 'append' : await askClear();
    if (mode === 'cancel') { toast('Upload cancelled. Your table was not changed.'); return; }
    placeRows(cues.map((c) => newRow({ start: c.start, end: c.end, text: c.text })), mode);
    $('srtInfo').textContent = file.name + ' · ' + cues.length + ' subtitles ' + (mode === 'append' && state.rows.length > cues.length ? 'added' : 'loaded');
    toast(cues.length + ' subtitles ' + (mode === 'append' && state.rows.length > cues.length ? 'added' : 'loaded'));
  };
  reader.readAsText(file, 'utf-8');
}

async function addLines(lines) {
  const clean = lines.map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (!clean.length) { toast('Nothing to add.'); return false; }
  const mode = await askClear();
  if (mode === 'cancel') return false;
  placeRows(clean.map((t) => newRow({ text: t })), mode);
  toast(clean.length + ' line' + (clean.length > 1 ? 's' : '') + (mode === 'replace' ? ' loaded' : ' added'));
  return true;
}

/**
 * Plain text → timed subtitles. One line = one subtitle; the duration is estimated from the
 * text length (≈ 12 characters per second, min 1.5 s, max 10 s) with a 0.2 s gap, starting
 * after the last line already in the table (or at 00:00:00,000). Use “Export SRT” to save it.
 */
async function textToSrt(lines) {
  const clean = lines.map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (!clean.length) { toast('Nothing to convert. Paste some text first.'); return false; }
  const mode = await askClear();
  if (mode === 'cancel') return false;
  const last = mode === 'append' && state.rows.length ? state.rows[state.rows.length - 1] : null;
  let t = last && last.end != null ? last.end + 200 : 0;
  const rows = clean.map((text) => {
    const dur = Math.min(10000, Math.max(1500, len(text) * 80));
    const r = newRow({ text, start: t, end: t + dur });
    t += dur + 200;
    return r;
  });
  placeRows(rows, mode);
  toast(rows.length + ' line' + (rows.length > 1 ? 's' : '') + ' converted to timed subtitles · use "Export SRT" to save');
  return true;
}

function addRow() {
  pushUndo();
  let at = state.rows.length;
  for (let i = state.rows.length - 1; i >= 0; i--) if (state.rows[i].sel) { at = i + 1; break; }
  const prev = state.rows[at - 1];
  const start = prev && prev.end != null ? prev.end : null;
  const r = newRow({ start, end: start != null ? start + 2000 : null });
  state.rows.splice(at, 0, r);
  renderAll();
  const e = els.get(r.id);
  if (e) { e.scrollIntoView({ block: 'center', behavior: 'smooth' }); e.querySelector('.f-text').focus({ preventScroll: true }); }
}

function mergeSelected() {
  const sel = state.rows.filter((r) => r.sel);
  if (sel.length < 2) return;
  pushUndo();
  const first = sel[0];
  const starts = sel.map((r) => r.start).filter((x) => x != null), ends = sel.map((r) => r.end).filter((x) => x != null);
  first.text = sel.map((r) => r.text.trim()).filter(Boolean).join(' ');
  first.start = starts.length ? Math.min(...starts) : null;
  first.end = ends.length ? Math.max(...ends) : null;
  clearAudio(first); first.sel = false;
  const drop = new Set(sel.slice(1).map((r) => r.id));
  state.rows = state.rows.filter((r) => !drop.has(r.id));
  renderAll(); toast(sel.length + ' lines merged into one');
}

function sortByTime() {
  pushUndo();
  state.rows = state.rows.map((r, i) => ({ r, i }))
    .sort((a, b) => ((a.r.start == null) - (b.r.start == null)) || ((a.r.start || 0) - (b.r.start || 0)) || (a.i - b.i))
    .map((x) => x.r);
  renderAll(); toast('Sorted by start time');
}

function extendEnds() {
  const hit = state.rows.filter((r) => r.start != null && r.audioDur != null && r.end != null && r.audioDur * 1000 > (r.end - r.start) + 50);
  if (!hit.length) { toast('Every line already fits its audio.'); return; }
  pushUndo();
  hit.forEach((r) => { r.end = r.start + Math.ceil(r.audioDur * 1000); });
  renderAll();
  toast(hit.length + ' end time' + (hit.length > 1 ? 's' : '') + ' extended. “Match timing” merge shifts clips that would overlap.');
}

function splitRow(r) {
  const e = els.get(r.id), ta = e && e.querySelector('.f-text');
  const text = r.text, L = text.length;
  let pos = ta ? ta.selectionStart : 0;
  if (!(pos > 0 && pos < L)) {                              // no cursor inside the text → split near the middle
    pos = Math.floor(L / 2);
    const nx = text.indexOf(' ', pos), pv = text.lastIndexOf(' ', pos);
    pos = nx >= 0 && (pv <= 0 || nx - pos <= pos - pv) ? nx : (pv > 0 ? pv : pos);
  }
  const a = text.slice(0, pos).trim(), b = text.slice(pos).trim();
  if (!a || !b) { toast('Put the cursor inside the text, then press ✂.'); return; }
  pushUndo();
  const second = newRow({ text: b, voice: r.voice, edgeVoice: r.edgeVoice, start: null, end: r.end });
  if (r.start != null && r.end != null) {
    const mid = r.start + Math.round((r.end - r.start) * (a.length / (a.length + b.length)));
    r.end = mid; second.start = mid;
  } else { second.end = null; }
  r.text = a; clearAudio(r);
  state.rows.splice(state.rows.indexOf(r) + 1, 0, second);
  renderAll(); toast('Line split in two');
}

function duplicateRow(r) {
  pushUndo();
  const copy = Object.assign({}, r, { id: ++uid, sel: false });
  state.rows.splice(state.rows.indexOf(r) + 1, 0, copy);
  renderAll();
}
function deleteRow(r) {
  pushUndo();
  if (state.playingId === r.id) { player.pause(); state.playingId = null; }
  state.rows = state.rows.filter((x) => x !== r);
  renderAll(); toast('Line deleted (Undo available)');
}
function togglePlay(r) {
  if (state.playingId === r.id && !player.paused) { player.pause(); return; }
  const src = r.blobUrl || r.url;
  if (!src) return;
  state.playingId = r.id;
  player.src = src;
  player.play().catch(() => toast('Could not play this audio.'));
  state.rows.forEach(updateRow);
}
['play', 'pause', 'ended'].forEach((ev) => player.addEventListener(ev, () => {
  if (ev === 'ended') state.playingId = null;
  state.rows.forEach(updateRow);
}));
function downloadRow(r) {
  const n = state.rows.indexOf(r) + 1;
  const a = document.createElement('a');
  a.href = r.blobUrl || r.url;
  if (r.blobUrl) a.download = 'khmer-tts-' + pad(n, 3) + '-' + slug(r.voice) + '.' + (r.ext || 'wav');
  else { a.target = '_blank'; a.rel = 'noopener'; }
  document.body.appendChild(a); a.click(); a.remove();
}

/* ---- event delegation for everything inside the table ---- */
let pending = null;                                         // snapshot taken when a field gets focus
const rowOf = (t) => { const e = t.closest('.srow'); return e ? rowById(+e.dataset.id) : null; };
const markStale = (r) => { if (hasAudio(r) && !r.stale) { r.stale = true; updateRow(r); refreshMeta(); } };

$('rows').addEventListener('focusin', (ev) => {
  const t = ev.target;
  if (t.matches('.f-text,.f-start,.f-end,.f-voice')) pending = snapshot();
  if (t.matches('.f-text')) growTa(t);
});
$('rows').addEventListener('input', (ev) => {
  const t = ev.target, r = rowOf(t);
  if (!r || !t.matches('.f-text')) return;
  r.text = t.value; growTa(t); markStale(r); scheduleSave();
});
$('rows').addEventListener('change', (ev) => {
  const t = ev.target, r = rowOf(t);
  if (!r) return;
  const commit = (changed) => { if (changed && pending) pushUndo(pending); pending = null; };
  if (t.matches('.f-edgevoice')) { r.edgeVoice = t.value; updateRow(r); scheduleSave(); }
  else if (t.matches('.f-sel')) { r.sel = t.checked; updateRow(r); refreshMeta(); }
  else if (t.matches('.f-text')) { commit(pending && (pending.find((x) => x.id === r.id) || {}).text !== r.text); updateRow(r); refreshMeta(); scheduleSave(); }
  else if (t.matches('.f-voice')) {
    const old = r.voice; r.voice = t.value;
    commit(old !== r.voice); markStale(r); scheduleSave();
  } else if (t.matches('.f-start,.f-end')) {
    const key = t.classList.contains('f-start') ? 'start' : 'end';
    const v = t.value.trim() === '' ? null : parseTime(t.value);
    if (t.value.trim() !== '' && v == null) { t.value = fmtTime(r[key]); toast('Use the time format 00:00:00,000'); pending = null; return; }
    const old = r[key]; r[key] = v; t.value = fmtTime(v);
    commit(old !== v); updateRow(r); scheduleSave();
  }
});
$('rows').addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-act]');
  if (!b || b.disabled) return;
  const r = rowOf(b);
  if (!r) return;
  switch (b.dataset.act) {
    case 'edgeplay': edgeRowPlay(r); break;
    case 'play': togglePlay(r); break;
    case 'regen': runQueue([r.id]); break;
    case 'dl': downloadRow(r); break;
    case 'dup': duplicateRow(r); break;
    case 'cut': splitRow(r); break;
    case 'del': deleteRow(r); break;
  }
});

/* ---- toolbar ---- */
/** Ticks / unticks lines. Select ticks every line (only the visible ones while a search filter is active); Unselect clears all. */
function setAllSelected(on) {
  const q = state.query.trim().toLowerCase();
  state.rows.forEach((r, i) => {
    const visible = !q || r.text.toLowerCase().includes(q) || String(i + 1) === q;
    if (!on || visible) r.sel = on;
    const cb = els.get(r.id) && els.get(r.id).querySelector('.f-sel'); if (cb) cb.checked = r.sel;
    updateRow(r);
  });
  refreshMeta();
}
$('selAll').addEventListener('change', (ev) => setAllSelected(ev.target.checked));
$('selAllBtn').onclick = () => setAllSelected(true);
$('unselAllBtn').onclick = () => setAllSelected(false);
$('search').addEventListener('input', (ev) => { state.query = ev.target.value; applyFilter(); });
$('addRow').onclick = addRow;
$('mergeSel').onclick = mergeSelected;
$('sortTime').onclick = sortByTime;
$('extend').onclick = extendEnds;
$('undo').onclick = undo;
$('clearAll').onclick = () => { pushUndo(); player.pause(); state.playingId = null; state.rows = []; renderAll(); toast('All lines removed (Undo available)'); };
$('importMore').onclick = () => $('srtMore').click();
$('srtMore').addEventListener('change', function () { loadSrtFile(this.files && this.files[0], true); this.value = ''; });
$('srtFile').addEventListener('change', function () { loadSrtFile(this.files && this.files[0], false); this.value = ''; });
$('pasteAdd').onclick = async () => { if (await addLines($('pasteText').value.split(/\r?\n/))) $('pasteText').value = ''; };
$('pasteSrt').onclick = async () => { if (await textToSrt($('pasteText').value.split(/\r?\n/))) $('pasteText').value = ''; };
$('pasteClip').onclick = async () => {
  try { const t = await navigator.clipboard.readText(); if (t) $('pasteText').value = t; else toast('The clipboard is empty.'); }
  catch { toast('Your browser blocked clipboard access. Long-press the box and choose Paste.'); $('pasteText').focus(); }
};
$('applyVoice').onclick = () => {
  const v = defaultVoice();
  pushUndo();
  state.rows.forEach((r) => { if (r.voice !== v) { r.voice = v; if (hasAudio(r)) r.stale = true; } });
  renderAll(); toast('Voice “' + v + '” applied to all lines');
};

/* ---------------------------------------------------------------------
 * 12. THE QUEUE  (sequential generation with token rotation)
 * ------------------------------------------------------------------- */
async function joinUrls(urls) {
  const items = [];
  let cursor = 0;
  for (const u of urls) {
    const buf = await decodeBlob(await cancellable(fetchBlob(u)));
    items.push({ buf, at: cursor }); cursor += buf.duration + 0.05;
  }
  return mixToWav(items);
}

/** Generates audio for one row (long text is split into ≤1400-character pieces and joined). */
async function generateRow(r, onToken) {
  const text = r.text.replace(/\s+/g, ' ').trim();
  if (!text) throw makeError('empty', 'Empty text');
  const urls = [];
  let lastIdx = 0;
  for (const piece of chunkText(text)) {
    const { url, idx } = await synthesizeWithRotation(piece, r.voice, onToken);
    urls.push(url); lastIdx = idx;
  }
  let blob = null;
  try {
    blob = urls.length === 1 ? await cancellable(fetchBlob(urls[0])) : await joinUrls(urls);
  } catch (e) {
    if (e && e.kind === 'cancelled') throw e;
    if (urls.length > 1) throw makeError('remote', 'Could not download the audio pieces: ' + errText(e));
    /* single piece: keep playing/downloading from the remote URL (e.g. CORS blocked the fetch) */
  }
  r.url = urls.length === 1 ? urls[0] : '';
  r.blob = blob; r.blobUrl = blob ? URL.createObjectURL(blob) : '';
  r.ext = blob ? extFromBlob(blob, urls[0]) : 'wav';
  r.audioDur = await audioDurationOf(blob, r.blobUrl || r.url);
  r.tokenIdx = lastIdx; r.status = 'done'; r.stale = false; r.error = '';
}

const isSystemic = (e) => !!e && (e.kind === 'cdn' || e.kind === 'api' || /not found|\b404\b/i.test(errText(e)));

async function runQueue(ids) {
  if (state.busy) return;
  clearError(); setNote('');
  const todo = ids.map(rowById).filter(Boolean);
  if (!todo.length) { toast('Nothing to generate.'); return; }

  saveTokens();
  state.pool = state.tokens.length ? state.tokens.slice() : [null];
  state.dead.clear();                                    // quotas may have refilled since last time
  state.cur = Math.min(state.cur, state.pool.length - 1);
  state.cancelled = false;

  todo.forEach((r) => { r.status = 'queued'; r.error = ''; updateRow(r); });
  state.busy = true; applyBusy(); refreshMeta();
  $('runbar').hidden = false;
  const total = todo.length;
  let k = 0, ok = 0, bad = 0, tokenIdx = state.cur, t0 = Date.now(), current = null, stop = null;
  const render = () => {
    if (!current) return;
    $('progTxt').textContent = 'Processing line ' + (k + 1) + ' of ' + total + ' (#' + (state.rows.indexOf(current) + 1) + ') using ' + tokenLabel(tokenIdx) + ' · ' + Math.round((Date.now() - t0) / 1000) + 's';
  };
  state.timer = setInterval(render, 500);

  try {
    for (; k < total; k++) {
      const r = todo[k];
      if (state.cancelled) break;
      current = r; t0 = Date.now();
      r.status = 'working'; r.tokenIdx = tokenIdx; updateRow(r);
      setProgress(k, total, 0.5); setPill('checking', 'Line ' + (k + 1) + '/' + total); render();
      try {
        await generateRow(r, (i) => { tokenIdx = i; r.tokenIdx = i; updateRow(r); render(); });
        ok++;
      } catch (e) {
        const reset = () => { r.status = hasAudio(r) ? 'done' : 'none'; };
        if (e && e.kind === 'cancelled') { reset(); break; }
        if (e && e.kind === 'exhausted') { reset(); stop = e; break; }
        if (isSystemic(e)) { reset(); stop = e; break; }
        console.warn('[khmer-tts] line failed:', e);
        r.status = 'failed'; r.error = (e && e.kind === 'empty') ? 'empty text' : errText(e).slice(0, 160);
        bad++;
      }
      updateRow(r); refreshMeta();
    }
  } finally {
    clearInterval(state.timer); state.timer = null; current = null;
    // anything still queued (cancel / stop) goes back to its previous state
    todo.forEach((r) => { if (r.status === 'queued' || r.status === 'working') { r.status = hasAudio(r) ? 'done' : 'none'; } updateRow(r); });
    state.busy = false; applyBusy(); refreshMeta();
  }

  setProgress(ok + bad, total);
  const left = total - ok - bad;
  if (stop && stop.kind === 'exhausted') {
    const n = state.tokens.length;
    setPill('bad', 'All tokens exhausted');
    showError(n
      ? 'All ' + n + ' token' + (n > 1 ? 's have' : ' has') + ' reached the GPU quota (or were rejected). Add more tokens above, or wait for the quota to refill (ZeroGPU quotas reset daily), then press “Generate all”. Finished lines are kept.'
      : 'The free anonymous GPU quota is used up and no token is saved. Add one or more Hugging Face tokens above, then press “Generate all”. Finished lines are kept.', true);
  } else if (stop) {
    setPill('bad', 'Error');
    const m = errText(stop);
    showError(stop.kind === 'cdn' || stop.kind === 'api' ? stop.message
      : /not found|404/i.test(m) ? 'The Space “' + state.space + '” could not be found. Check the name under Default voice → Advanced.'
      : 'Generation failed: ' + m, stop.kind !== 'cdn');
  } else if (state.cancelled) {
    setPill('idle', 'Cancelled');
  } else {
    setPill(bad ? 'bad' : 'ok', bad ? 'Done · ' + bad + ' failed' : 'Done · ' + ok + ' line' + (ok === 1 ? '' : 's'));
  }
  $('progTxt').textContent = (state.cancelled ? 'Cancelled. ' : stop ? 'Stopped. ' : 'Finished. ') + ok + ' generated' + (bad ? ', ' + bad + ' failed (use “Retry failed”)' : '') + (left > 0 ? ', ' + left + ' not processed' : '') + '.';
  setNote('');
  setTimeout(() => { if (!state.busy) $('runbar').hidden = true; }, bad || stop ? 9000 : 3500);
}

$('genSel').onclick = () => runQueue(state.rows.filter((r) => r.sel).map((r) => r.id));
$('genAll').onclick = () => runQueue(state.rows.filter((r) => r.text.trim() && (r.status !== 'done' || r.stale)).map((r) => r.id));
$('retry').onclick = () => runQueue(state.rows.filter((r) => r.status === 'failed').map((r) => r.id));
$('cancelBtn').onclick = () => {
  state.cancelled = true;
  if (state.cancelReject) state.cancelReject();
  if (edge.active || edge.previewing) { edge.cancel = true; if (synth) synth.cancel(); }   // Edge voice run
};

/* ---------------------------------------------------------------------
 * 13. MERGE & DOWNLOAD, EXPORT SRT
 * ------------------------------------------------------------------- */
async function mergeDownload() {
  clearError();
  const rows = state.rows.filter(hasAudio);
  if (!rows.length) { showError('There is no audio to merge yet. Generate some lines first.'); return; }
  const btn = $('mergeBtn'), label = btn.textContent;
  const mode = $('mergeMode').value, gap = Math.max(0, parseFloat($('mergeGap').value) || 0);
  btn.disabled = true;
  try {
    const items = [];
    let cursor = 0;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      btn.textContent = 'Merging ' + (i + 1) + ' / ' + rows.length + '…';
      await sleep(0);
      let blob = r.blob;
      if (!blob) {
        try { blob = await fetchBlob(r.url); }
        catch (e) { throw new Error('line #' + (state.rows.indexOf(r) + 1) + ' could not be downloaded (' + errText(e) + '). Regenerate it and try again.'); }
      }
      const buf = await decodeBlob(blob);
      const at = (mode === 'timeline' && r.start != null) ? Math.max(r.start / 1000, cursor) : (items.length ? cursor + gap : 0);
      items.push({ buf, at }); cursor = at + buf.duration;
    }
    btn.textContent = 'Encoding WAV…'; await sleep(0);
    const wav = mixToWav(items);
    downloadBlob(wav, 'khmer-tts-merged.wav');
    const mb = (wav.size / 1048576).toFixed(1), mins = (cursor / 60).toFixed(1);
    $('mergeSum').textContent = 'Done: ' + rows.length + ' lines merged · ' + mins + ' min · ' + mb + ' MB (WAV).';
    toast('Merged audio downloaded');
  } catch (e) {
    showError('Merge failed: ' + errText(e));
  } finally {
    btn.textContent = label; refreshMeta();
  }
}
$('mergeBtn').onclick = mergeDownload;

$('exportSrt').onclick = () => {
  if (!state.rows.length) return;
  let cursor = 0;
  const out = state.rows.map((r, i) => {
    const s = r.start != null ? r.start : cursor;
    const e = r.end != null ? r.end : s + Math.round((r.audioDur || 2) * 1000);
    cursor = e;
    return (i + 1) + '\n' + fmtTime(s) + ' --> ' + fmtTime(e) + '\n' + r.text.trim() + '\n';
  }).join('\n');
  downloadBlob(new Blob([out], { type: 'text/plain;charset=utf-8' }), 'khmer-tts-subtitles.srt');
};

/* ---------------------------------------------------------------------
 * 14. SETTINGS (voice, space) + EMBED HOOKS FOR THE DUBBER SITE
 * ------------------------------------------------------------------- */
function applySpaceLink() { $('spaceLink').href = 'https://huggingface.co/spaces/' + state.space; }
$('voice').addEventListener('change', () => { store.set('voice', $('voice').value); renderTokenStatus(); });
$('spaceId').addEventListener('change', () => {
  const v = $('spaceId').value.trim().replace(/^https?:\/\/huggingface\.co\/spaces\//i, '').replace(/\/+$/, '');
  state.space = /^[\w.-]+\/[\w.-]+$/.test(v) ? v : CFG.DEFAULT_SPACE;
  $('spaceId').value = state.space;
  store.set('space', state.space);
  state.sessions.clear(); applySpaceLink();
});

/* The main Dubber page talks to this module through the three messages below (unchanged). */
const embedded = window.parent !== window;
$('back').addEventListener('click', (e) => {
  if (embedded) {
    e.preventDefault();
    try { window.parent.postMessage({ type: 'khmer-tts-back' }, location.origin); } catch { location.href = '../'; }
  }
});
window.addEventListener('message', (e) => {
  if (e.origin !== location.origin || !e.data) return;
  if (e.data.type === 'khmer-tts-pause') player.pause();
  if (e.data.type === 'khmer-tts-import') importFromDubber(e.data.cues);
});
/** Lines sent from the Dubber page (“Import to Khmer TTS”) → 2 · Subtitles. */
let importing = false;
async function importFromDubber(cues) {
  if (importing || !Array.isArray(cues)) return;
  const num = (v) => (typeof v === 'number' && isFinite(v) && v >= 0) ? Math.round(v) : null;
  const rows = cues.slice(0, 5000).map((c) => c && typeof c === 'object' ? c : {})
    .map((c) => ({ start: num(c.start), end: num(c.end), text: String(c.text || '').replace(/\s+/g, ' ').trim(), ev: c.edgeVoice === 'Sreymom' ? 'Sreymom' : 'Piseth' }))
    .filter((c) => c.text);
  if (!rows.length) { toast('There are no lines to import.'); return; }
  importing = true;
  try {
    clearError();
    const mode = await askClear();
    if (mode === 'cancel') { toast('Import cancelled. Your table was not changed.'); return; }
    placeRows(rows.map((c) => newRow({ start: c.start, end: c.end, text: c.text, edgeVoice: c.ev })), mode);
    $('srtInfo').textContent = 'Imported from Dubber · ' + rows.length + ' subtitles';
    toast(rows.length + ' subtitles imported from Dubber');
    const card = $('t4') && $('t4').closest('.card');
    if (embedded) { try { window.parent.postMessage({ type: 'khmer-tts-imported', top: card ? Math.max(0, Math.round(card.getBoundingClientRect().top + window.scrollY - 8)) : 0 }, location.origin); } catch { /* ignore */ } }
    else if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } finally { importing = false; }
}
if (embedded) { try { window.parent.postMessage({ type: 'khmer-tts-ready' }, location.origin); } catch { /* ignore */ } }
if (embedded && window.ResizeObserver) {
  let last = 0;
  new ResizeObserver(() => {
    const h = Math.ceil(document.documentElement.scrollHeight);
    if (Math.abs(h - last) < 2) return;
    last = h;
    try { window.parent.postMessage({ type: 'khmer-tts-height', height: h }, location.origin); } catch { /* ignore */ }
  }).observe(document.body);
}
window.addEventListener('beforeunload', (e) => { if (state.busy) { e.preventDefault(); e.returnValue = ''; } });

/* ---------------------------------------------------------------------
 * 14b. SETTINGS: import / download Hugging Face tokens
 * ------------------------------------------------------------------- */
$('tokDownload').onclick = () => {
  const { valid } = parseTokens($('tokens').value);
  if (!valid.length) { toast('There are no tokens to download.'); return; }
  downloadBlob(new Blob([valid.join('\n') + '\n'], { type: 'text/plain;charset=utf-8' }), 'huggingface-tokens.txt');
  toast(valid.length + ' token' + (valid.length > 1 ? 's' : '') + ' saved to a file. Keep it private!');
};
$('tokImport').onclick = () => $('tokFile').click();
$('tokFile').addEventListener('change', function () {
  const file = this.files && this.files[0];
  this.value = '';
  if (!file) return;
  if (file.size > 1024 * 1024) { toast('That file is too large for a token list.'); return; }
  const reader = new FileReader();
  reader.onerror = () => toast('Could not read the file.');
  reader.onload = () => {
    // .txt (one per line), .csv or .json: every "hf_…" string in the file is picked up
    const found = Array.from(new Set(String(reader.result).match(/hf_[A-Za-z0-9]{8,}/g) || []));
    if (!found.length) { toast('No Hugging Face tokens (hf_…) found in that file.'); return; }
    const have = parseTokens($('tokens').value).valid;
    const fresh = found.filter((t) => !have.includes(t));
    $('tokens').value = have.concat(fresh).join('\n');
    saveTokens();
    toast(found.length + ' token' + (found.length > 1 ? 's' : '') + ' found · ' + fresh.length + ' new, saved');
  };
  reader.readAsText(file);
});

/* ---------------------------------------------------------------------
 * 14c. MICROSOFT EDGE VOICE  (browser speech synthesis: preview + record)
 *   Edge exposes natural Khmer voices (Piseth / Sreymom) through the Web Speech API.
 *   A browser can't export that audio directly, so "Record" captures this tab's audio
 *   (getDisplayMedia + MediaRecorder) while each line is spoken, then merges the clips.
 * ------------------------------------------------------------------- */
const synth = ('speechSynthesis' in window) ? window.speechSynthesis : null;
const edge = {
  voices: [], ok: false, previewing: false, active: false, cancel: false, rowId: null,
  isEdge: /\bEdg(?:e|A|iOS)?\//.test(navigator.userAgent)
};
// Show the Edge-only controls (per-line voice list + Edge play button, toolbar Edge buttons) in Microsoft Edge only.
document.documentElement.classList.toggle('is-edge', edge.isEdge);
const PREVIEW_LABEL = '🔊 Preview selected (Edge)';

const edgeVoiceLabel = (v) => v.name.replace(/^Microsoft\s+/i, '').replace(/\s*-\s*Khmer.*$/i, '').trim() || v.name;
const getEdgeVoice = () => edge.voices.find((v) => v.voiceURI === $('edgeVoice').value) || edge.voices[0] || null;

function loadEdgeVoices() {
  const sel = $('edgeVoice'), note = $('edgeNote');
  if (!synth) {
    edge.voices = []; edge.ok = false;
    sel.replaceChildren(mk('option', '', { textContent: 'Not supported in this browser' }));
    note.textContent = 'This browser has no speech synthesis. Open this page in Microsoft Edge.';
    note.className = 'note warn';
    refreshMeta(); state.rows.forEach(updateRow); return;
  }
  const wanted = sel.value || store.get('edgeVoice');
  edge.voices = synth.getVoices().filter((v) => /^km([-_]|$)/i.test(v.lang));
  edge.voices.sort((a, b) => (/natural|online/i.test(b.name) - /natural|online/i.test(a.name)) || a.name.localeCompare(b.name));
  sel.replaceChildren();
  if (!edge.voices.length) sel.append(mk('option', '', { textContent: 'No Khmer voice found' }));
  edge.voices.forEach((v) => sel.append(mk('option', '', { value: v.voiceURI, textContent: edgeVoiceLabel(v) })));
  const keep = edge.voices.find((v) => v.voiceURI === wanted);
  if (keep) sel.value = keep.voiceURI;
  edge.ok = edge.voices.length > 0;
  if (edge.ok) {
    note.className = 'note ok';
    note.textContent = edge.isEdge
      ? edge.voices.length + ' Khmer voice' + (edge.voices.length > 1 ? 's' : '') + ' ready. Preview plays instantly; Record asks you to share your screen audio.'
      : 'A Khmer voice was found (works best in Microsoft Edge).';
  } else {
    note.className = 'note warn';
    note.textContent = edge.isEdge
      ? 'No Khmer voice found yet. Check your internet connection (Edge’s natural voices are online), then reload the page.'
      : 'Open this page in Microsoft Edge to use its Khmer voices (Piseth / Sreymom).';
  }
  refreshMeta();
  state.rows.forEach(updateRow);
}

/** Re-reads the voice from the browser right before speaking (a voice object saved earlier can go stale in Edge and then plays nothing). */
function freshVoice(voice) {
  let list = [];
  try { list = synth.getVoices(); } catch { /* ignore */ }
  return list.find((v) => v.voiceURI === voice.voiceURI && v.name === voice.name) || list.find((v) => v.name === voice.name) || voice;
}

/** One attempt: resolves { silent } — silent = it "finished" far too fast to have produced sound. */
function speakOnce(text, voice) {
  return new Promise((resolve, reject) => {
    const u = new SpeechSynthesisUtterance(text);
    u.voice = voice; u.lang = voice.lang; u.rate = parseFloat($('edgeRate').value) || 1; u.volume = 1; u.pitch = 1;
    let done = false, started = false, t0 = 0;
    const fin = (fn, v) => { if (done) return; done = true; clearTimeout(wd); clearTimeout(startWd); fn(v); };
    const wd = setTimeout(() => { synth.cancel(); fin(reject, new Error('The voice did not finish in time.')); }, 120000);
    const startWd = setTimeout(() => {
      if (!started) { synth.cancel(); fin(reject, new Error('The Edge voice did not start. Check your internet connection (Edge natural voices are online) and try again.')); }
    }, 15000);
    u.onstart = () => { started = true; t0 = performance.now(); clearTimeout(startWd); };
    u.onend = () => {
      const ms = t0 ? performance.now() - t0 : 0;
      const need = Math.max(100, Math.min(600, (len(text) * 10) / (u.rate || 1)));   // far shorter than any real speech
      fin(resolve, { silent: !edge.cancel && ms < need });
    };
    u.onerror = (e) => (e.error === 'canceled' || e.error === 'interrupted') ? fin(resolve, { silent: false }) : fin(reject, new Error(e.error || 'speech error'));
    try { synth.resume(); } catch { /* ignore */ }
    synth.speak(u);
  });
}
/** Speaks one piece of text with a fresh voice object; if it ends silently, resets the engine and retries once. */
async function speakPiece(text, voice) {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (edge.cancel) return;
    const r = await speakOnce(text, freshVoice(voice));
    if (!r.silent) return;
    synth.cancel(); await sleep(400);                          // reset the speech engine, then try again
  }
  if (!edge.cancel) throw new Error('“' + edgeVoiceLabel(voice) + '” produced no sound. Check your internet connection (Edge natural voices are online), then reload the page and try again.');
}
/** Long lines are spoken in pieces of ≤ 600 characters. */
async function speakText(text, voice) {
  for (const piece of chunkText(text, 600)) {
    if (edge.cancel) return;
    await speakPiece(piece, voice);
  }
}
const focusRow = (r) => { const e = els.get(r.id); if (e) e.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); };

/** Finds the installed Edge Khmer voice for 'Piseth' or 'Sreymom' (falls back to any Khmer voice). */
const RE_PISETH = /piseth/i, RE_SREYMOM = /sreymom|srey\s*mom/i;
function voiceForName(name) {
  const want = name === 'Sreymom' ? RE_SREYMOM : RE_PISETH;
  const other = name === 'Sreymom' ? RE_PISETH : RE_SREYMOM;
  return edge.voices.find((v) => want.test(v.name))
      || edge.voices.find((v) => !other.test(v.name))
      || edge.voices[0] || null;
}
/** The Piseth / Sreymom value of this row's own dropdown (falls back to the stored value). */
function rowVoiceName(r) {
  const sel = els.get(r.id) && els.get(r.id).querySelector('.f-edgevoice');
  return (sel && sel.value) || r.edgeVoice || 'Piseth';
}
const voiceForRow = (r) => voiceForName(rowVoiceName(r));
/** True when the chosen name really exists in this Edge; otherwise tells the user which voice is used instead. */
function warnIfMissing(name, voice) {
  const want = name === 'Sreymom' ? RE_SREYMOM : RE_PISETH;
  if (voice && want.test(voice.name)) return false;
  toast('The Edge voice “' + name + '” is not installed here, so “' + (voice ? edgeVoiceLabel(voice) : 'none') + '” is used. Installed Khmer voices: ' + (edge.voices.map(edgeVoiceLabel).join(', ') || 'none') + '.');
  return true;
}
/** Waits (up to ~2.5 s) for the browser to report its voices. */
async function ensureVoices() {
  for (let i = 0; i < 25 && !edge.voices.length; i++) { loadEdgeVoices(); if (edge.voices.length) break; await sleep(100); }
  return edge.voices.length > 0;
}

/* ---- 🔊 Play one line with its own Edge voice (Piseth / Sreymom) ---- */
async function edgeRowPlay(r) {
  if (!edge.isEdge || !synth) return;
  if (edge.active) { toast('Wait for the recording to finish.'); return; }
  const wasThis = edge.rowId === r.id;
  if (edge.previewing || edge.rowId != null) {                 // stop whatever is speaking
    edge.cancel = true; synth.cancel();
    for (let i = 0; i < 30 && (edge.previewing || edge.rowId != null); i++) await sleep(50);
    if (wasThis) return;                                      // second click on the same line = stop
  }
  if (!r.text.trim()) { toast('This line has no text.'); return; }
  edge.rowId = r.id; edge.cancel = false; state.edgeId = r.id;   // mark busy right away (also lets a 2nd click stop it)
  updateRow(r);
  try {
    if (!(await ensureVoices())) { toast('No Khmer Edge voice found. Check your internet connection, then reload.'); return; }
    const voice = voiceForRow(r);
    warnIfMissing(rowVoiceName(r), voice);
    if (edge.cancel) return;
    player.pause();
    synth.cancel();
    await sleep(80);                                          // Chromium drops speak() fired right after cancel()
    if (edge.cancel) return;
    await speakText(r.text, voice);
  } catch (e) {
    toast('Edge voice error: ' + errText(e));
  } finally {
    edge.rowId = null; edge.cancel = false; state.edgeId = null;
    updateRow(r);
  }
}

/* ---- 🔊 Preview selected ---- */
async function edgePreview() {
  if (edge.previewing) { edge.cancel = true; synth.cancel(); return; }          // ⏹ Stop: cancels immediately
  if (edge.active) { toast('Wait for the recording to finish.'); return; }
  const picked = state.rows.filter((r) => r.sel);                               // top-to-bottom order
  if (!picked.length) { toast('Select some lines first (tick the checkboxes or use “Select All”).'); return; }
  const rows = picked.filter((r) => r.text.trim());                             // empty lines are skipped
  if (!rows.length) { toast('The selected lines have no text.'); return; }
  edge.previewing = true; edge.cancel = false;                                  // claim the button first so a quick 2nd click = Stop
  $('edgePrev').textContent = '⏹ Stop';
  let spoken = 0; const warned = new Set();
  try {
    if (!(await ensureVoices())) { toast('No Khmer Edge voice available.'); return; }
    if (edge.rowId != null) { synth.cancel(); for (let i = 0; i < 30 && edge.rowId != null; i++) await sleep(50); }
    player.pause();
    synth.cancel();
    await sleep(80);                                                            // Chromium drops speak() fired right after cancel()
    for (const r of rows) {
      if (edge.cancel) break;
      if (!state.rows.includes(r) || !r.text.trim()) continue;                  // deleted / emptied while previewing
      state.edgeId = r.id; updateRow(r); focusRow(r);                           // highlight the playing row
      if (!warned.has(rowVoiceName(r))) { warned.add(rowVoiceName(r)); warnIfMissing(rowVoiceName(r), voiceForRow(r)); }
      await speakText(r.text, voiceForRow(r));                                  // this row's own Piseth / Sreymom choice
      spoken++;
      state.edgeId = null; updateRow(r);
    }
    if (!edge.cancel && picked.length > rows.length) toast((picked.length - rows.length) + ' empty line(s) skipped.');
  } catch (e) {
    toast('Edge voice error: ' + errText(e));
  } finally {
    edge.previewing = false; edge.cancel = false; state.edgeId = null;
    state.rows.forEach(updateRow);
    $('edgePrev').textContent = PREVIEW_LABEL;
    refreshMeta();
  }
}

/* ---- recording helpers ---- */
async function recordOne(stream, mime, speakFn) {
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const parts = [];
  const stopped = new Promise((res, rej) => { rec.onstop = res; rec.onerror = (e) => rej(e.error || new Error('Recorder error')); });
  rec.ondataavailable = (e) => { if (e.data && e.data.size) parts.push(e.data); };
  rec.start();
  await sleep(200);                                  // lead-in so the first syllable isn't clipped
  try { await speakFn(); await sleep(350); }         // tail so the last syllable isn't clipped
  finally { if (rec.state !== 'inactive') rec.stop(); }
  await stopped;
  return new Blob(parts, { type: rec.mimeType || 'audio/webm' });
}
function peakOf(buf) {
  const d = buf.getChannelData(0);
  let m = 0;
  for (let i = 0; i < d.length; i++) { const v = Math.abs(d[i]); if (v > m) m = v; }
  return m;
}
/** Cuts the silence recorded before / after the speech (keeps 50 ms), so timing stays tight. */
function trimBuffer(buf, thr = 0.012, pad = 0.05) {
  const n = buf.length, sr = buf.sampleRate, ch = [];
  for (let c = 0; c < buf.numberOfChannels; c++) ch.push(buf.getChannelData(c));
  const loud = (i) => { for (let c = 0; c < ch.length; c++) if (Math.abs(ch[c][i]) >= thr) return true; return false; };
  let a = 0; while (a < n && !loud(a)) a++;
  if (a >= n) return buf;                            // silent → leave it
  let b = n - 1; while (b > a && !loud(b)) b--;
  const p = Math.round(pad * sr), s = Math.max(0, a - p), e = Math.min(n, b + p + 1);
  const out = getCtx().createBuffer(ch.length, e - s, sr);
  for (let c = 0; c < ch.length; c++) out.copyToChannel(ch[c].subarray(s, e), c);
  return out;
}
/** clips: [{buf, start(ms|null)}] → one WAV, using the same merge mode / gap as section 3. */
function mergeClips(clips) {
  const mode = $('mergeMode').value, gap = Math.max(0, parseFloat($('mergeGap').value) || 0);
  const items = [];
  let cursor = 0;
  for (const c of clips) {
    const at = (mode === 'timeline' && c.start != null) ? Math.max(c.start / 1000, cursor) : (items.length ? cursor + gap : 0);
    items.push({ buf: c.buf, at }); cursor = at + c.buf.duration;
  }
  return { wav: mixToWav(items), seconds: cursor };
}

/* ---- recording source presets ---- */
const CAPTURE = {
  screen: {      // system-audio loopback: captures Edge's natural voices (Windows)
    tip: 'Recording tip: when the browser asks what to share, choose “Entire screen” and turn ON “Also share system audio” (Windows). Mute other apps while recording.',
    prompt: 'In the browser prompt choose “Entire screen” and turn ON “Also share system audio”…',
    opts: { video: { displaySurface: 'monitor' }, audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }, selfBrowserSurface: 'exclude', systemAudio: 'include' },
    noAudio: 'No audio was shared. Press the button again, choose “Entire screen” and turn ON “Also share system audio”. (System-audio sharing works on Windows, not on macOS.)',
    silent: 'No sound was captured. Check that “Also share system audio” was ON, your speakers are not muted, and no other app is silent-locking the audio device. System-audio capture works on Windows only.'
  },
  tab: {         // tab audio: often silent for Edge’s online voices
    tip: 'Recording tip: choose “This tab” and turn on “Also share tab audio”. If the result is silent, switch Recording source to “Entire screen + system audio”.',
    prompt: 'In the browser prompt choose “This tab” and turn on “Also share tab audio”…',
    opts: { video: true, audio: true, preferCurrentTab: true, selfBrowserSurface: 'include', systemAudio: 'include' },
    noAudio: 'No audio was shared. Press the button again, choose “This tab” and turn on “Also share tab audio”.',
    silent: 'No sound was captured from this tab. Edge’s online voices are often not included in tab audio. Change “Recording source” (Settings → Microsoft Edge voice) to “Entire screen + system audio” and try again.'
  }
};
const captureCfg = () => CAPTURE[$('edgeCapture').value] || CAPTURE.screen;

/* ---- ⏺ Record & download (all / selected) ---- */
async function edgeRecord(rows, tag) {
  if (state.busy) return;
  const voice = getEdgeVoice();
  if (!voice) { toast('No Khmer Edge voice available.'); return; }
  rows = rows.filter((r) => r.text.trim());
  if (!rows.length) { toast('There is no text to record.'); return; }
  if (!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) || !window.MediaRecorder) {
    showError('This browser cannot record tab audio. Please use Microsoft Edge on a computer.'); return;
  }
  if (edge.previewing) { edge.cancel = true; synth.cancel(); await sleep(200); }
  player.pause();
  clearError(); setNote('');
  edge.cancel = false; edge.active = true;
  state.busy = true; state.cancelled = false; applyBusy(); refreshMeta();
  $('runbar').hidden = false;
  const cap = captureCfg();
  $('progTxt').textContent = cap.prompt;
  setProgress(0, rows.length); setPill('checking', 'Recording…');

  const clips = [];
  let stream = null, problem = null, wasCancelled = false, finishing = false;
  try {
    try {
      stream = await navigator.mediaDevices.getDisplayMedia(cap.opts);
    } catch (e) {
      throw makeError('edge', (e && e.name === 'NotAllowedError')
        ? 'Recording was cancelled or blocked. Press the button again and allow sharing with audio.'
        : 'Could not start recording: ' + errText(e));
    }
    if (!stream.getAudioTracks().length) {
      throw makeError('edge', cap.noAudio);
    }
    // if the user presses the browser's "Stop sharing" bar, finish what was recorded so far
    stream.getTracks().forEach((t) => t.addEventListener('ended', () => { if (!finishing) { edge.cancel = true; synth.cancel(); } }));
    const audioOnly = new MediaStream(stream.getAudioTracks());
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'].find((m) => MediaRecorder.isTypeSupported(m)) || '';

    for (let i = 0; i < rows.length; i++) {
      if (edge.cancel) break;
      const r = rows[i];
      state.edgeId = r.id; updateRow(r); focusRow(r);
      $('progTxt').textContent = 'Recording line ' + (i + 1) + ' of ' + rows.length + ' (#' + (state.rows.indexOf(r) + 1) + ') · ' + edgeVoiceLabel(voiceForRow(r) || voice);
      setProgress(i, rows.length, 0.5);
      const blob = await recordOne(audioOnly, mime, () => speakText(r.text, voiceForRow(r) || voice));
      updateRow(r);
      if (edge.cancel) break;
      const buf = await decodeBlob(blob);
      if (i === 0 && peakOf(buf) < 0.002) {
        throw makeError('edge', cap.silent);
      }
      clips.push({ buf: trimBuffer(buf), start: r.start });
      setProgress(i + 1, rows.length);
    }
  } catch (e) {
    problem = e;
  } finally {
    wasCancelled = edge.cancel;
    finishing = true;
    if (stream) stream.getTracks().forEach((t) => t.stop());
    synth.cancel();
    state.edgeId = null; edge.active = false; edge.cancel = false;
    state.busy = false; applyBusy(); refreshMeta();
    rows.forEach(updateRow);
  }

  // merge + download whatever was recorded (also after Cancel / an error → "-partial")
  if (clips.length) {
    try {
      $('progTxt').textContent = 'Merging ' + clips.length + ' clip' + (clips.length > 1 ? 's' : '') + '…';
      await sleep(0);
      const { wav, seconds } = mergeClips(clips);
      const partial = wasCancelled || !!problem;
      downloadBlob(wav, 'khmer-tts-edge-' + tag + (partial ? '-partial' : '') + '.wav');
      $('mergeSum').textContent = 'Edge recording: ' + clips.length + ' line' + (clips.length > 1 ? 's' : '') + ' · ' + (seconds / 60).toFixed(1) + ' min · ' + (wav.size / 1048576).toFixed(1) + ' MB (WAV).';
      toast(partial ? 'Partial recording downloaded' : 'Edge recording downloaded');
    } catch (e) { problem = problem || e; }
  }
  if (problem) {
    setPill('bad', 'Error');
    showError(problem.kind === 'edge' ? problem.message : 'Recording failed: ' + errText(problem));
    $('progTxt').textContent = 'Stopped. ' + clips.length + ' of ' + rows.length + ' lines recorded.';
  } else if (wasCancelled) {
    setPill('idle', 'Cancelled');
    $('progTxt').textContent = 'Cancelled. ' + clips.length + ' of ' + rows.length + ' lines recorded.';
  } else {
    setPill('ok', 'Recorded · ' + clips.length + ' line' + (clips.length === 1 ? '' : 's'));
    $('progTxt').textContent = 'Finished. ' + clips.length + ' line' + (clips.length === 1 ? '' : 's') + ' recorded and downloaded.';
  }
  setTimeout(() => { if (!state.busy) $('runbar').hidden = true; }, problem ? 9000 : 3500);
}

$('edgePrev').onclick = edgePreview;
$('edgeAll').onclick = () => edgeRecord(state.rows.slice(), 'all');
$('edgeSel').onclick = () => edgeRecord(state.rows.filter((r) => r.sel), 'selected');
$('edgeCapture').addEventListener('change', () => { store.set('edgeCapture', $('edgeCapture').value); $('edgeTip').textContent = captureCfg().tip; });
$('edgeVoice').addEventListener('change', () => store.set('edgeVoice', $('edgeVoice').value));
$('edgeRate').addEventListener('input', () => { $('edgeRateV').textContent = (+$('edgeRate').value) + '×'; store.set('edgeRate', $('edgeRate').value); });
if (synth) synth.addEventListener('voiceschanged', loadEdgeVoices);
window.addEventListener('pagehide', () => { if (synth) synth.cancel(); });

/* ---------------------------------------------------------------------
 * 15. INIT
 * ------------------------------------------------------------------- */
(function init() {
  CFG.VOICES.forEach((v) => $('voice').append(mk('option', '', { value: v, textContent: v })));
  const sv = store.get('voice');
  $('voice').value = CFG.VOICES.includes(sv) ? sv : CFG.DEFAULT_VOICE;

  const ss = store.get('space');
  // ignore a saved name that is known not to exist (VoxPocket/Khmer-TTS returns 404)
  if (ss && ss !== 'VoxPocket/Khmer-TTS' && /^[\w.-]+\/[\w.-]+$/.test(ss)) state.space = ss;
  $('spaceId').value = state.space;
  applySpaceLink();

  $('tokens').value = store.get('tokens') || '';
  state.tokens = parseTokens($('tokens').value).valid;
  renderTokenStatus();
  $('settings').open = state.tokens.length === 0;     // collapsed once a token is saved

  const ec = store.get('edgeCapture');
  if (ec === 'tab' || ec === 'screen') $('edgeCapture').value = ec;
  $('edgeTip').textContent = captureCfg().tip;
  const er = parseFloat(store.get('edgeRate'));
  if (er >= 0.6 && er <= 1.6) $('edgeRate').value = er;
  $('edgeRateV').textContent = (+$('edgeRate').value) + '×';

  restoreRows();
  renderAll();
  loadEdgeVoices();
})();
