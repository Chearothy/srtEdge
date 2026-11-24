/* GradioLite - tiny dependency-free client for a public Gradio (4/5/6) Space.
 * Uses only the documented HTTP API:
 *   GET  {base}/config                              -> endpoints + component info
 *   POST {base}{prefix}/call/{api_name}             -> {event_id}
 *   GET  {base}{prefix}/call/{api_name}/{event_id}  -> Server-Sent Events (queue-aware)
 * No token is used or needed for public Spaces. */
(function (root) {
  'use strict';

  class GradioError extends Error {
    constructor(code, message, extra) { super(message); this.name = 'GradioError'; this.code = code; Object.assign(this, extra || {}); }
  }

  // fetch with a timeout for the response headers, plus an optional external abort signal.
  async function tfetch(url, opt, ms) {
    opt = opt || {};
    const ctl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, ms || 30000);
    const ext = opt.signal;
    const onAbort = () => ctl.abort();
    if (ext) { if (ext.aborted) ctl.abort(); else ext.addEventListener('abort', onAbort, { once: true }); }
    try {
      return await fetch(url, Object.assign({}, opt, { signal: ctl.signal }));
    } catch (e) {
      if (timedOut) throw new GradioError('timeout', 'The request timed out.');
      if (ext && ext.aborted) throw new GradioError('aborted', 'Cancelled.');
      throw new GradioError('network', 'Network error or the server blocked the request (CORS).', { cause: e });
    } finally {
      clearTimeout(timer);
      if (ext) ext.removeEventListener('abort', onAbort);
    }
  }

  function GradioLite(base) {
    this.base = String(base).replace(/\/+$/, '');
    this.prefix = '/gradio_api';
    this.config = null;
  }

  // Load /config and make sure this really is a Gradio app that is awake.
  GradioLite.prototype.connect = async function (signal) {
    const r = await tfetch(this.base + '/config', { signal: signal, headers: { Accept: 'application/json' } }, 20000);
    const ct = r.headers.get('content-type') || '';
    if (!r.ok || ct.indexOf('json') === -1) {
      throw new GradioError('unavailable', 'The Space did not return its API configuration (HTTP ' + r.status + '). It may be sleeping, starting or stopped.', { status: r.status });
    }
    let cfg;
    try { cfg = await r.json(); } catch (e) { throw new GradioError('unavailable', 'The Space returned an invalid configuration.'); }
    if (!cfg || !Array.isArray(cfg.dependencies)) throw new GradioError('unavailable', 'The Space is not a Gradio app.');
    this.config = cfg;
    if (typeof cfg.api_prefix === 'string' && cfg.api_prefix) this.prefix = cfg.api_prefix;
    return cfg;
  };

  GradioLite.prototype.hasEndpoint = function (name) {
    return !!this.config && this.config.dependencies.some(function (d) { return d.api_name === name; });
  };

  // Find a component by id in the loaded config.
  GradioLite.prototype.component = function (id) {
    if (!this.config) return null;
    return this.config.components.find(function (c) { return c.id === id; }) || null;
  };

  // Return the component that feeds input #index of endpoint apiName.
  GradioLite.prototype.inputComponent = function (apiName, index) {
    if (!this.config) return null;
    const dep = this.config.dependencies.find(function (d) { return d.api_name === apiName; });
    if (!dep || dep.inputs[index] == null) return null;
    return this.component(dep.inputs[index]);
  };

  GradioLite.prototype.fileUrl = function (fd) {
    if (!fd) return null;
    if (typeof fd === 'string') return fd;
    if (fd.url) return fd.url;
    if (fd.path) return this.base + this.prefix + '/file=' + fd.path;
    return null;
  };

  // Call a named endpoint. opts: {signal, deadlineMs, onEvent(name, payload)}
  GradioLite.prototype.call = async function (apiName, data, opts) {
    opts = opts || {};
    const url = this.base + this.prefix + '/call/' + apiName;
    const ctl = new AbortController();
    const ext = opts.signal;
    if (ext) { if (ext.aborted) throw new GradioError('aborted', 'Cancelled.'); ext.addEventListener('abort', function () { ctl.abort(); }, { once: true }); }
    let deadlineHit = false;
    const deadline = setTimeout(function () { deadlineHit = true; ctl.abort(); }, opts.deadlineMs || 240000);

    try {
      const post = await tfetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: data }), signal: ctl.signal
      }, 30000);
      if (!post.ok) throw await httpError(post);
      const j = await post.json();
      if (!j || !j.event_id) throw new GradioError('protocol', 'The Space did not return an event id.');

      const res = await tfetch(url + '/' + j.event_id, { headers: { Accept: 'text/event-stream' }, signal: ctl.signal }, 30000);
      if (!res.ok) throw await httpError(res);
      if (!res.body || !res.body.getReader) throw new GradioError('protocol', 'Streaming is not supported by this browser.');

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        let chunk;
        try { chunk = await reader.read(); }
        catch (e) {
          if (deadlineHit) throw new GradioError('timeout', 'Generation took too long and was stopped.');
          if (ext && ext.aborted) throw new GradioError('aborted', 'Cancelled.');
          throw new GradioError('network', 'The connection was interrupted.');
        }
        if (chunk.done) break;
        buf += dec.decode(chunk.value, { stream: true }).replace(/\r\n/g, '\n');
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, idx); buf = buf.slice(idx + 2);
          const ev = parseBlock(block);
          if (!ev) continue;
          if (opts.onEvent) { try { opts.onEvent(ev.event, ev.data); } catch (e) { /* ignore UI errors */ } }
          if (ev.event === 'complete') { try { reader.cancel(); } catch (e) {} return ev.data; }
          if (ev.event === 'error') throw new GradioError('remote', remoteMessage(ev.data), { raw: ev.data });
        }
      }
      if (deadlineHit) throw new GradioError('timeout', 'Generation took too long and was stopped.');
      throw new GradioError('protocol', 'The Space closed the connection before returning a result.');
    } catch (e) {
      if (e instanceof GradioError) {
        if (deadlineHit && (e.code === 'aborted' || e.code === 'network')) throw new GradioError('timeout', 'Generation took too long and was stopped.');
        throw e;
      }
      throw new GradioError('network', e && e.message || 'Unknown network error');
    } finally { clearTimeout(deadline); }
  };

  function parseBlock(block) {
    let event = 'message'; const dataLines = [];
    block.split('\n').forEach(function (l) {
      if (l.indexOf('event:') === 0) event = l.slice(6).trim();
      else if (l.indexOf('data:') === 0) dataLines.push(l.slice(5).replace(/^ /, ''));
    });
    if (!dataLines.length && event === 'message') return null;
    let data = dataLines.join('\n');
    try { data = JSON.parse(data); } catch (e) { /* keep as text */ }
    return { event: event, data: data };
  }

  function remoteMessage(d) {
    if (typeof d === 'string' && d) return d;
    if (d && typeof d === 'object') return d.error || d.message || d.title || JSON.stringify(d);
    return 'The Space reported an error but gave no details.';
  }

  async function httpError(r) {
    let t = ''; try { t = (await r.text()).slice(0, 300); } catch (e) {}
    return new GradioError('http', 'The Space answered HTTP ' + r.status + (t ? ': ' + t.replace(/\s+/g, ' ') : ''), { status: r.status });
  }

  root.GradioLite = GradioLite;
  root.GradioError = GradioError;
})(window);
