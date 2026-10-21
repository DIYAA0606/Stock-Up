// Stateless session tokens: HMAC-SHA256, base64url-encoded, no external deps.
// Format: <base64url(header)>.<base64url(payload)>.<base64url(sig)>
//
// Usage:
//   const token = signToken({ role: 'coordinator', coordId: 'coord-01' });
//   const payload = verifyToken(token); // throws on bad sig or expiry
//
// SESSION_SECRET env var must be set in production (Redis mode).
// Falls back to a random per-process secret in local/file mode so tests work.
import crypto from 'node:crypto';

let _secret = null;

function secret() {
  if (_secret) return _secret;
  const raw = process.env.SESSION_SECRET;
  if (raw) {
    _secret = Buffer.from(raw, 'utf8');
  } else {
    // Local/test: random per-process secret — tokens don't survive restarts.
    _secret = crypto.randomBytes(32);
  }
  return _secret;
}

const b64url = (buf) => buf.toString('base64url');
const fromB64url = (s) => Buffer.from(s, 'base64url');

const HEADER = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'GTG' })));

/** Sign a payload object. Expiry defaults to 12 hours from now. */
export function signToken(payload, { expiresInSec = 12 * 3600 } = {}) {
  const exp = payload.exp !== undefined ? payload.exp : (Math.floor(Date.now() / 1000) + expiresInSec);
  const p = { iat: Math.floor(Date.now() / 1000), ...payload, exp };
  const body = HEADER + '.' + b64url(Buffer.from(JSON.stringify(p)));
  const sig = b64url(crypto.createHmac('sha256', secret()).update(body).digest());
  return body + '.' + sig;
}

/**
 * Verify a token string.
 * Returns the decoded payload object if valid.
 * Throws an Error (with .status = 401) if the signature is wrong or the token is expired.
 */
export function verifyToken(token) {
  if (!token || typeof token !== 'string') throw _err('Missing token');
  const parts = token.split('.');
  if (parts.length !== 3) throw _err('Malformed token');
  const [header, payloadB64, sigB64] = parts;
  const body = header + '.' + payloadB64;
  const expected = b64url(crypto.createHmac('sha256', secret()).update(body).digest());
  // Constant-time compare to prevent timing attacks.
  if (!timingSafeEqual(expected, sigB64)) throw _err('Invalid token signature');
  let payload;
  try {
    payload = JSON.parse(fromB64url(payloadB64).toString('utf8'));
  } catch {
    throw _err('Malformed token payload');
  }
  if (!payload.exp || Math.floor(Date.now() / 1000) > payload.exp) throw _err('Token expired');
  return payload;
}

/**
 * Constant-time string comparison (prevents timing-based signature extraction).
 * Both inputs should be base64url strings of equal expected length.
 */
export function timingSafeEqual(a, b) {
  const ab = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  // Pad to same length to avoid early-exit on length mismatch leaking info.
  const len = Math.max(ab.length, bb.length);
  const pa = Buffer.alloc(len);
  const pb = Buffer.alloc(len);
  ab.copy(pa);
  bb.copy(pb);
  return crypto.timingSafeEqual(pa, pb) && ab.length === bb.length;
}

/**
 * Hash a PIN string for storage (SHA-256).
 * Pins are short so we don't need bcrypt — the rate limiter is the real defence.
 */
export function hashPin(pin) {
  return crypto.createHash('sha256').update(String(pin)).digest('hex');
}

/**
 * Verify a submitted PIN against a stored hash using constant-time compare.
 */
export function checkPin(submitted, storedHash) {
  const h = crypto.createHash('sha256').update(String(submitted)).digest('hex');
  return timingSafeEqual(h, storedHash);
}

// Shared error factory — sets status = 401 so server.js can use it directly.
function _err(msg) {
  const e = new Error(msg);
  e.status = 401;
  return e;
}
