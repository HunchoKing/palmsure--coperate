// File: api/send-email.js
// Vercel serverless function that emails website enquiries (contact form and
// quote requests) to Palmsure via Resend.
//
// Security measures (see PR "Phase 1: security"):
//  - CORS only for the Palmsure domains (and same-origin requests, so Vercel
//    preview deployments keep working).
//  - POST only (plus the OPTIONS pre-flight that browsers send).
//  - Every field is validated, trimmed and length-limited.
//  - All user input is HTML-escaped before it goes into the email body.
//  - A hidden "website" honeypot field catches bots.
//  - Basic per-IP rate limiting.
const { Resend } = require('resend');

// Created on first use, so a missing key gives a clear log message
// instead of crashing the function when it loads.
let resendClient = null;
function getResend() {
  if (!process.env.RESEND_API_KEY) return null;
  if (!resendClient) resendClient = new Resend(process.env.RESEND_API_KEY);
  return resendClient;
}

const ALLOWED_ORIGINS = ['https://www.palmsure.co.za', 'https://palmsure.co.za'];

// Rate limit: at most RATE_LIMIT_MAX submissions per IP per RATE_LIMIT_WINDOW_MS.
// NOTE: this lives in the memory of one function instance. Vercel may run
// several instances, each with its own counter, so this is a basic safeguard,
// not a hard guarantee. Use a Vercel Firewall rate-limit rule for a hard limit.
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const rateLimitStore = new Map();

const QUOTE_TYPES = ['property', 'vehicle', 'business'];

const LIMITS = {
  name: 100,
  email: 254,
  phone: 30,
  message: 2000,
  text: 200,
};

const EMAIL_PATTERN = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/;
// Same characters the quote form allows on screen.
const PHONE_PATTERN = /^[0-9+\-\s()]+$/;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Turns characters that mean something in HTML into harmless text. */
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Removes line breaks and control characters (used for the subject line). */
function singleLine(value) {
  return String(value).replace(/[\u0000-\u001F\u007F]+/g, ' ').trim();
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Validates one text field. Returns the trimmed value, or throws a
 * ValidationError with a short reason.
 */
function text(value, field, { max, required = true, pattern } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new ValidationError(`${field} is required`);
    return '';
  }
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new ValidationError(`${field} must be text`);
  }
  const trimmed = String(value).trim();
  if (required && trimmed.length === 0) throw new ValidationError(`${field} is required`);
  if (trimmed.length > max) throw new ValidationError(`${field} is too long`);
  if (pattern && trimmed.length > 0 && !pattern.test(trimmed)) {
    throw new ValidationError(`${field} is not valid`);
  }
  return trimmed;
}

/** Validates a number within a range (whole numbers only unless decimals is true). */
function integer(value, field, { min, max, decimals = false }) {
  const asText = text(value, field, { max: 15 });
  const pattern = decimals ? /^\d+(\.\d{1,2})?$/ : /^\d+$/;
  if (!pattern.test(asText)) throw new ValidationError(`${field} must be a number`);
  const number = Number(asText);
  if (number < min || number > max) throw new ValidationError(`${field} is out of range`);
  return number;
}

class ValidationError extends Error {}

function validateContact(data) {
  if (!isPlainObject(data)) throw new ValidationError('data is missing');
  return {
    fullName: text(data.fullName, 'fullName', { max: LIMITS.name }),
    email: text(data.email, 'email', { max: LIMITS.email, pattern: EMAIL_PATTERN }),
    // The contact form does not check the phone format on screen, so only the
    // length is checked here; a strict check would silently lose enquiries.
    contactNumber: text(data.contactNumber, 'contactNumber', { max: LIMITS.phone }),
    message: text(data.message, 'message', { max: LIMITS.message }),
  };
}

function validateQuote(data) {
  if (!isPlainObject(data)) throw new ValidationError('data is missing');
  if (!QUOTE_TYPES.includes(data.type)) throw new ValidationError('type is not valid');
  if (!isPlainObject(data.personal)) throw new ValidationError('personal details are missing');

  const p = data.personal;
  const personal = {
    firstName: text(p.firstName, 'firstName', { max: LIMITS.name }),
    lastName: text(p.lastName, 'lastName', { max: LIMITS.name }),
    email: text(p.email, 'email', { max: LIMITS.email, pattern: EMAIL_PATTERN }),
    phone: text(p.phone, 'phone', { max: LIMITS.phone, pattern: PHONE_PATTERN }),
  };

  const d = isPlainObject(data.details) ? data.details : {};
  let details;
  if (data.type === 'property') {
    details = {
      propertyAddress: text(d.propertyAddress, 'propertyAddress', { max: LIMITS.text }),
      propertyValue: integer(d.propertyValue, 'propertyValue', {
        min: 1,
        max: 1000000000,
        decimals: true,
      }),
    };
  } else if (data.type === 'vehicle') {
    details = {
      vehicleMake: text(d.vehicleMake, 'vehicleMake', { max: LIMITS.text }),
      vehicleModel: text(d.vehicleModel, 'vehicleModel', { max: LIMITS.text }),
      vehicleYear: integer(d.vehicleYear, 'vehicleYear', {
        min: 1950,
        max: new Date().getFullYear() + 1,
      }),
    };
  } else {
    details = {
      businessName: text(d.businessName, 'businessName', { max: LIMITS.text }),
      industry: text(d.industry, 'industry', { max: LIMITS.text }),
      numEmployees: integer(d.numEmployees, 'numEmployees', { min: 1, max: 1000000 }),
    };
  }

  return { type: data.type, personal, details };
}

