// Vercel serverless function: counts each new device once and returns the total.
// Needs a free Upstash Redis database connected to the Vercel project (Storage tab).
const BASE = 3124;                 // number shown before any new visitor is counted
const KEY = 'khmer-dubber:devices';

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return res.status(200).json({ count: BASE, live: false, why: 'storage not connected (add Upstash Redis in Vercel → Storage, then redeploy)' });
  try {
    const ua = req.headers['user-agent'] || '';
    const bot = /bot|crawl|spider|preview|curl|wget|headless|lighthouse/i.test(ua);
    const op = req.method === 'POST' && !bot ? 'incr' : 'get';   // only a real first visit counts
    const r = await fetch(`${url}/${op}/${KEY}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error('storage returned HTTP ' + r.status);
    const j = await r.json();
    res.status(200).json({ count: BASE + (Number(j.result) || 0), live: true });
  } catch (e) {
    res.status(200).json({ count: BASE, live: false, why: String(e.message || e) });
  }
};
