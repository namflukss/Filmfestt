// ─────────────────────────────────────────────────────────────────────────────
// Frame + Prompt — Anthropic API Proxy
// Deploy this to Vercel. Set ANTHROPIC_API_KEY in your Vercel env variables.
//
// Rate limiting:
//   - 10 requests per IP per minute (soft protection)
//   - 50 requests per IP per day
//   - Requests over the limit get a 429 response
//
// CORS:
//   - Update ALLOWED_ORIGINS to match your Framer domain(s)
// ─────────────────────────────────────────────────────────────────────────────

// ── CONFIG ────────────────────────────────────────────────────────────────────

const ALLOWED_ORIGINS = [
  "https://frameprompt.com",
  "https://www.frameprompt.com",
  "https://itsawrapai.framer.website",  // ← add this
];

const RATE_LIMIT_PER_MINUTE = 10;  // max requests per IP per minute
const RATE_LIMIT_PER_DAY    = 50;  // max requests per IP per day
const MAX_TOKENS            = 1500; // cap tokens per request (controls cost)

// ── IN-MEMORY RATE LIMIT STORE ────────────────────────────────────────────────
// Note: This resets on every cold start. For stricter limits across instances,
// swap this out for Vercel KV (free tier available).

const rateLimitStore = new Map();

function getRateLimitEntry(ip) {
  const now = Date.now();
  const entry = rateLimitStore.get(ip) || {
    minuteCount: 0,
    minuteStart: now,
    dayCount: 0,
    dayStart: now,
  };

  // Reset minute window
  if (now - entry.minuteStart > 60 * 1000) {
    entry.minuteCount = 0;
    entry.minuteStart = now;
  }

  // Reset day window
  if (now - entry.dayStart > 24 * 60 * 60 * 1000) {
    entry.dayCount = 0;
    entry.dayStart = now;
  }

  return entry;
}

function checkRateLimit(ip) {
  const entry = getRateLimitEntry(ip);

  if (entry.minuteCount >= RATE_LIMIT_PER_MINUTE) {
    return { allowed: false, reason: "Too many requests. Please wait a moment." };
  }
  if (entry.dayCount >= RATE_LIMIT_PER_DAY) {
    return { allowed: false, reason: "Daily limit reached. Come back tomorrow." };
  }

  entry.minuteCount++;
  entry.dayCount++;
  rateLimitStore.set(ip, entry);

  return { allowed: true };
}

// ── MAIN HANDLER ──────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  const origin = req.headers.origin || "";

  // ── CORS headers
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else {
    // Allow Framer preview subdomains (*.framer.app) during development
    if (origin.endsWith(".framer.app") || origin.endsWith(".framer.website")) {
      res.setHeader("Access-Control-Allow-Origin", origin);
    }
  }

  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Vary", "Origin");

  // ── Preflight
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // ── Only allow POST
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // ── Get IP for rate limiting
  const ip =
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    "unknown";

  // ── Rate limit check
  const limit = checkRateLimit(ip);
  if (!limit.allowed) {
    return res.status(429).json({ error: limit.reason });
  }

  // ── Validate API key is set
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is not set");
    return res.status(500).json({ error: "Server configuration error" });
  }

  // ── Validate request body
  const body = req.body;
  if (!body || !body.messages || !Array.isArray(body.messages)) {
    return res.status(400).json({ error: "Invalid request body" });
  }

  // ── Safety: enforce max_tokens cap (prevent runaway costs)
  const safeBody = {
    ...body,
    model: "claude-sonnet-4-20250514", // always pin the model server-side
    max_tokens: Math.min(body.max_tokens || MAX_TOKENS, MAX_TOKENS),
  };

  // ── Forward to Anthropic
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(safeBody),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("Anthropic API error:", data);
      return res.status(response.status).json({
        error: data?.error?.message || "Anthropic API error",
      });
    }

    return res.status(200).json(data);

  } catch (err) {
    console.error("Proxy error:", err);
    return res.status(500).json({ error: "Proxy server error" });
  }
}
