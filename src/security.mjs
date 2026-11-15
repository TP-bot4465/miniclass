import crypto from 'node:crypto';
import path from 'node:path';

/**
 * Password Policy Validation (NFR-06):
 * At least 8 characters, containing both letters and numbers.
 */
export function validatePasswordStrength(password) {
  if (typeof password !== 'string' || password.length < 8) {
    return { valid: false, reason: 'PASSWORD_TOO_SHORT' };
  }
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    return { valid: false, reason: 'PASSWORD_MISSING_ALPHANUM' };
  }
  return { valid: true };
}

/**
 * Hash password using Argon2id (Node 26 built-in crypto.argon2Sync) with scrypt fallback (NFR-06).
 */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  if (typeof crypto.argon2Sync === 'function') {
    const derived = crypto.argon2Sync('argon2id', {
      message: Buffer.from(password, 'utf8'),
      nonce: salt,
      parallelism: 1,
      tagLength: 32,
      memory: 19456,
      passes: 2
    });
    return `argon2id$${salt.toString('hex')}$${Buffer.from(derived).toString('hex')}`;
  }
  const derived = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

/**
 * Verify password against stored hash (timing-safe comparison).
 */
export function verifyPassword(password, storedHash) {
  if (!storedHash || typeof storedHash !== 'string') return false;
  const parts = storedHash.split('$');
  if (parts.length !== 3) return false;
  const [algo, saltHex, hashHex] = parts;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');

  if (algo === 'argon2id' && typeof crypto.argon2Sync === 'function') {
    const actual = Buffer.from(
      crypto.argon2Sync('argon2id', {
        message: Buffer.from(password, 'utf8'),
        nonce: salt,
        parallelism: 1,
        tagLength: expected.length,
        memory: 19456,
        passes: 2
      })
    );
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  }
  if (algo === 'scrypt') {
    const actual = crypto.scryptSync(password, salt, expected.length);
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  }
  return false;
}

/**
 * Generate a secure random temporary password meeting NFR-06 requirements (USR-05).
 */
export function generateTempPassword() {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ';
  const digits = '23456789';
  let pass = '';
  for (let i = 0; i < 6; i++) {
    pass += chars[crypto.randomInt(0, chars.length)];
  }
  for (let i = 0; i < 4; i++) {
    pass += digits[crypto.randomInt(0, digits.length)];
  }
  return pass;
}

/**
 * Generate random session token & CSRF token.
 */
export function generateToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

/**
 * Validate score per BR-09 & GRD-05:
 * Number from 0 to 10, at most 1 decimal place (e.g., 8.5 valid, 7.25 invalid, 11 invalid).
 */
export function validateScore(scoreInput) {
  if (scoreInput === null || scoreInput === undefined || scoreInput === '') {
    return { valid: true, value: null };
  }
  const str = String(scoreInput).trim();
  if (!/^\d+(\.\d+)?$/.test(str)) {
    return { valid: false, reason: 'INVALID_SCORE_FORMAT' };
  }
  const parts = str.split('.');
  if (parts[1] && parts[1].length > 1) {
    return { valid: false, reason: 'SCORE_MAX_ONE_DECIMAL' };
  }
  const num = Number(str);
  if (Number.isNaN(num) || num < 0 || num > 10) {
    return { valid: false, reason: 'SCORE_OUT_OF_RANGE' };
  }
  return { valid: true, value: Math.round(num * 10) / 10 };
}

/**
 * File validation helper (NFR-08, SUB-01, SUB-02, SUB-03, SES-03, SES-04)
 */
const DISALLOWED_MIME_PREFIXES = [
  'application/x-msdownload',
  'application/x-executable',
  'application/x-dosexec',
  'application/x-msdos-program',
  'application/x-sh',
  'application/x-bat'
];

export function validateUploadedFile({
  originalName,
  mimeType,
  buffer,
  allowedExtensions,
  maxSizeBytes,
  requireImageMagic = false
}) {
  if (!originalName || typeof originalName !== 'string') {
    return { valid: false, code: 'FILE_NAME_MISSING' };
  }
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { valid: false, code: 'FILE_EMPTY' };
  }
  if (buffer.length > maxSizeBytes) {
    return {
      valid: false,
      code: 'FILE_TOO_LARGE',
      maxSizeMB: Math.round((maxSizeBytes / (1024 * 1024)) * 10) / 10
    };
  }

  const ext = path.extname(originalName).replace(/^\./, '').toLowerCase();
  if (!ext || !allowedExtensions.includes(ext)) {
    return {
      valid: false,
      code: 'FILE_EXTENSION_NOT_ALLOWED',
      ext,
      allowed: allowedExtensions
    };
  }

  const lowerMime = (mimeType || '').toLowerCase();
  if (DISALLOWED_MIME_PREFIXES.some((p) => lowerMime.startsWith(p))) {
    return { valid: false, code: 'FILE_MIME_NOT_ALLOWED' };
  }

  // Block Windows PE executables ("MZ" header) disguised with allowed extensions
  if (buffer.length >= 2 && buffer[0] === 0x4d && buffer[1] === 0x5a && !['zip', 'rar', 'doc', 'xls', 'ppt'].includes(ext)) {
    return { valid: false, code: 'FILE_EXECUTABLE_DETECTED' };
  }

  if (requireImageMagic) {
    const isJpg = buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    const isPng = buffer.length >= 4 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
    const isGif = buffer.length >= 3 && buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46;
    const isWebp = buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
    if (!isJpg && !isPng && !isGif && !isWebp) {
      return { valid: false, code: 'INVALID_IMAGE_CONTENT' };
    }
  }

  const storedName = `${crypto.randomUUID()}.${ext}`;
  return {
    valid: true,
    ext,
    storedName,
    sizeBytes: buffer.length
  };
}

/**
 * Format safe download filename for submissions (GRD-02):
 * <username>_<tênbuổi>_<ngày>.<đuôi>
 */
export function formatSubmissionDownloadName(username, sessionTitle, sessionDate, originalFilename) {
  const ext = path.extname(originalFilename || '').replace(/^\./, '').toLowerCase() || 'bin';
  const cleanUser = String(username || 'student')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');

  const cleanSession = String(sessionTitle || 'session')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 40);

  const cleanDate = String(sessionDate || new Date().toISOString().slice(0, 10))
    .slice(0, 10)
    .replace(/[^0-9-]/g, '');

  return `${cleanUser}_${cleanSession}_${cleanDate}.${ext}`;
}

/**
 * Simple in-memory sliding-window rate limiter per IP + route bucket (NFR-11).
 */
const rateBuckets = new Map();

export function checkRateLimit(key, maxRequests = 60, windowMs = 60_000) {
  const now = Date.now();
  let entry = rateBuckets.get(key);
  if (!entry || now > entry.resetAt) {
    entry = { count: 1, resetAt: now + windowMs };
    rateBuckets.set(key, entry);
    return { allowed: true, remaining: maxRequests - 1 };
  }
  entry.count += 1;
  if (entry.count > maxRequests) {
    return { allowed: false, retryAfterSec: Math.ceil((entry.resetAt - now) / 1000) };
  }
  return { allowed: true, remaining: maxRequests - entry.count };
}

export function clearRateLimits() {
  rateBuckets.clear();
}
