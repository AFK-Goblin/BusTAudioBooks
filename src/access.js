// src/access.js
// Optional shared-secret gate for a shared instance. Set ACCESS_TOKENS (a
// comma-separated list) in the environment; each user's install URL must then
// carry a matching token or every request is rejected. Using a list means you
// can hand each friend their own token and revoke one without disturbing others.
const crypto = require("crypto");

function tokensFromEnv(env = process.env) {
  return String(env.ACCESS_TOKENS || env.ACCESS_TOKEN || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Constant-time-ish compare (length is allowed to leak; contents are not).
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  try {
    return crypto.timingSafeEqual(ba, bb);
  } catch (_) {
    return false;
  }
}

function makeAccess(env = process.env) {
  const tokens = tokensFromEnv(env);
  return {
    required: tokens.length > 0,
    valid(token) {
      if (tokens.length === 0) return true; // gate disabled
      if (!token) return false;
      return tokens.some((t) => safeEqual(t, token));
    },
  };
}

module.exports = { makeAccess, tokensFromEnv, safeEqual };
