/* Khmer TTS Studio - self-contained module. Talks directly to the public
 * VoxPocket Hugging Face Space from the browser. No backend, no token.
 *
 * Space API (read from the Space's app.py, re-checked live via /config at runtime):
 *   pick_voice(name)                                   -> [reference clip (file), clip transcript]
 *   clone(text, style, clip, clip_text, cfg, steps, seed) -> [audio (wav file), note]
 * The built-in voices work by "cloning" the bundled reference clip, exactly like the Space's own UI. */
(function () {
  'use strict';

  var SPACE_ID = 'muyleanging/VoxPocket-TTS-Demo';
  var SPACE_URL = 'https://muyleanging-voxpocket-tts-demo.hf.space';
  var SPACE_PAGE = 'https://huggingface.co/spaces/' + SPACE_ID;
  var MAX_CHARS = 1500;                       // limit enforced by the Space
  // Fallback lists copied from the Space source; replaced by the live /config values when reachable.
  var FALLBACK_VOICES = ['Woman 1', 'Woman 2', 'Man 1'];
  var FALLBACK_STYLES = ['None (plain)', 'Happy', 'Sad', 'Excited (English: soon)', 'Calm', 'Whisper',
    'Angry / upset (English: soon)', 'Surprised (English: soon)', 'News reader', 'Friendly', 'Soft'];

  // Testing hook: only on localhost may the Space URL be overridden (?space=http://localhost:PORT).
  var spaceUrl = SPACE_URL;
  try {
    var q = new URLSearchParams(location.search).get('space');
    if (q && /^(localhost|127\.0\.0\.1)$/.test(location.hostname) && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(q)) spaceUrl = q;
  } catch (e) {}

  var $ = function (id) { return document.getElementById(id); };
  var embedded = window.parent !== window;

  var ICON = {
    play: '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><rect x="6" y="5" width="4.2" height="14" rx="1.2"/><rect x="13.8" y="5" width="4.2" height="14" rx="1.2"/></svg>',
    stop: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
    replay: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1"/><path d="M3.5 4v4.5H8"/></svg>'
  };

  var S = {
    client: null, busy: false, abort: null, voices: [], styles: [], voice: null,
    samples: {}, previewing: null, blob: null, audioUrl: null, objUrl: null, lastVoice: '', dragging: false, timer: null
  };

  /* ---------- storage (session only, may be unavailable) ---------- */
  function sget(k) { try { return sessionStorage.getItem('ktts.' + k); } catch (e) { return null; } }
  function sset(k, v) { try { sessionStorage.setItem('ktts.' + k, v); } catch (e) {} }

  /* ---------- helpers ---------- */
  function fmt(t) { if (!isFinite(t) || t < 0) t = 0; var m = Math.floor(t / 60), s = Math.floor(t % 60); return m + ':' + (s < 10 ? '0' : '') + s; }
  function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'voice'; }
  function charCount(s) { return Array.from(s).length; }
  function hasKhmer(s) { return /[ក-៿]/.test(s); }
  function choiceValues(comp) {
    var ch = comp && comp.props && comp.props.choices; if (!Array.isArray(ch)) return null;
    return ch.map(function (c) { return Array.isArray(c) ? c[1] : c; });
  }

  /* ---------- error box ---------- */
  function showError(msg, withLink) {
    var el = $('err'); el.innerHTML = '';
    var span = document.createElement('span'); span.textContent = msg; el.appendChild(span);
    if (withLink) {
      var a = document.createElement('a'); a.href = SPACE_PAGE; a.target = '_blank'; a.rel = 'noopener'; a.textContent = ' Open the Space ↗';
      el.appendChild(a);
    }
    el.hidden = false;
  }
  function clearError() { $('err').hidden = true; $('err').textContent = ''; }

  function explain(e) {
    if (e && e.code === 'aborted') return { msg: 'Generation cancelled.', link: false };
    if (e && e.code === 'unavailable') return { msg: 'The Khmer voice engine is not available right now. The free Hugging Face Space may be asleep or starting: open it once, wait about a minute, then try again. (' + e.message + ')', link: true };
    if (e && e.code === 'network') return { msg: 'Could not reach the Hugging Face Space. Check your internet connection, or the Space may be asleep or blocked by your network. ' + (e.message || ''), link: true };
    if (e && e.code === 'timeout') return { msg: e.message + ' Try a shorter text.', link: false };
    if (e && e.code === 'remote') {
      var m = String(e.message || '');
      if (/quota|zerogpu|gpu/i.test(m)) return { msg: 'The free GPU quota is used up right now. Please wait a few minutes and try again. (' + m + ')', link: true };
      if (/queue|busy|full/i.test(m)) return { msg: 'The Space is busy (queue full). Please try again in a moment. (' + m + ')', link: false };
      return { msg: 'The Space reported an error: ' + m, link: false };
    }
    if (e && e.code === 'http') {
      if (e.status === 503 || e.status === 502 || e.status === 504) return { msg: 'The Space is starting or overloaded (HTTP ' + e.status + '). Wait a minute and try again.', link: true };
      if (e.status === 429) return { msg: 'Too many requests. Please wait a bit and try again.', link: false };
      return { msg: e.message, link: true };
    }
    return { msg: (e && e.message) || 'Something went wrong.', link: false };
  }

  /* ---------- Space status pill ---------- */
  function setPill(state, text) { $('spacePill').dataset.state = state; $('spaceTxt').textContent = text; }

  async function hfStage() {   // optional extra info; failures are ignored
    try {
      var c = new AbortController(); var t = setTimeout(function () { c.abort(); }, 6000);
      var r = await fetch('https://huggingface.co/api/spaces/' + SPACE_ID, { signal: c.signal }); clearTimeout(t);
      if (!r.ok) return null; var j = await r.json(); return j && j.runtime && j.runtime.stage || null;
    } catch (e) { return null; }
  }

  async function ensureClient() {
    if (!S.client) S.client = new GradioLite(spaceUrl);
    if (!S.client.config) await S.client.connect();
    return S.client;
  }

  async function checkSpace() {
    setPill('checking', 'Checking Space…');
    try {
      var c = new GradioLite(spaceUrl); await c.connect(); S.client = c;
      if (!c.hasEndpoint('clone') || !c.hasEndpoint('pick_voice')) { setPill('bad', 'Space API changed'); showError('The Space is online but its API no longer matches this page (missing "clone"/"pick_voice"). The module needs an update.', true); return; }
      applyConfig(c); setPill('ok', 'Space online');
    } catch (e) {
      var st = await hfStage();
      if (st === 'SLEEPING' || st === 'PAUSED' || st === 'STOPPED') setPill('warn', 'Space is asleep');
      else if (st === 'BUILDING' || st === 'RUNNING_BUILDING' || st === 'APP_STARTING') setPill('warn', 'Space is starting…');
      else if (st === 'RUNTIME_ERROR' || st === 'BUILD_ERROR' || st === 'CONFIG_ERROR') setPill('bad', 'Space has an error');
      else setPill('warn', 'Space not reachable');
    }
  }

  /* ---------- voices / styles ---------- */
  function applyConfig(c) {
    var v = choiceValues(c.inputComponent('pick_voice', 0));
    if (v) { v = v.filter(function (x) { return !/upload/i.test(x); }); if (v.length) { S.voices = v; renderVoices(); } }
    var st = choiceValues(c.inputComponent('clone', 1));
    if (st && st.length) { S.styles = st; renderStyles(); }
    [['cfg', 4, 'cfgV'], ['steps', 5, 'stepsV']].forEach(function (a) {
      var comp = c.inputComponent('clone', a[1]); if (!comp || !comp.props) return;
      var el = $(a[0]); var p = comp.props;
      if (typeof p.minimum === 'number') el.min = p.minimum; if (typeof p.maximum === 'number') el.max = p.maximum;
      if (typeof p.step === 'number') el.step = p.step;
      if (sget(a[0]) == null && typeof p.value === 'number') el.value = p.value;
      $(a[2]).textContent = Number(el.value).toFixed(a[0] === 'cfg' ? 1 : 0);
    });
  }

  function renderVoices() {
    var box = $('vlist'); box.innerHTML = '';
    if (S.voices.indexOf(S.voice) === -1) S.voice = S.voices[0];
    S.voices.forEach(function (name) {
      var row = document.createElement('div'); row.className = 'v' + (name === S.voice ? ' on' : '');
      var b = document.createElement('button'); b.type = 'button'; b.className = 'vsel'; b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', name === S.voice ? 'true' : 'false');
      b.innerHTML = '<span class="dot"></span><span class="vn"></span>'; b.querySelector('.vn').textContent = name;
      b.onclick = function () { S.voice = name; sset('voice', name); renderVoices(); };
      var p = document.createElement('button'); p.type = 'button'; p.className = 'vprev'; p.dataset.voice = name;
      p.textContent = S.previewing === name ? '■ Stop' : '▶ Preview'; p.onclick = function () { preview(name); };
      p.disabled = S.busy;
      row.appendChild(b); row.appendChild(p); box.appendChild(row);
    });
  }
  function renderStyles() {
    var sel = $('style'); var cur = sget('style') || sel.value; sel.innerHTML = '';
    S.styles.forEach(function (s) { var o = document.createElement('option'); o.value = s; o.textContent = s; sel.appendChild(o); });
    if (S.styles.indexOf(cur) !== -1) sel.value = cur;
  }

  /* voice preview = the voice's own reference clip, served by the Space (pick_voice) */
  var prevAudio = new Audio();
  prevAudio.addEventListener('ended', function () { S.previewing = null; renderVoices(); });
  async function getSample(name) {
    var c = await ensureClient();
    var out = await c.call('pick_voice', [name], { deadlineMs: 60000 });
    if (!Array.isArray(out) || !out[0]) throw new GradioError('protocol', 'The Space returned no sample for this voice.');
    S.samples[name] = { fd: out[0], text: out[1] == null ? '' : String(out[1]), url: c.fileUrl(out[0]) };
    return S.samples[name];
  }
  async function preview(name) {
    if (S.busy) return;
    if (S.previewing === name) { prevAudio.pause(); S.previewing = null; renderVoices(); return; }
    clearError(); pauseMain(); prevAudio.pause();
    try {
      S.previewing = name; renderVoices();
      var s = S.samples[name] || await getSample(name);
      prevAudio.src = s.url; await prevAudio.play();
    } catch (e) { S.previewing = null; renderVoices(); var x = explain(e); showError('Preview failed. ' + x.msg, x.link); }
  }

  /* ---------- text editor ---------- */
  var ta = $('text');
  function updateCount() {
    var n = charCount(ta.value); var el = $('count');
    el.textContent = n + ' / ' + MAX_CHARS; el.classList.toggle('over', n > MAX_CHARS); el.classList.toggle('near', n > MAX_CHARS * 0.9 && n <= MAX_CHARS);
    $('hint').textContent = (n && !hasKhmer(ta.value)) ? 'No Khmer letters detected: VoxPocket is a Khmer voice model.' : '';
    sset('text', ta.value);
    if (n > 0 && !$('err').hidden && /empty|Please type/i.test($('err').textContent)) clearError();
  }
  ta.addEventListener('input', updateCount);
  $('clearBtn').onclick = function () { ta.value = ''; updateCount(); clearError(); ta.focus(); };
  $('pasteBtn').onclick = async function () {
    try { var t = await navigator.clipboard.readText(); if (!t) { showError('The clipboard is empty.'); return; } ta.value = t; updateCount(); clearError(); }
    catch (e) { showError('Your browser did not allow reading the clipboard. Long-press the text box (or press Ctrl+V) and choose Paste.'); ta.focus(); }
  };

  /* ---------- main audio player ---------- */
  var audio = new Audio(); audio.preload = 'auto';
  var playBtn = $('playBtn');
  $('stopBtn').innerHTML = ICON.stop; $('replayBtn').innerHTML = ICON.replay; playBtn.innerHTML = ICON.play;
  function syncPlay() { var p = !audio.paused && !audio.ended; playBtn.innerHTML = p ? ICON.pause : ICON.play; playBtn.setAttribute('aria-label', p ? 'Pause' : 'Play'); $('player').classList.toggle('playing', p); }
  function pauseMain() { if (!audio.paused) audio.pause(); }
  function tick() {
    var d = audio.duration, t = audio.currentTime;
    $('cur').textContent = fmt(t); $('dur').textContent = fmt(d);
    if (!S.dragging && isFinite(d) && d > 0) $('seek').value = Math.round(t / d * 1000);
    $('seek').style.setProperty('--pr', ($('seek').value / 10) + '%');
  }
  ['timeupdate', 'loadedmetadata', 'durationchange'].forEach(function (e) { audio.addEventListener(e, tick); });
  ['play', 'pause', 'ended'].forEach(function (e) { audio.addEventListener(e, syncPlay); });
  audio.addEventListener('error', function () { if (audio.src) showError('This audio could not be played by your browser.'); });
  playBtn.onclick = function () { prevAudio.pause(); S.previewing = null; if (audio.paused || audio.ended) audio.play().catch(function () { showError('Playback was blocked by the browser. Tap Play again.'); }); else audio.pause(); };
  $('stopBtn').onclick = function () { audio.pause(); audio.currentTime = 0; tick(); syncPlay(); };
  $('replayBtn').onclick = function () { audio.currentTime = 0; audio.play().catch(function () {}); };
  var seek = $('seek');
  seek.addEventListener('input', function () { S.dragging = true; if (isFinite(audio.duration)) audio.currentTime = seek.value / 1000 * audio.duration; tick(); });
  seek.addEventListener('change', function () { S.dragging = false; });
  var vol = $('vol'); vol.addEventListener('input', function () { audio.volume = +vol.value; $('volIcon').textContent = +vol.value === 0 ? '🔇' : +vol.value < 0.5 ? '🔉' : '🔊'; vol.style.setProperty('--pr', vol.value * 100 + '%'); });
  vol.style.setProperty('--pr', '100%');

  /* ---------- download ---------- */
  function extFor(blob, url) {
    var t = (blob && blob.type || '').toLowerCase();
    var map = { 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/vnd.wave': 'wav', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/ogg': 'ogg', 'audio/flac': 'flac', 'audio/x-flac': 'flac', 'audio/webm': 'webm', 'audio/aac': 'aac', 'audio/mp4': 'm4a' };
    if (map[t]) return map[t];
    var m = /\.([a-z0-9]{2,5})(?:$|[?#])/i.exec(url || ''); if (m && /^(wav|mp3|ogg|flac|webm|aac|m4a)$/i.test(m[1])) return m[1].toLowerCase();
    return 'wav';
  }
  function stamp() { var d = new Date(), p = function (n) { return (n < 10 ? '0' : '') + n; }; return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()); }
  $('dlBtn').onclick = function () {
    if (!S.audioUrl) { showError('Generate audio first.'); return; }
    var ext = extFor(S.blob, S.audioUrl), name = 'khmer-tts-' + slug(S.lastVoice) + '-' + stamp() + '.' + ext;
    var a = document.createElement('a'); a.download = name; a.rel = 'noopener';
    if (S.objUrl) { a.href = S.objUrl; } else { a.href = S.audioUrl; a.target = '_blank'; }   // fallback when the browser could not fetch the file as a blob
    document.body.appendChild(a); a.click(); a.remove();
  };

  /* ---------- generation ---------- */
  function setBusy(b) {
    S.busy = b; $('genBtn').disabled = b; $('genBtn').classList.toggle('busy', b);
    $('genTxt').textContent = b ? 'Generating…' : 'Generate audio';
    $('cancelBtn').hidden = !b; $('prog').hidden = !b;
    [ta, $('style'), $('cfg'), $('steps'), $('seed'), $('pasteBtn'), $('clearBtn')].forEach(function (el) { el.disabled = b; });
    renderVoices();
    if (!b && S.timer) { clearInterval(S.timer); S.timer = null; }
  }
  function progress(txt) { $('progTxt').textContent = txt; }

  async function generate() {
    if (S.busy) return;                                   // no duplicate requests
    clearError();
    var text = ta.value.replace(/\s+$/g, '').replace(/^\s+/g, '');
    if (!text) { showError('Please type some Khmer text first. The text box is empty.'); ta.focus(); return; }
    var n = charCount(text);
    if (n > MAX_CHARS) { showError('The text is too long (' + n + ' characters). The Space accepts up to ' + MAX_CHARS + '. Please shorten it or split it into parts.'); return; }

    prevAudio.pause(); S.previewing = null; pauseMain();
    S.abort = new AbortController(); setBusy(true);
    var t0 = Date.now(), stage = 'Connecting to the Khmer voice engine…';
    progress(stage);
    S.timer = setInterval(function () { progress(stage + '  ' + Math.round((Date.now() - t0) / 1000) + 's'); }, 500);
    try {
      var c = await ensureClient();
      if (!c.hasEndpoint('clone') || !c.hasEndpoint('pick_voice')) throw new GradioError('protocol', 'The Space API no longer matches this page (missing "clone"/"pick_voice").');
      stage = 'Loading the voice…';
      var voice = S.voice, sample = await getSample(voice);
      stage = 'Waiting in the queue / starting the GPU (the first request can take up to a minute)…';
      var data = [text, $('style').value, sample.fd, sample.text, +$('cfg').value, +$('steps').value, Math.max(0, parseInt($('seed').value, 10) || 0)];
      var out = await c.call('clone', data, {
        signal: S.abort.signal, deadlineMs: 300000,
        onEvent: function (ev) { if (ev === 'generating') stage = 'Generating speech…'; }
      });
      stage = 'Receiving the audio…';
      var audioFd = Array.isArray(out) ? out[0] : null, note = Array.isArray(out) && out[1] ? String(out[1]) : '';
      var url = c.fileUrl(audioFd);
      if (!url) throw new GradioError('remote', note || 'The Space finished but returned no audio.');
      await loadResult(url, voice, note);
      setPill('ok', 'Space online');
    } catch (e) {
      var x = explain(e); if (!(e && e.code === 'aborted')) console.warn('[khmer-tts]', e); showError(x.msg, x.link);
      if (e && (e.code === 'unavailable' || e.code === 'network')) { S.client = null; checkSpace(); }
    } finally { setBusy(false); }
  }

  async function loadResult(url, voice, note) {
    var blob = null;
    try {
      var r = await fetch(url, { signal: S.abort && S.abort.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      blob = await r.blob();
    } catch (e) { blob = null; }                          // e.g. CORS: still playable through the plain URL
    if (blob) {
      var okType = !blob.type || /^audio\/|octet-stream/i.test(blob.type);
      if (blob.size < 1024 || !okType) throw new GradioError('invalid', 'The Space returned an empty or invalid audio file (' + blob.size + ' bytes). Please try again.');
      if (!/^audio\//i.test(blob.type)) blob = blob.slice(0, blob.size, 'audio/wav');
    }
    if (S.objUrl) { URL.revokeObjectURL(S.objUrl); S.objUrl = null; }
    S.blob = blob; S.audioUrl = url; S.lastVoice = voice;
    if (blob) S.objUrl = URL.createObjectURL(blob);
    audio.src = S.objUrl || url; audio.load();
    $('player').hidden = false; $('pInfo').textContent = voice + ' · ' + $('style').value + (note ? ' · ' + note.replace(/[*_`#]/g, '').slice(0, 80) : '');
    tick(); syncPlay();
    setTimeout(function () { $('player').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, 50);
    audio.play().catch(function () {});                   // autoplay may be blocked: the Play button still works
  }
  $('genBtn').onclick = generate;
  $('cancelBtn').onclick = function () { if (S.abort) S.abort.abort(); };

  /* ---------- advanced inputs ---------- */
  $('cfg').addEventListener('input', function () { $('cfgV').textContent = Number($('cfg').value).toFixed(1); sset('cfg', $('cfg').value); });
  $('steps').addEventListener('input', function () { $('stepsV').textContent = $('steps').value; sset('steps', $('steps').value); });
  $('style').addEventListener('change', function () { sset('style', $('style').value); });

  /* ---------- navigation / embedding ---------- */
  $('back').addEventListener('click', function (e) {
    if (embedded) { e.preventDefault(); try { window.parent.postMessage({ type: 'khmer-tts-back' }, location.origin); } catch (x) { location.href = '../'; } }
  });
  window.addEventListener('message', function (e) {
    if (e.origin !== location.origin || !e.data) return;
    if (e.data.type === 'khmer-tts-pause') { pauseMain(); prevAudio.pause(); S.previewing = null; renderVoices(); }
  });
  if (embedded && window.ResizeObserver) {
    var last = 0;
    new ResizeObserver(function () {
      var h = Math.ceil(document.documentElement.scrollHeight); if (Math.abs(h - last) < 2) return; last = h;
      try { window.parent.postMessage({ type: 'khmer-tts-height', height: h }, location.origin); } catch (x) {}
    }).observe(document.body);
  }

  /* ---------- init ---------- */
  S.voices = FALLBACK_VOICES.slice(); S.styles = FALLBACK_STYLES.slice();
  S.voice = sget('voice') || S.voices[0];
  if (sget('cfg')) $('cfg').value = sget('cfg'); if (sget('steps')) $('steps').value = sget('steps');
  $('cfgV').textContent = Number($('cfg').value).toFixed(1); $('stepsV').textContent = $('steps').value;
  renderVoices(); renderStyles(); syncPlay();
  var saved = sget('text'); if (saved) ta.value = saved;
  updateCount();
  checkSpace();
})();
