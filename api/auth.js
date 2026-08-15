const { createSessionToken, setSessionCookie } = require('../lib/auth');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { password } = req.body || {};
    const correctPassword = process.env.DASHBOARD_PASSWORD;

    if (!password || !correctPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (password !== correctPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = createSessionToken(correctPassword);
    setSessionCookie(res, token);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Auth error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
};
