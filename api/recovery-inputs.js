// api/recovery-inputs.js — Vercel serverless proxy
// Forwards to Oil Monitor public endpoint. No key required.

export default async function handler(req, res) {
  try {
    const upstream = await fetch(
      'https://oil-midstream-monitor.vercel.app/api/recovery-inputs'
    );

    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: 'Upstream error' });
    }

    const data = await upstream.json();

    // CDN cache 1 hour, stale-while-revalidate 6 hours
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=21600');
    return res.status(200).json(data);
  } catch (err) {
    return res.status(502).json({ error: 'Failed to reach Oil Monitor' });
  }
}