function buildContactEmail(c) {
  const e = escapeHtml;
  return {
    subject: singleLine(`New Web Inquiry: ${c.fullName}`),
    replyTo: c.email,
    html: `
      <h2>New Contact Message</h2>
      <p><strong>Name:</strong> ${e(c.fullName)}</p>
      <p><strong>Email:</strong> ${e(c.email)}</p>
      <p><strong>Phone:</strong> ${e(c.contactNumber)}</p>
      <p><strong>Message:</strong></p>
      <blockquote style="background: #f9f9f9; padding: 10px; white-space: pre-wrap;">${e(c.message)}</blockquote>
    `,
  };
}

function buildQuoteEmail(q) {
  const e = escapeHtml;
  const { personal: p, details: d } = q;

  let specificDetailsHtml = '';
  if (q.type === 'property') {
    specificDetailsHtml = `<p><strong>Address:</strong> ${e(d.propertyAddress)}</p><p><strong>Value:</strong> R${e(d.propertyValue)}</p>`;
  } else if (q.type === 'vehicle') {
    specificDetailsHtml = `<p><strong>Vehicle:</strong> ${e(d.vehicleYear)} ${e(d.vehicleMake)} ${e(d.vehicleModel)}</p>`;
  } else if (q.type === 'business') {
    specificDetailsHtml = `<p><strong>Business:</strong> ${e(d.businessName)}</p><p><strong>Industry:</strong> ${e(d.industry)}</p><p><strong>Employees:</strong> ${e(d.numEmployees)}</p>`;
  }

  return {
    subject: singleLine(`New Quote Request (${q.type}) - ${p.firstName} ${p.lastName}`),
    replyTo: p.email,
    html: `
      <h2>New Quote Request</h2>
      <p><strong>Name:</strong> ${e(p.firstName)} ${e(p.lastName)}</p>
      <p><strong>Email:</strong> ${e(p.email)}</p>
      <p><strong>Phone:</strong> ${e(p.phone)}</p>
      <hr>
      ${specificDetailsHtml}
    `,
  };
}

/** True if the request comes from the site itself (e.g. a Vercel preview URL). */
function isSameOrigin(req, origin) {
  try {
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    return Boolean(host) && new URL(origin).host === host;
  } catch {
    return false;
  }
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown';
}

/** Returns true if this IP has used up its allowance. */
function isRateLimited(ip, now = Date.now()) {
  // Forget old entries so the map cannot grow without limit.
  for (const [key, entry] of rateLimitStore) {
    if (now - entry.start > RATE_LIMIT_WINDOW_MS) rateLimitStore.delete(key);
  }
  const entry = rateLimitStore.get(ip);
  if (!entry) {
    rateLimitStore.set(ip, { start: now, count: 1 });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_LIMIT_MAX;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

module.exports = async function handler(req, res) {
  const origin = req.headers.origin;
  const originAllowed = !origin || ALLOWED_ORIGINS.includes(origin) || isSameOrigin(req, origin);

  res.setHeader('Vary', 'Origin');
  if (origin && originAllowed) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
  }

  if (req.method === 'OPTIONS') {
    return res.status(originAllowed ? 204 : 403).end();
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ message: 'Method not allowed' });
  }

  if (!originAllowed) {
    return res.status(403).json({ message: 'Forbidden' });
  }

  const body = req.body;
  if (!isPlainObject(body)) {
    return res.status(400).json({ message: 'Invalid request' });
  }

  // Honeypot: real visitors never see or fill in the "website" field.
  // Pretend it worked so bots do not learn they were caught.
  const honeypot = isPlainObject(body.data) ? body.data.website : undefined;
  if (honeypot !== undefined && honeypot !== null && String(honeypot).trim() !== '') {
    return res.status(200).json({ ok: true });
  }

  if (isRateLimited(getClientIp(req))) {
    res.setHeader('Retry-After', String(Math.ceil(RATE_LIMIT_WINDOW_MS / 1000)));
    return res.status(429).json({ message: 'Too many requests. Please try again later.' });
  }

  let email;
  try {
    if (body.type === 'contact') {
      email = buildContactEmail(validateContact(body.data));
    } else if (body.type === 'quote') {
      email = buildQuoteEmail(validateQuote(body.data));
    } else {
      throw new ValidationError('type is not valid');
    }
  } catch (error) {
    if (error instanceof ValidationError) {
      return res.status(400).json({ message: 'Invalid request', field: error.message });
    }
    throw error;
  }

  // Safe default for recipients if env vars are missing
  const contactEmail = process.env.PALMSURE_CONTACT_EMAIL || 'info@palmsure.co.za';
  const adminEmail = process.env.PALMSURE_ADMIN_EMAIL || 'roy@palmsure.co.za';

  const resend = getResend();
  if (!resend) {
    console.error('Resend Error: RESEND_API_KEY is not set');
    return res.status(500).json({ message: 'Could not send your message. Please call us.' });
  }

  try {
    // Resend reports failures in `error` instead of throwing.
    const { error } = await resend.emails.send({
      from: 'Palmsure Website <info@palmsure.co.za>',
      to: [contactEmail, adminEmail],
      subject: email.subject,
      html: email.html,
      replyTo: email.replyTo,
    });
    if (error) throw error;

    return res.status(200).json({ ok: true });
  } catch (error) {
    // Details go to the Vercel logs only, never to the browser.
    console.error('Resend Error:', error);
    return res.status(500).json({ message: 'Could not send your message. Please call us.' });
  }
};

// Exposed for automated tests only.
module.exports._test = { escapeHtml, rateLimitStore, RATE_LIMIT_MAX };
