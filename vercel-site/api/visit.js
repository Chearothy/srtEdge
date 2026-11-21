/* Vercel serverless function: unique-device visitor counter.
   GET  /api/visit  -> { count, live }            (read the number)
   POST /api/visit  -> counts this device once    (the page sends POST only the first time a device opens it)
   Storage: Upstash Redis (free) added from Vercel → Storage / Marketplace. Env vars are injected automatically:
   KV_REST_API_URL + KV_REST_API_TOKEN   (or UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN)
   Optional env var COUNT_BASE = number to start from (default 0, so the first device shows 1).
   Open /api/visit?debug=1 on your site to check the connection. */
const crypto = require('crypto');
function findEnv() {   // works with any Upstash / Vercel KV prefix (KV_, UPSTASH_, STORAGE_ ...)
  let url, token;
  for (const k of Object.keys(process.env)) {
    if (!url && /(REST_API_URL|REDIS_REST_URL|REST_URL)$/.test(k) && /^https?:/.test(process.env[k])) url = process.env[k];
    if (!token && /(REST_API_TOKEN|REDIS_REST_TOKEN|REST_TOKEN)$/.test(k) && !/READ_ONLY/.test(k)) token = process.env[k];
  }
  return { url, token };
}
const { url: URL_, token: TOKEN } = findEnv();
const BASE = Number.isFinite(parseInt(process.env.COUNT_BASE, 10)) ? parseInt(process.env.COUNT_BASE, 10) : 0;   // starts from 0 -> first device = 1
const KEY = 'kd:users';
const MAX_PER_IP_PER_HOUR = 30;   // stops one source from inflating the number

async function redis(cmds) {
  const r = await fetch(URL_.replace(/\/$/, '') + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds)
  });
  if (!r.ok) throw new Error('redis ' + r.status);
  return (await r.json()).map(x => { if (x.error) throw new Error(x.error); return x.result; });
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method not allowed' });
  }
  if (req.query && req.query.debug) {
    let redisStatus = 'not tested';
    try { if (URL_ && TOKEN) redisStatus = (await redis([['PING']]))[0] === 'PONG' ? 'OK (connected)' : 'unexpected reply'; } catch (e) { redisStatus = 'ERROR: ' + e.message; }
    return res.status(200).json({ function: 'running', storageEnvFound: !!(URL_ && TOKEN), redis: redisStatus, envNamesSeen: Object.keys(process.env).filter(k => /KV_|UPSTASH|REDIS|STORAGE/i.test(k)) });
  }
  if (!URL_ || !TOKEN) return res.status(200).json({ count: BASE, live: false, why: 'no-storage: connect Upstash Redis to this Vercel project, then redeploy' });
  try {
    let n;
    const ua = String(req.headers['user-agent'] || '');
    const seen = /(?:^|;\s*)kd_vid=/.test(String(req.headers.cookie || ''));
    const bot = !ua || /bot|crawl|spider|slurp|headless|lighthouse|preview|curl|wget|python|node-fetch/i.test(ua);
    if (req.method === 'POST' && !bot) {
      if (!seen) {
        const ip = String(req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || '').split(',')[0].trim();
        const h = crypto.createHash('sha256').update(ip + '|kd').digest('hex').slice(0, 24);
        const k = 'kd:rl:' + h + ':' + Math.floor(Date.now() / 3.6e6);
        const [c] = await redis([['INCR', k], ['EXPIRE', k, '3600']]);
        if (c <= MAX_PER_IP_PER_HOUR) [n] = await redis([['INCR', KEY]]);
      }
      // remember this device for a year so a cleared localStorage does not count it twice
      res.setHeader('Set-Cookie', 'kd_vid=' + crypto.randomBytes(8).toString('hex') + '; Max-Age=31536000; Path=/; SameSite=Lax; HttpOnly; Secure');
    }
    if (n === undefined) [n] = await redis([['GET', KEY]]);
    return res.status(200).json({ count: BASE + (parseInt(n, 10) || 0), live: true });
  } catch (e) {
    return res.status(200).json({ count: BASE, live: false, why: 'redis-error: ' + e.message });
  }
};
