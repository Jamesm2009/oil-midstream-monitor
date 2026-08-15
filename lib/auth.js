const crypto = require('crypto');

const TOKEN_NAME = 'osm_session';
const TOKEN_MAX_AGE = 60 * 60 * 24 * 7; // 7 days

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Simple HMAC-based token verification
// Token format: random:hmac(random, password)
function createSessionToken(password) {
  const random = crypto.randomBytes(16).toString('hex');
  const hmac = crypto.createHmac('sha256', password).update(random).digest('hex');
  return `${random}:${hmac}`;
}

function verifySessionToken(token, password) {
  if (!token || !password) return false;
  const parts = token.split(':');
  if (parts.length !== 2) return false;
  const [random, providedHmac] = parts;
  const expectedHmac = crypto.createHmac('sha256', password).update(random).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(providedHmac, 'hex'), Buffer.from(expectedHmac, 'hex'));
}

function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie', [
    `${TOKEN_NAME}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${TOKEN_MAX_AGE}`,
  ]);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', [
    `${TOKEN_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`,
  ]);
}

function getSessionFromRequest(req) {
  const cookies = req.headers.cookie || '';
  const match = cookies.split(';').find(c => c.trim().startsWith(`${TOKEN_NAME}=`));
  if (!match) return null;
  return match.split('=')[1].trim();
}

function requireAuth(req, res) {
  const token = getSessionFromRequest(req);
  const password = process.env.DASHBOARD_PASSWORD;
  if (!token || !verifySessionToken(token, password)) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

module.exports = {
  createSessionToken,
  verifySessionToken,
  setSessionCookie,
  clearSessionCookie,
  getSessionFromRequest,
  requireAuth,
};
