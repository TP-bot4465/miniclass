import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from '../config.mjs';
import { getDb, getSystemSettings, updateSystemSettings, logAudit } from '../db.mjs';
import {
  validatePasswordStrength,
  hashPassword,
  verifyPassword,
  generateTempPassword,
  generateToken,
  validateScore,
  validateUploadedFile,
  formatSubmissionDownloadName,
  checkRateLimit
} from '../security.mjs';
import { notifyUser, runDeadlineReminders, runDailyTeacherDigest } from '../email.mjs';
import { createZipBuffer } from '../zip.mjs';
import { parseCsvRows, toCsvBuffer } from '../csv.mjs';

/**
 * Helper to send JSON response with security headers.
 */
export function sendJson(res, status, data, extraHeaders = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Cache-Control': 'no-store',
    ...extraHeaders
  });
  res.end(body);
}

/**
 * Parse cookies from request header.
 */
export function parseCookies(req) {
  const header = req.headers.cookie || '';
  const cookies = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) {
      const k = part.slice(0, idx).trim();
      const v = decodeURIComponent(part.slice(idx + 1).trim());
      cookies[k] = v;
    }
  }
  return cookies;
}

/**
 * Read request body up to maxBytes.
 */
export function readBodyBuffer(req, maxBytes = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let aborted = false;
    req.on('data', (chunk) => {
      if (aborted) return;
      total += chunk.length;
      if (total > maxBytes) {
        aborted = true;
        const err = new Error('PAYLOAD_TOO_LARGE');
        err.code = 'PAYLOAD_TOO_LARGE';
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!aborted) resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (!aborted) reject(err);
    });
  });
}

export async function readJsonBody(req, maxBytes = 25 * 1024 * 1024) {
  const buf = await readBodyBuffer(req, maxBytes);
  if (buf.length === 0) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    const err = new Error('INVALID_JSON');
    err.code = 'INVALID_JSON';
    throw err;
  }
}

/**
 * Authenticate current request from session cookie or Authorization Bearer token.
 * Enforces 7-day inactivity timeout (AUTH-03) and account lock status (AUTH-06).
 */
export function authenticateRequest(req, db) {
  const cookies = parseCookies(req);
  let token = cookies.miniclass_sid;
  if (!token && req.headers.authorization?.startsWith('Bearer ')) {
    token = req.headers.authorization.slice(7).trim();
  }
  if (!token) return null;

  const session = db.prepare(`
    SELECT s.token, s.csrf_token, s.user_id, s.last_activity_at, s.expires_at,
           u.id, u.username, u.email, u.full_name, u.role, u.status,
           u.must_change_password, u.language, u.email_prefs_json
    FROM sessions_auth s
    JOIN users u ON u.id = s.user_id
    WHERE s.token = ?
  `).get(token);

  if (!session) return null;

  const now = new Date();
  if (new Date(session.expires_at) <= now) {
    db.prepare('DELETE FROM sessions_auth WHERE token = ?').run(token);
    return null;
  }

  if (session.status !== 'active') {
    db.prepare('DELETE FROM sessions_auth WHERE token = ?').run(token);
    return { locked: true };
  }

  // Rolling 7-day inactivity refresh (AUTH-03)
  const newExpires = new Date(now.getTime() + CONFIG.SESSION_TTL_MS).toISOString();
  db.prepare('UPDATE sessions_auth SET last_activity_at = ?, expires_at = ? WHERE token = ?').run(
    now.toISOString(),
    newExpires,
    token
  );

  let emailPrefs = {};
  try {
    emailPrefs = JSON.parse(session.email_prefs_json || '{}');
  } catch {}

  return {
    token: session.token,
    csrfToken: session.csrf_token,
    user: {
      id: session.id,
      username: session.username,
      email: session.email,
      full_name: session.full_name,
      role: session.role,
      status: session.status,
      must_change_password: Boolean(session.must_change_password),
      language: session.language || 'vi',
      email_prefs: emailPrefs
    }
  };
}

/**
 * Verify class access permissions per Section 2.3 and BR-04:
 * - Admin: full access
 * - Teacher: must be teacher_id of the class
 * - Student: must be in class_members of the class
 */
function checkClassAccess(db, user, classId) {
  const cls = db.prepare(`
    SELECT c.*, u.full_name AS teacher_name, u.username AS teacher_username, u.email AS teacher_email
    FROM classes c
    JOIN users u ON u.id = c.teacher_id
    WHERE c.id = ?
  `).get(classId);

  if (!cls) return { allowed: false, status: 404, code: 'CLASS_NOT_FOUND' };

  if (user.role === 'admin') {
    return { allowed: true, cls };
  }
  if (user.role === 'teacher') {
    if (cls.teacher_id !== user.id) {
      return { allowed: false, status: 403, code: 'FORBIDDEN_CLASS_ACCESS' };
    }
    return { allowed: true, cls };
  }
  if (user.role === 'student') {
    const member = db.prepare('SELECT id FROM class_members WHERE class_id = ? AND student_id = ?').get(classId, user.id);
    if (!member) {
      return { allowed: false, status: 403, code: 'FORBIDDEN_NOT_CLASS_MEMBER' };
    }
    return { allowed: true, cls };
  }
  return { allowed: false, status: 403, code: 'FORBIDDEN' };
}

/**
 * Calculate directory disk usage in bytes recursively (ADM-01).
 */
function getDirectorySizeBytes(dirPath) {
  if (!fs.existsSync(dirPath)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      total += getDirectorySizeBytes(full);
    } else if (entry.isFile()) {
      try {
        total += fs.statSync(full).size;
      } catch {}
    }
  }
  return total;
}

/**
 * Main API Router
 */
export async function handleApiRequest(req, res, urlObj) {
  const db = getDb();
  const pathname = urlObj.pathname;
  const method = req.method.toUpperCase();
  const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '127.0.0.1';

  // AC-01 & BR-01: Explicitly reject any public registration endpoints
  if (pathname === '/api/auth/register' || pathname === '/api/auth/signup') {
    return sendJson(res, 404, {
      error: 'REGISTRATION_DISABLED',
      message_vi: 'Hệ thống không hỗ trợ tự đăng ký tài khoản. Mọi tài khoản do Quản trị viên tạo.',
      message_en: 'Self-registration is disabled. All accounts are created by the Administrator.'
    });
  }

  // Public config endpoint (for login screen i18n / metadata)
  if (pathname === '/api/public/config' && method === 'GET') {
    const settings = getSystemSettings(db);
    return sendJson(res, 200, {
      appName: 'MiniClass',
      badge_color_mode: settings.badge_color_mode || 'subtle'
    });
  }

  // AUTH-01, AUTH-02, AUTH-06: Login endpoint
  if (pathname === '/api/auth/login' && method === 'POST') {
    const rl = checkRateLimit(`login:${clientIp}`, 60, 60_000);
    if (!rl.allowed) {
      return sendJson(res, 429, {
        error: 'RATE_LIMITED',
        message_vi: `Quá nhiều yêu cầu đăng nhập. Vui lòng thử lại sau ${rl.retryAfterSec} giây.`,
        message_en: `Too many login requests. Please retry in ${rl.retryAfterSec} seconds.`
      });
    }

    const body = await readJsonBody(req);
    const username = String(body.username || '').trim();
    const password = String(body.password || '');

    if (!username || !password) {
      return sendJson(res, 400, {
        error: 'MISSING_CREDENTIALS',
        message_vi: 'Vui lòng nhập tên đăng nhập và mật khẩu.',
        message_en: 'Please enter both username and password.'
      });
    }

    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user) {
      return sendJson(res, 401, {
        error: 'INVALID_CREDENTIALS',
        message_vi: 'Tên đăng nhập hoặc mật khẩu không đúng.',
        message_en: 'Invalid username or password.'
      });
    }

    // AUTH-06: Locked account check
    if (user.status === 'locked') {
      return sendJson(res, 403, {
        error: 'ACCOUNT_LOCKED',
        message_vi: 'Tài khoản đã bị khóa, liên hệ quản trị viên',
        message_en: 'Account is locked, please contact administrator'
      });
    }

    // AUTH-02: Check 15-minute temporary lockout after 5 failed attempts
    if (user.locked_until) {
      const lockUntilDate = new Date(user.locked_until);
      if (lockUntilDate > new Date()) {
        const minsLeft = Math.max(1, Math.ceil((lockUntilDate.getTime() - Date.now()) / 60000));
        return sendJson(res, 429, {
          error: 'LOGIN_TEMP_LOCKED',
          minutesLeft: minsLeft,
          message_vi: `Nhập sai mật khẩu quá 5 lần. Tài khoản tạm khóa đăng nhập trong ${minsLeft} phút.`,
          message_en: `Too many failed password attempts (5). Login temporarily locked for ${minsLeft} minutes.`
        });
      }
    }

    const validPass = verifyPassword(password, user.password_hash);
    if (!validPass) {
      const attempts = (user.failed_login_attempts || 0) + 1;
      if (attempts >= CONFIG.LOGIN_MAX_ATTEMPTS) {
        const lockedUntil = new Date(Date.now() + CONFIG.LOGIN_LOCKOUT_MS).toISOString();
        db.prepare('UPDATE users SET failed_login_attempts = ?, locked_until = ?, updated_at = ? WHERE id = ?').run(
          attempts,
          lockedUntil,
          new Date().toISOString(),
          user.id
        );
        return sendJson(res, 429, {
          error: 'LOGIN_TEMP_LOCKED',
          minutesLeft: 15,
          message_vi: 'Sai mật khẩu 5 lần liên tiếp. Tạm khóa đăng nhập 15 phút.',
          message_en: '5 consecutive failed attempts. Login temporarily locked for 15 minutes.'
        });
      } else {
        db.prepare('UPDATE users SET failed_login_attempts = ?, updated_at = ? WHERE id = ?').run(
          attempts,
          new Date().toISOString(),
          user.id
        );
        return sendJson(res, 401, {
          error: 'INVALID_CREDENTIALS',
          remainingAttempts: CONFIG.LOGIN_MAX_ATTEMPTS - attempts,
          message_vi: `Tên đăng nhập hoặc mật khẩu không đúng (còn ${CONFIG.LOGIN_MAX_ATTEMPTS - attempts} lần thử).`,
          message_en: `Invalid username or password (${CONFIG.LOGIN_MAX_ATTEMPTS - attempts} attempts remaining).`
        });
      }
    }

    // Reset failed login counter
    const nowIso = new Date().toISOString();
    db.prepare('UPDATE users SET failed_login_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?').run(
      nowIso,
      user.id
    );

    const token = generateToken(32);
    const csrfToken = generateToken(24);
    const expiresAt = new Date(Date.now() + CONFIG.SESSION_TTL_MS).toISOString();

    db.prepare(`
      INSERT INTO sessions_auth (token, csrf_token, user_id, last_activity_at, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(token, csrfToken, user.id, nowIso, expiresAt, nowIso);

    const maxAgeSec = Math.floor(CONFIG.SESSION_TTL_MS / 1000);
    const cookieStr = `miniclass_sid=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}`;

    let emailPrefs = {};
    try {
      emailPrefs = JSON.parse(user.email_prefs_json || '{}');
    } catch {}

    return sendJson(
      res,
      200,
      {
        token,
        csrfToken,
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          full_name: user.full_name,
          role: user.role,
          status: user.status,
          must_change_password: Boolean(user.must_change_password),
          language: user.language || 'vi',
          email_prefs: emailPrefs
        },
        settings: getSystemSettings(db)
      },
      { 'Set-Cookie': cookieStr }
    );
  }

  // Authenticate all remaining /api/* routes
  const auth = authenticateRequest(req, db);
  if (!auth) {
    return sendJson(res, 401, {
      error: 'UNAUTHORIZED',
      message_vi: 'Phiên đăng nhập đã hết hạn hoặc chưa đăng nhập.',
      message_en: 'Session expired or not authenticated.'
    });
  }
  if (auth.locked) {
    return sendJson(res, 403, {
      error: 'ACCOUNT_LOCKED',
      message_vi: 'Tài khoản đã bị khóa, liên hệ quản trị viên',
      message_en: 'Account is locked, please contact administrator'
    });
  }

  const currentUser = auth.user;

  // AUTH-03: Logout
  if (pathname === '/api/auth/logout' && method === 'POST') {
    db.prepare('DELETE FROM sessions_auth WHERE token = ?').run(auth.token);
    return sendJson(
      res,
      200,
      { ok: true },
      { 'Set-Cookie': 'miniclass_sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' }
    );
  }

  // Current authenticated session & user info
  if (pathname === '/api/auth/me' && method === 'GET') {
    const unreadCount = db
      .prepare('SELECT COUNT(*) AS cnt FROM notifications WHERE user_id = ? AND is_read = 0')
      .get(currentUser.id).cnt;
    return sendJson(res, 200, {
      user: currentUser,
      csrfToken: auth.csrfToken,
      unreadNotifications: unreadCount,
      settings: getSystemSettings(db)
    });
  }

  // AUTH-04 & AUTH-05: Change own password
  if (pathname === '/api/auth/change-password' && method === 'POST') {
    const body = await readJsonBody(req);
    const oldPassword = String(body.oldPassword || '');
    const newPassword = String(body.newPassword || '');

    const userRow = db.prepare('SELECT * FROM users WHERE id = ?').get(currentUser.id);
    if (!verifyPassword(oldPassword, userRow.password_hash)) {
      return sendJson(res, 400, {
        error: 'WRONG_OLD_PASSWORD',
        message_vi: 'Mật khẩu hiện tại không chính xác.',
        message_en: 'Current password is incorrect.'
      });
    }

    if (oldPassword === newPassword) {
      return sendJson(res, 400, {
        error: 'PASSWORD_UNCHANGED',
        message_vi: 'Mật khẩu mới phải khác mật khẩu hiện tại.',
        message_en: 'New password must be different from current password.'
      });
    }

    const strength = validatePasswordStrength(newPassword);
    if (!strength.valid) {
      return sendJson(res, 400, {
        error: strength.reason,
        message_vi: 'Mật khẩu mới phải có ít nhất 8 ký tự, bao gồm cả chữ và số.',
        message_en: 'New password must be at least 8 characters and contain both letters and numbers.'
      });
    }

    const nowIso = new Date().toISOString();
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?').run(
      hashPassword(newPassword),
      nowIso,
      currentUser.id
    );

    return sendJson(res, 200, {
      ok: true,
      message_vi: 'Đổi mật khẩu thành công.',
      message_en: 'Password changed successfully.'
    });
  }

  // AUTH-07, I18N-02, NOT-03: Update profile (full_name, language, email_prefs)
  if (pathname === '/api/auth/profile' && method === 'PUT') {
    const body = await readJsonBody(req);
    const userRow = db.prepare('SELECT * FROM users WHERE id = ?').get(currentUser.id);

    const fullName = body.full_name !== undefined ? String(body.full_name).trim() : userRow.full_name;
    if (!fullName) {
      return sendJson(res, 400, {
        error: 'FULL_NAME_REQUIRED',
        message_vi: 'Họ tên hiển thị không được để trống.',
        message_en: 'Display name cannot be empty.'
      });
    }

    const language = body.language === 'en' ? 'en' : body.language === 'vi' ? 'vi' : userRow.language;

    let currentPrefs = {};
    try {
      currentPrefs = JSON.parse(userRow.email_prefs_json || '{}');
    } catch {}
    if (body.email_prefs && typeof body.email_prefs === 'object') {
      currentPrefs = { ...currentPrefs, ...body.email_prefs };
    }

    const nowIso = new Date().toISOString();
    db.prepare(`
      UPDATE users
      SET full_name = ?, language = ?, email_prefs_json = ?, updated_at = ?
      WHERE id = ?
    `).run(fullName, language, JSON.stringify(currentPrefs), nowIso, currentUser.id);

    return sendJson(res, 200, {
      ok: true,
      user: {
        ...currentUser,
        full_name: fullName,
        language,
        email_prefs: currentPrefs
      }
    });
  }

  // AUTH-05 & AC-02: Block all other actions if user must change their temporary password first
  if (currentUser.must_change_password) {
    return sendJson(res, 403, {
      error: 'MUST_CHANGE_PASSWORD',
      message_vi: 'Bạn cần đổi mật khẩu tạm thời trước khi sử dụng hệ thống.',
      message_en: 'You must change your temporary password before using the system.'
    });
  }

  // =========================================================================
  // DASHBOARD (S03, ADM-01)
  // =========================================================================
  if (pathname === '/api/dashboard' && method === 'GET') {
    // Opportunistically check 24h deadline reminders (NOT-05)
    runDeadlineReminders(db);

    if (currentUser.role === 'admin') {
      const roleCounts = db.prepare(`SELECT role, status, COUNT(*) AS cnt FROM users GROUP BY role, status`).all();
      const classCounts = db.prepare(`SELECT status, COUNT(*) AS cnt FROM classes GROUP BY status`).all();
      const sessionCount = db.prepare(`SELECT COUNT(*) AS cnt FROM class_sessions`).get().cnt;
      const submissionCount = db.prepare(`SELECT COUNT(*) AS cnt FROM submissions`).get().cnt;
      const storageBytes = getDirectorySizeBytes(CONFIG.DATA_DIR);

      const recentLogs = db.prepare(`SELECT * FROM audit_logs ORDER BY id DESC LIMIT 10`).all();

      return sendJson(res, 200, {
        role: 'admin',
        stats: {
          roleCounts,
          classCounts,
          sessionCount,
          submissionCount,
          storageBytes
        },
        recentLogs
      });
    }

    if (currentUser.role === 'teacher') {
      const classes = db.prepare(`
        SELECT c.*,
               (SELECT COUNT(*) FROM class_members cm WHERE cm.class_id = c.id) AS student_count,
               (SELECT COUNT(*) FROM class_sessions s WHERE s.class_id = c.id) AS session_count,
               (SELECT COUNT(*) FROM submissions sub
                JOIN class_sessions s ON s.id = sub.session_id
                WHERE s.class_id = c.id AND (sub.score IS NULL OR sub.needs_regrade = 1)) AS ungraded_count
        FROM classes c
        WHERE c.teacher_id = ?
        ORDER BY c.status ASC, c.id DESC
      `).all(currentUser.id);

      return sendJson(res, 200, {
        role: 'teacher',
        classes
      });
    }

    // Student dashboard: joined classes + upcoming deadlines
    const classes = db.prepare(`
      SELECT c.*, u.full_name AS teacher_name,
             (SELECT COUNT(*) FROM class_sessions s WHERE s.class_id = c.id AND s.status = 'published') AS session_count
      FROM classes c
      JOIN class_members cm ON cm.class_id = c.id
      JOIN users u ON u.id = c.teacher_id
      WHERE cm.student_id = ?
      ORDER BY c.status ASC, c.id DESC
    `).all(currentUser.id);

    const upcomingTasks = db.prepare(`
      SELECT s.id AS session_id, s.class_id, s.title, s.session_date, s.deadline,
             c.name AS class_name,
             sub.id AS submission_id, sub.submitted_at, sub.is_late, sub.score, sub.allow_resubmit
      FROM class_sessions s
      JOIN classes c ON c.id = s.class_id
      JOIN class_members cm ON cm.class_id = c.id
      LEFT JOIN submissions sub ON sub.session_id = s.id AND sub.student_id = ?
      WHERE cm.student_id = ?
        AND s.status = 'published'
        AND c.status = 'active'
        AND s.requires_submission = 1
      ORDER BY
        CASE WHEN sub.id IS NULL THEN 0 ELSE 1 END ASC,
        CASE WHEN s.deadline IS NULL THEN 1 ELSE 0 END ASC,
        s.deadline ASC,
        s.session_date DESC
      LIMIT 15
    `).all(currentUser.id, currentUser.id);

    return sendJson(res, 200, {
      role: 'student',
      classes,
      upcomingTasks
    });
  }

  // =========================================================================
  // 3.2 ADMIN USER MANAGEMENT & SYSTEM (USR-01..USR-08, ADM-01..ADM-03)
  // =========================================================================
  if (pathname === '/api/admin/users' && method === 'GET') {
    if (currentUser.role !== 'admin') {
      return sendJson(res, 403, { error: 'FORBIDDEN' });
    }
    const roleFilter = urlObj.searchParams.get('role') || '';
    const statusFilter = urlObj.searchParams.get('status') || '';
    const q = (urlObj.searchParams.get('q') || '').trim().toLowerCase();

    let sql = `
      SELECT id, username, email, full_name, role, status, must_change_password, language, created_at, updated_at
      FROM users WHERE 1=1
    `;
    const params = [];
    if (roleFilter && ['admin', 'teacher', 'student'].includes(roleFilter)) {
      sql += ` AND role = ?`;
      params.push(roleFilter);
    }
    if (statusFilter && ['active', 'locked'].includes(statusFilter)) {
      sql += ` AND status = ?`;
      params.push(statusFilter);
    }
    if (q) {
      sql += ` AND (LOWER(full_name) LIKE ? OR LOWER(username) LIKE ? OR LOWER(email) LIKE ?)`;
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    sql += ` ORDER BY id DESC`;

    const users = db.prepare(sql).all(...params);
    return sendJson(res, 200, { users });
  }

  if (pathname === '/api/admin/users' && method === 'POST') {
    if (currentUser.role !== 'admin') {
      return sendJson(res, 403, { error: 'FORBIDDEN' });
    }
    const body = await readJsonBody(req);
    const fullName = String(body.full_name || '').trim();
    const username = String(body.username || '').trim().toLowerCase();
    const email = String(body.email || '').trim().toLowerCase();
    const role = String(body.role || 'student').trim();
    const tempPassword = String(body.password || '').trim() || generateTempPassword();

    if (!fullName || !username || !email || !['admin', 'teacher', 'student'].includes(role)) {
      return sendJson(res, 400, {
        error: 'INVALID_INPUT',
        message_vi: 'Vui lòng điền đầy đủ họ tên, username, email và vai trò hợp lệ.',
        message_en: 'Please provide valid full name, username, email, and role.'
      });
    }

    if (!/^[a-z0-9_.-]{3,40}$/.test(username)) {
      return sendJson(res, 400, {
        error: 'INVALID_USERNAME',
        message_vi: 'Username chỉ gồm chữ thường, số, dấu gạch dưới/chấm (3–40 ký tự).',
        message_en: 'Username must be 3–40 characters (lowercase letters, digits, underscore, dot).'
      });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return sendJson(res, 400, {
        error: 'INVALID_EMAIL',
        message_vi: 'Địa chỉ email không hợp lệ.',
        message_en: 'Invalid email address.'
      });
    }

    const strength = validatePasswordStrength(tempPassword);
    if (!strength.valid) {
      return sendJson(res, 400, {
        error: strength.reason,
        message_vi: 'Mật khẩu tạm phải từ 8 ký tự trở lên, gồm cả chữ và số.',
        message_en: 'Temporary password must be at least 8 characters and include letters and numbers.'
      });
    }

    const dupUser = db.prepare('SELECT id, username, email FROM users WHERE LOWER(username) = ? OR LOWER(email) = ?').get(username, email);
    if (dupUser) {
      return sendJson(res, 409, {
        error: 'DUPLICATE_USER',
        message_vi: dupUser.username.toLowerCase() === username ? 'Username đã tồn tại trong hệ thống.' : 'Email đã tồn tại trong hệ thống.',
        message_en: dupUser.username.toLowerCase() === username ? 'Username already exists.' : 'Email already exists.'
      });
    }

    const nowIso = new Date().toISOString();
    const result = db.prepare(`
      INSERT INTO users (username, email, password_hash, full_name, role, status, must_change_password, language, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'active', 1, 'vi', ?, ?)
    `).run(username, email, hashPassword(tempPassword), fullName, role, nowIso, nowIso);

    const newUserId = Number(result.lastInsertRowid);
    logAudit(db, {
      actorId: currentUser.id,
      actorUsername: currentUser.username,
      action: 'USER_CREATE',
      targetType: 'user',
      targetId: newUserId,
      details: { username, email, role, full_name: fullName },
      ipAddress: clientIp
    });

    return sendJson(res, 201, {
      ok: true,
      tempPassword,
      user: {
        id: newUserId,
        username,
        email,
        full_name: fullName,
        role,
        status: 'active',
        must_change_password: true
      }
    });
  }

  // USR-07: Bulk import Student accounts via CSV
  if (pathname === '/api/admin/users/import-csv' && method === 'POST') {
    if (currentUser.role !== 'admin') {
      return sendJson(res, 403, { error: 'FORBIDDEN' });
    }
    const body = await readJsonBody(req);
    const csvText = String(body.csvText || '');
    const rows = parseCsvRows(csvText);

    if (rows.length === 0) {
      return sendJson(res, 400, {
        error: 'CSV_EMPTY',
        message_vi: 'File CSV trống hoặc không đúng định dạng.',
        message_en: 'CSV file is empty or invalid.'
      });
    }

    // Detect if first row is header
    let startIdx = 0;
    const firstRowLower = rows[0].map((c) => c.toLowerCase());
    if (
      firstRowLower.some((c) =>
        ['username', 'email', 'họ tên', 'ho ten', 'full_name', 'fullname'].includes(c)
      )
    ) {
      startIdx = 1;
    }

    const results = [];
    let createdCount = 0;
    let errorCount = 0;
    const nowIso = new Date().toISOString();

    for (let i = startIdx; i < rows.length; i++) {
      const rowNum = i + 1;
      const cols = rows[i];
      const fullName = String(cols[0] || '').trim();
      const username = String(cols[1] || '').trim().toLowerCase();
      const email = String(cols[2] || '').trim().toLowerCase();
      const tempPassword = String(cols[3] || '').trim() || generateTempPassword();

      if (!fullName || !username || !email) {
        errorCount++;
        results.push({
          row: rowNum,
          username: username || '(trống)',
          status: 'error',
          error_vi: 'Thiếu họ tên, username hoặc email.',
          error_en: 'Missing full_name, username, or email.'
        });
        continue;
      }

      if (!/^[a-z0-9_.-]{3,40}$/.test(username)) {
        errorCount++;
        results.push({
          row: rowNum,
          username,
          status: 'error',
          error_vi: 'Username không hợp lệ (3–40 ký tự chữ/số).',
          error_en: 'Invalid username format.'
        });
        continue;
      }

      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        errorCount++;
        results.push({
          row: rowNum,
          username,
          status: 'error',
          error_vi: 'Email không đúng định dạng.',
          error_en: 'Invalid email format.'
        });
        continue;
      }

      const strength = validatePasswordStrength(tempPassword);
      if (!strength.valid) {
        errorCount++;
        results.push({
          row: rowNum,
          username,
          status: 'error',
          error_vi: 'Mật khẩu tạm phải ≥ 8 ký tự, gồm chữ và số.',
          error_en: 'Password must be >= 8 chars with letters and numbers.'
        });
        continue;
      }

      const dup = db
        .prepare('SELECT id FROM users WHERE LOWER(username) = ? OR LOWER(email) = ?')
        .get(username, email);
      if (dup) {
        errorCount++;
        results.push({
          row: rowNum,
          username,
          status: 'error',
          error_vi: 'Trùng username hoặc email đã tồn tại.',
          error_en: 'Duplicate username or email.'
        });
        continue;
      }

      db.prepare(`
        INSERT INTO users (username, email, password_hash, full_name, role, status, must_change_password, language, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'student', 'active', 1, 'vi', ?, ?)
      `).run(username, email, hashPassword(tempPassword), fullName, nowIso, nowIso);

      createdCount++;
      results.push({
        row: rowNum,
        username,
        full_name: fullName,
        email,
        tempPassword,
        status: 'created'
      });
    }

    logAudit(db, {
      actorId: currentUser.id,
      actorUsername: currentUser.username,
      action: 'USER_IMPORT_CSV',
      targetType: 'user',
      targetId: 'batch',
      details: { createdCount, errorCount },
      ipAddress: clientIp
    });

    return sendJson(res, 200, {
      ok: true,
      createdCount,
      errorCount,
      results
    });
  }

  // Match /api/admin/users/:id/*
  const adminUserMatch = pathname.match(/^\/api\/admin\/users\/(\d+)(?:\/(status|reset-password))?$/);
  if (adminUserMatch) {
    if (currentUser.role !== 'admin') {
      return sendJson(res, 403, { error: 'FORBIDDEN' });
    }
    const targetUserId = Number(adminUserMatch[1]);
    const subAction = adminUserMatch[2] || null;
    const targetUser = db.prepare('SELECT * FROM users WHERE id = ?').get(targetUserId);

    if (!targetUser) {
      return sendJson(res, 404, {
        error: 'USER_NOT_FOUND',
        message_vi: 'Không tìm thấy tài khoản.',
        message_en: 'User account not found.'
      });
    }

    // USR-03: Edit user (except username)
    if (!subAction && method === 'PUT') {
      const body = await readJsonBody(req);
      if (body.username !== undefined && String(body.username).toLowerCase() !== targetUser.username.toLowerCase()) {
        return sendJson(res, 400, {
          error: 'USERNAME_IMMUTABLE',
          message_vi: 'Không được phép thay đổi tên đăng nhập (username) sau khi tạo (BR-02).',
          message_en: 'Username cannot be changed after creation (BR-02).'
        });
      }

      const fullName = body.full_name !== undefined ? String(body.full_name).trim() : targetUser.full_name;
      const email = body.email !== undefined ? String(body.email).trim().toLowerCase() : targetUser.email;
      const role = body.role !== undefined ? String(body.role).trim() : targetUser.role;

      if (!fullName || !email || !['admin', 'teacher', 'student'].includes(role)) {
        return sendJson(res, 400, {
          error: 'INVALID_INPUT',
          message_vi: 'Thông tin cập nhật không hợp lệ.',
          message_en: 'Invalid update fields.'
        });
      }

      const dupEmail = db
        .prepare('SELECT id FROM users WHERE LOWER(email) = ? AND id != ?')
        .get(email, targetUserId);
      if (dupEmail) {
        return sendJson(res, 409, {
          error: 'DUPLICATE_EMAIL',
          message_vi: 'Email này đã được sử dụng bởi tài khoản khác.',
          message_en: 'Email is already used by another account.'
        });
      }

      const nowIso = new Date().toISOString();
      db.prepare('UPDATE users SET full_name = ?, email = ?, role = ?, updated_at = ? WHERE id = ?').run(
        fullName,
        email,
        role,
        nowIso,
        targetUserId
      );

      logAudit(db, {
        actorId: currentUser.id,
        actorUsername: currentUser.username,
        action: 'USER_UPDATE',
        targetType: 'user',
        targetId: targetUserId,
        details: { username: targetUser.username, full_name: fullName, email, role },
        ipAddress: clientIp
      });

      return sendJson(res, 200, { ok: true });
    }

    // USR-04: Lock / Unlock user
    if (subAction === 'status' && method === 'POST') {
      const body = await readJsonBody(req);
      const newStatus = body.status === 'locked' ? 'locked' : 'active';
      if (targetUserId === currentUser.id && newStatus === 'locked') {
        return sendJson(res, 400, {
          error: 'CANNOT_LOCK_SELF',
          message_vi: 'Không thể tự khóa tài khoản của chính mình.',
          message_en: 'You cannot lock your own account.'
        });
      }

      const nowIso = new Date().toISOString();
      db.prepare('UPDATE users SET status = ?, failed_login_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?').run(
        newStatus,
        nowIso,
        targetUserId
      );

      if (newStatus === 'locked') {
        db.prepare('DELETE FROM sessions_auth WHERE user_id = ?').run(targetUserId);
      }

      logAudit(db, {
        actorId: currentUser.id,
        actorUsername: currentUser.username,
        action: newStatus === 'locked' ? 'USER_LOCK' : 'USER_UNLOCK',
        targetType: 'user',
        targetId: targetUserId,
        details: { username: targetUser.username, status: newStatus },
        ipAddress: clientIp
      });

      return sendJson(res, 200, { ok: true, status: newStatus });
    }

    // USR-05: Admin reset password
    if (subAction === 'reset-password' && method === 'POST') {
      const body = await readJsonBody(req);
      const newPassword = body.newPassword ? String(body.newPassword).trim() : generateTempPassword();
      const strength = validatePasswordStrength(newPassword);
      if (!strength.valid) {
        return sendJson(res, 400, {
          error: strength.reason,
          message_vi: 'Mật khẩu mới phải có ít nhất 8 ký tự, gồm cả chữ và số.',
          message_en: 'New password must be at least 8 characters and include letters and numbers.'
        });
      }

      const nowIso = new Date().toISOString();
      db.prepare(`
        UPDATE users
        SET password_hash = ?, must_change_password = 1, failed_login_attempts = 0, locked_until = NULL, updated_at = ?
        WHERE id = ?
      `).run(hashPassword(newPassword), nowIso, targetUserId);

      // Invalidate old sessions of target user
      db.prepare('DELETE FROM sessions_auth WHERE user_id = ?').run(targetUserId);

      logAudit(db, {
        actorId: currentUser.id,
        actorUsername: currentUser.username,
        action: 'USER_RESET_PASSWORD',
        targetType: 'user',
        targetId: targetUserId,
        details: { username: targetUser.username },
        ipAddress: clientIp
      });

      return sendJson(res, 200, {
        ok: true,
        tempPassword: newPassword
      });
    }

    // USR-06: Delete user (only if no related data; otherwise suggest locking)
    if (!subAction && method === 'DELETE') {
      if (targetUserId === currentUser.id) {
        return sendJson(res, 400, {
          error: 'CANNOT_DELETE_SELF',
          message_vi: 'Không thể xóa tài khoản đang đăng nhập.',
          message_en: 'You cannot delete your own active account.'
        });
      }

      const classesCount = db.prepare('SELECT COUNT(*) AS cnt FROM classes WHERE teacher_id = ? OR created_by = ?').get(targetUserId, targetUserId).cnt;
      const memberCount = db.prepare('SELECT COUNT(*) AS cnt FROM class_members WHERE student_id = ?').get(targetUserId).cnt;
      const sessionsCount = db.prepare('SELECT COUNT(*) AS cnt FROM class_sessions WHERE created_by = ?').get(targetUserId).cnt;
      const subCount = db.prepare('SELECT COUNT(*) AS cnt FROM submissions WHERE student_id = ? OR graded_by = ?').get(targetUserId, targetUserId).cnt;

      const totalRelated = classesCount + memberCount + sessionsCount + subCount;
      if (totalRelated > 0) {
        return sendJson(res, 409, {
          error: 'USER_HAS_RELATED_DATA',
          suggestLock: true,
          related: { classesCount, memberCount, sessionsCount, subCount },
          message_vi: `Tài khoản "${targetUser.username}" đã có dữ liệu liên quan (${classesCount} lớp, ${memberCount} lớp tham gia, ${subCount} bài nộp/chấm). Hệ thống không cho phép xóa để bảo toàn dữ liệu — vui lòng chọn "Khóa tài khoản" thay vì xóa.`,
          message_en: `Account "${targetUser.username}" has related data (${classesCount} classes, ${memberCount} memberships, ${subCount} submissions/grades). Deletion is blocked to preserve records — please "Lock" the account instead.`
        });
      }

      db.prepare('DELETE FROM users WHERE id = ?').run(targetUserId);

      logAudit(db, {
        actorId: currentUser.id,
        actorUsername: currentUser.username,
        action: 'USER_DELETE',
        targetType: 'user',
        targetId: targetUserId,
        details: { username: targetUser.username, email: targetUser.email },
        ipAddress: clientIp
      });

      return sendJson(res, 200, { ok: true });
    }
  }

  // ADM-02: Audit Logs
  if (pathname === '/api/admin/audit-logs' && method === 'GET') {
    if (currentUser.role !== 'admin') {
      return sendJson(res, 403, { error: 'FORBIDDEN' });
    }
    const actor = (urlObj.searchParams.get('actor') || '').trim().toLowerCase();
    const action = (urlObj.searchParams.get('action') || '').trim();
    const fromDate = (urlObj.searchParams.get('from') || '').trim();
    const toDate = (urlObj.searchParams.get('to') || '').trim();

    let sql = 'SELECT * FROM audit_logs WHERE 1=1';
    const params = [];
    if (actor) {
      sql += ' AND LOWER(actor_username) LIKE ?';
      params.push(`%${actor}%`);
    }
    if (action) {
      sql += ' AND action = ?';
      params.push(action);
    }
    if (fromDate) {
      sql += ' AND created_at >= ?';
      params.push(fromDate);
    }
    if (toDate) {
      sql += ' AND created_at <= ?';
      params.push(toDate + 'T23:59:59.999Z');
    }
    sql += ' ORDER BY id DESC LIMIT 250';

    const logs = db.prepare(sql).all(...params);
    return sendJson(res, 200, { logs });
  }

  // ADM-03: Dynamic System Configuration
  if (pathname === '/api/admin/settings' && (method === 'GET' || method === 'PUT')) {
    if (currentUser.role !== 'admin') {
      return sendJson(res, 403, { error: 'FORBIDDEN' });
    }
    if (method === 'GET') {
      const emailQueue = db.prepare('SELECT * FROM email_queue ORDER BY id DESC LIMIT 50').all();
      return sendJson(res, 200, {
        settings: getSystemSettings(db),
        emailQueue
      });
    }

    const body = await readJsonBody(req);
    const updates = {};

    if (body.allowed_submission_extensions !== undefined) {
      const raw = Array.isArray(body.allowed_submission_extensions)
        ? body.allowed_submission_extensions.join(',')
        : String(body.allowed_submission_extensions);
      const exts = raw
        .split(',')
        .map((s) => s.trim().replace(/^\./, '').toLowerCase())
        .filter((s) => /^[a-z0-9]+$/.test(s));
      if (exts.length === 0) {
        return sendJson(res, 400, {
          error: 'INVALID_EXTENSIONS',
          message_vi: 'Danh sách đuôi file cho phép không được rỗng.',
          message_en: 'Allowed file extensions list cannot be empty.'
        });
      }
      updates.allowed_submission_extensions = Array.from(new Set(exts));
    }

    if (body.max_submission_size_mb !== undefined) {
      const mb = Number(body.max_submission_size_mb);
      if (Number.isNaN(mb) || mb < 1 || mb > 100) {
        return sendJson(res, 400, {
          error: 'INVALID_MAX_SIZE',
          message_vi: 'Dung lượng file nộp tối đa phải từ 1 MB đến 100 MB.',
          message_en: 'Max submission size must be between 1 MB and 100 MB.'
        });
      }
      updates.max_submission_size_mb = mb;
    }

    if (body.badge_color_mode !== undefined) {
      updates.badge_color_mode = body.badge_color_mode === 'monochrome' ? 'monochrome' : 'subtle';
    }

    const newSettings = updateSystemSettings(updates, db);
    logAudit(db, {
      actorId: currentUser.id,
      actorUsername: currentUser.username,
      action: 'SYSTEM_CONFIG_UPDATE',
      targetType: 'system',
      targetId: 'settings',
      details: updates,
      ipAddress: clientIp
    });

    return sendJson(res, 200, { ok: true, settings: newSettings });
  }

  // Trigger email digest / deadline reminders manually (Admin utility)
  if (pathname === '/api/admin/jobs/run' && method === 'POST') {
    if (currentUser.role !== 'admin') {
      return sendJson(res, 403, { error: 'FORBIDDEN' });
    }
    const reminded = runDeadlineReminders(db);
    const digested = runDailyTeacherDigest(db);
    return sendJson(res, 200, { ok: true, reminded, digested });
  }

  // List active teachers (for Admin creating/reassigning classes)
  if (pathname === '/api/teachers' && method === 'GET') {
    if (currentUser.role !== 'admin' && currentUser.role !== 'teacher') {
      return sendJson(res, 403, { error: 'FORBIDDEN' });
    }
    const teachers = db.prepare(`
      SELECT id, username, full_name, email, status
      FROM users WHERE role = 'teacher' ORDER BY full_name ASC
    `).all();
    return sendJson(res, 200, { teachers });
  }

  // =========================================================================
  // 3.3 CLASS MANAGEMENT (CLS-01..CLS-06)
  // =========================================================================
  if (pathname === '/api/classes' && method === 'GET') {
    if (currentUser.role === 'admin') {
      const classes = db.prepare(`
        SELECT c.*, u.full_name AS teacher_name, u.username AS teacher_username,
               (SELECT COUNT(*) FROM class_members cm WHERE cm.class_id = c.id) AS student_count,
               (SELECT COUNT(*) FROM class_sessions s WHERE s.class_id = c.id) AS session_count
        FROM classes c
        JOIN users u ON u.id = c.teacher_id
        ORDER BY c.status ASC, c.id DESC
      `).all();
      return sendJson(res, 200, { classes });
    }

    if (currentUser.role === 'teacher') {
      const classes = db.prepare(`
        SELECT c.*, u.full_name AS teacher_name, u.username AS teacher_username,
               (SELECT COUNT(*) FROM class_members cm WHERE cm.class_id = c.id) AS student_count,
               (SELECT COUNT(*) FROM class_sessions s WHERE s.class_id = c.id) AS session_count
        FROM classes c
        JOIN users u ON u.id = c.teacher_id
        WHERE c.teacher_id = ?
        ORDER BY c.status ASC, c.id DESC
      `).all(currentUser.id);
      return sendJson(res, 200, { classes });
    }

    const classes = db.prepare(`
      SELECT c.*, u.full_name AS teacher_name, u.username AS teacher_username,
             (SELECT COUNT(*) FROM class_sessions s WHERE s.class_id = c.id AND s.status = 'published') AS session_count
      FROM classes c
      JOIN class_members cm ON cm.class_id = c.id
      JOIN users u ON u.id = c.teacher_id
      WHERE cm.student_id = ?
      ORDER BY c.status ASC, c.id DESC
    `).all(currentUser.id);
    return sendJson(res, 200, { classes });
  }

  // CLS-01: Create class
  if (pathname === '/api/classes' && method === 'POST') {
    if (currentUser.role !== 'admin' && currentUser.role !== 'teacher') {
      return sendJson(res, 403, { error: 'FORBIDDEN' });
    }
    const body = await readJsonBody(req);
    const name = String(body.name || '').trim();
    const description = String(body.description || '').trim();

    if (!name) {
      return sendJson(res, 400, {
        error: 'CLASS_NAME_REQUIRED',
        message_vi: 'Vui lòng nhập tên lớp học.',
        message_en: 'Class name is required.'
      });
    }

    let teacherId = currentUser.id;
    if (currentUser.role === 'admin') {
      teacherId = Number(body.teacher_id);
      const teacher = db.prepare(`SELECT id FROM users WHERE id = ? AND role = 'teacher'`).get(teacherId);
      if (!teacher) {
        return sendJson(res, 400, {
          error: 'TEACHER_REQUIRED',
          message_vi: 'Admin tạo lớp bắt buộc phải chọn Giáo viên phụ trách.',
          message_en: 'Admin must select an assigned Teacher when creating a class.'
        });
      }
    }

    const nowIso = new Date().toISOString();
    const resInsert = db.prepare(`
      INSERT INTO classes (name, description, teacher_id, status, created_by, created_at, updated_at)
      VALUES (?, ?, ?, 'active', ?, ?, ?)
    `).run(name, description, teacherId, currentUser.id, nowIso, nowIso);

    const classId = Number(resInsert.lastInsertRowid);
    logAudit(db, {
      actorId: currentUser.id,
      actorUsername: currentUser.username,
      action: 'CLASS_CREATE',
      targetType: 'class',
      targetId: classId,
      details: { name, teacher_id: teacherId },
      ipAddress: clientIp
    });

    return sendJson(res, 201, {
      ok: true,
      classId
    });
  }

  // Class detail, update, delete: /api/classes/:classId
  const classMatch = pathname.match(/^\/api\/classes\/(\d+)$/);
  if (classMatch) {
    const classId = Number(classMatch[1]);
    const access = checkClassAccess(db, currentUser, classId);
    if (!access.allowed) {
      return sendJson(res, access.status, {
        error: access.code,
        message_vi: 'Bạn không có quyền truy cập lớp học này.',
        message_en: 'You do not have permission to access this class.'
      });
    }

    const cls = access.cls;

    if (method === 'GET') {
      const studentCount = db.prepare('SELECT COUNT(*) AS cnt FROM class_members WHERE class_id = ?').get(classId).cnt;
      const sessionCount = db
        .prepare(
          currentUser.role === 'student'
            ? `SELECT COUNT(*) AS cnt FROM class_sessions WHERE class_id = ? AND status = 'published'`
            : `SELECT COUNT(*) AS cnt FROM class_sessions WHERE class_id = ?`
        )
        .get(classId).cnt;

      return sendJson(res, 200, {
        class: {
          ...cls,
          student_count: studentCount,
          session_count: sessionCount
        }
      });
    }

    // CLS-03, CLS-04, CLS-06: Update class
    if (method === 'PUT') {
      if (currentUser.role === 'student') {
        return sendJson(res, 403, { error: 'FORBIDDEN' });
      }
      const body = await readJsonBody(req);
      const name = body.name !== undefined ? String(body.name).trim() : cls.name;
      const description = body.description !== undefined ? String(body.description).trim() : cls.description;
      const status = body.status === 'archived' ? 'archived' : body.status === 'active' ? 'active' : cls.status;

      if (!name) {
        return sendJson(res, 400, {
          error: 'CLASS_NAME_REQUIRED',
          message_vi: 'Tên lớp học không được để trống.',
          message_en: 'Class name cannot be empty.'
        });
      }

      let teacherId = cls.teacher_id;
      if (body.teacher_id !== undefined && Number(body.teacher_id) !== cls.teacher_id) {
        if (currentUser.role !== 'admin') {
          return sendJson(res, 403, {
            error: 'ONLY_ADMIN_CAN_REASSIGN_TEACHER',
            message_vi: 'Chỉ Quản trị viên mới được đổi Giáo viên phụ trách lớp.',
            message_en: 'Only Administrator can change the assigned Teacher.'
          });
        }
        const t = db.prepare(`SELECT id FROM users WHERE id = ? AND role = 'teacher'`).get(Number(body.teacher_id));
        if (!t) {
          return sendJson(res, 400, { error: 'INVALID_TEACHER' });
        }
        teacherId = t.id;
      }

      const nowIso = new Date().toISOString();
      db.prepare(`
        UPDATE classes SET name = ?, description = ?, status = ?, teacher_id = ?, updated_at = ?
        WHERE id = ?
      `).run(name, description, status, teacherId, nowIso, classId);

      logAudit(db, {
        actorId: currentUser.id,
        actorUsername: currentUser.username,
        action: 'CLASS_UPDATE',
        targetType: 'class',
        targetId: classId,
        details: { name, status, teacher_id: teacherId },
        ipAddress: clientIp
      });

      return sendJson(res, 200, { ok: true });
    }

    // CLS-05: Delete class (Admin only, requires typing exact class name)
    if (method === 'DELETE') {
      if (currentUser.role !== 'admin') {
        return sendJson(res, 403, {
          error: 'ONLY_ADMIN_CAN_DELETE_CLASS',
          message_vi: 'Chỉ Quản trị viên mới có quyền xóa vĩnh viễn lớp học (CLS-05).',
          message_en: 'Only the Administrator can permanently delete a class (CLS-05).'
        });
      }
      const body = await readJsonBody(req);
      const confirmName = String(body.confirmName || '').trim();
      if (confirmName !== cls.name) {
        return sendJson(res, 400, {
          error: 'CONFIRM_NAME_MISMATCH',
          message_vi: `Tên lớp xác nhận không khớp. Vui lòng gõ chính xác: "${cls.name}"`,
          message_en: `Confirmation name does not match. Please type exactly: "${cls.name}"`
        });
      }

      // Clean up physical files for submissions and attachments in this class
      const subFiles = db.prepare(`
        SELECT sub.stored_name FROM submissions sub
        JOIN class_sessions s ON s.id = sub.session_id
        WHERE s.class_id = ?
      `).all(classId);
      for (const f of subFiles) {
        try {
          fs.unlinkSync(path.join(CONFIG.SUBMISSIONS_DIR, f.stored_name));
        } catch {}
      }

      const attFiles = db.prepare(`
        SELECT a.stored_name FROM session_attachments a
        JOIN class_sessions s ON s.id = a.session_id
        WHERE s.class_id = ?
      `).all(classId);
      for (const f of attFiles) {
        try {
          fs.unlinkSync(path.join(CONFIG.ATTACHMENTS_DIR, f.stored_name));
        } catch {}
      }

      db.prepare('DELETE FROM classes WHERE id = ?').run(classId);

      logAudit(db, {
        actorId: currentUser.id,
        actorUsername: currentUser.username,
        action: 'CLASS_DELETE',
        targetType: 'class',
        targetId: classId,
        details: { name: cls.name },
        ipAddress: clientIp
      });

      return sendJson(res, 200, { ok: true });
    }
  }

  // =========================================================================
  // 3.4 CLASS MEMBER MANAGEMENT (MEM-01..MEM-05)
  // =========================================================================
  const membersMatch = pathname.match(/^\/api\/classes\/(\d+)\/(members|available-students)(?:\/(\d+))?$/);
  if (membersMatch) {
    const classId = Number(membersMatch[1]);
    const subRoute = membersMatch[2];
    const targetStudentId = membersMatch[3] ? Number(membersMatch[3]) : null;

    const access = checkClassAccess(db, currentUser, classId);
    if (!access.allowed) {
      return sendJson(res, access.status, { error: access.code });
    }
    if (currentUser.role === 'student') {
      return sendJson(res, 403, { error: 'FORBIDDEN' });
    }

    // MEM-01: Search active students not yet in class
    if (subRoute === 'available-students' && method === 'GET') {
      const q = (urlObj.searchParams.get('q') || '').trim().toLowerCase();
      let sql = `
        SELECT u.id, u.username, u.full_name, u.email
        FROM users u
        WHERE u.role = 'student'
          AND u.status = 'active'
          AND NOT EXISTS (
            SELECT 1 FROM class_members cm WHERE cm.class_id = ? AND cm.student_id = u.id
          )
      `;
      const params = [classId];
      if (q) {
        sql += ` AND (LOWER(u.full_name) LIKE ? OR LOWER(u.username) LIKE ? OR LOWER(u.email) LIKE ?)`;
        params.push(`%${q}%`, `%${q}%`, `%${q}%`);
      }
      sql += ` ORDER BY u.full_name ASC LIMIT 50`;

      const students = db.prepare(sql).all(...params);
      return sendJson(res, 200, { students });
    }

    // MEM-04: List members with submitted / total required sessions count
    if (subRoute === 'members' && !targetStudentId && method === 'GET') {
      const totalRequired = db.prepare(`
        SELECT COUNT(*) AS cnt FROM class_sessions
        WHERE class_id = ? AND status = 'published' AND requires_submission = 1
      `).get(classId).cnt;

      const members = db.prepare(`
        SELECT u.id, u.username, u.full_name, u.email, u.status, cm.joined_at,
               (SELECT COUNT(*) FROM submissions sub
                JOIN class_sessions s ON s.id = sub.session_id
                WHERE s.class_id = ? AND s.status = 'published' AND s.requires_submission = 1 AND sub.student_id = u.id
               ) AS submitted_count
        FROM class_members cm
        JOIN users u ON u.id = cm.student_id
        WHERE cm.class_id = ?
        ORDER BY u.full_name ASC
      `).all(classId, classId);

      return sendJson(res, 200, {
        members,
        total_required_sessions: totalRequired
      });
    }

    // MEM-01, MEM-02, MEM-05: Add one or multiple students to class
    if (subRoute === 'members' && !targetStudentId && method === 'POST') {
      const body = await readJsonBody(req);
      const studentIds = Array.isArray(body.studentIds)
        ? body.studentIds.map(Number).filter(Boolean)
        : body.studentId
        ? [Number(body.studentId)]
        : [];

      if (studentIds.length === 0) {
        return sendJson(res, 400, {
          error: 'NO_STUDENTS_SELECTED',
          message_vi: 'Vui lòng chọn ít nhất 1 học sinh để thêm vào lớp.',
          message_en: 'Please select at least 1 student to add.'
        });
      }

      const nowIso = new Date().toISOString();
      const insertStmt = db.prepare(`
        INSERT OR IGNORE INTO class_members (class_id, student_id, joined_at)
        VALUES (?, ?, ?)
      `);

      let addedCount = 0;
      for (const sid of studentIds) {
        const st = db.prepare(`SELECT id, full_name FROM users WHERE id = ? AND role = 'student' AND status = 'active'`).get(sid);
        if (!st) continue;
        const resAdd = insertStmt.run(classId, sid, nowIso);
        if (resAdd.changes > 0) {
          addedCount++;
          // MEM-05 & AC-03: Notify student (web + email)
          notifyUser(db, {
            userId: sid,
            eventType: 'class_added',
            titleVi: `Bạn đã được thêm vào lớp "${access.cls.name}"`,
            titleEn: `You have been added to class "${access.cls.name}"`,
            bodyVi: `Giáo viên ${access.cls.teacher_name} đã thêm bạn vào lớp "${access.cls.name}". Hãy truy cập lớp để xem bài giảng và lịch nộp bài.`,
            bodyEn: `Teacher ${access.cls.teacher_name} added you to class "${access.cls.name}". Visit the class to view lectures and assignments.`,
            linkUrl: `#/classes/${classId}`,
            sendEmail: true
          });
        }
      }

      return sendJson(res, 200, { ok: true, addedCount });
    }

    // MEM-03: Remove student from class (preserving their old submissions & grades)
    if (subRoute === 'members' && targetStudentId && method === 'DELETE') {
      db.prepare('DELETE FROM class_members WHERE class_id = ? AND student_id = ?').run(classId, targetStudentId);
      return sendJson(res, 200, { ok: true });
    }
  }

  // =========================================================================
  // 3.5 SESSIONS & LECTURES (SES-01..SES-11)
  // =========================================================================
  const classSessionsMatch = pathname.match(/^\/api\/classes\/(\d+)\/sessions$/);
  if (classSessionsMatch) {
    const classId = Number(classSessionsMatch[1]);
    const access = checkClassAccess(db, currentUser, classId);
    if (!access.allowed) {
      return sendJson(res, access.status, {
        error: access.code,
        message_vi: 'Bạn không có quyền truy cập lớp học này.',
        message_en: 'You do not have access to this class.'
      });
    }

    // SES-09 & SES-10: List sessions in descending order of session_date
    if (method === 'GET') {
      if (currentUser.role === 'student') {
        const sessions = db.prepare(`
          SELECT s.id, s.class_id, s.title, s.session_date, s.requires_submission, s.deadline, s.status, s.created_at,
                 sub.id AS submission_id, sub.submitted_at, sub.is_late, sub.score, sub.allow_resubmit, sub.needs_regrade
          FROM class_sessions s
          LEFT JOIN submissions sub ON sub.session_id = s.id AND sub.student_id = ?
          WHERE s.class_id = ? AND s.status = 'published'
          ORDER BY s.session_date DESC, s.id DESC
        `).all(currentUser.id, classId);

        return sendJson(res, 200, { sessions });
      }

      const totalStudents = db.prepare('SELECT COUNT(*) AS cnt FROM class_members WHERE class_id = ?').get(classId).cnt;
      const sessions = db.prepare(`
        SELECT s.*,
               (SELECT COUNT(*) FROM submissions sub WHERE sub.session_id = s.id) AS submission_count,
               (SELECT COUNT(*) FROM submissions sub WHERE sub.session_id = s.id AND sub.score IS NOT NULL AND sub.needs_regrade = 0) AS graded_count
        FROM class_sessions s
        WHERE s.class_id = ?
        ORDER BY s.session_date DESC, s.id DESC
      `).all(classId);

      return sendJson(res, 200, { sessions, totalStudents });
    }

    // SES-01, SES-07, SES-11: Create session
    if (method === 'POST') {
      if (currentUser.role === 'student') {
        return sendJson(res, 403, { error: 'FORBIDDEN' });
      }
      const body = await readJsonBody(req);
      const title = String(body.title || '').trim();
      const sessionDate = String(body.session_date || new Date().toISOString().slice(0, 10)).trim();
      const contentMd = String(body.content_md || '').trim();
      const requiresSubmission = body.requires_submission ? 1 : 0;
      const deadline = requiresSubmission && body.deadline ? String(body.deadline).trim() : null;
      const status = body.status === 'draft' ? 'draft' : 'published';

      if (!title || !sessionDate || !contentMd) {
        return sendJson(res, 400, {
          error: 'MISSING_SESSION_FIELDS',
          message_vi: 'Vui lòng nhập đầy đủ Tiêu đề, Ngày học và Nội dung bài giảng.',
          message_en: 'Please enter Title, Session Date, and Lecture Content.'
        });
      }

      const nowIso = new Date().toISOString();
      const resInsert = db.prepare(`
        INSERT INTO class_sessions (
          class_id, title, session_date, content_md, requires_submission, deadline, status, created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(classId, title, sessionDate, contentMd, requiresSubmission, deadline, status, currentUser.id, nowIso, nowIso);

      const sessionId = Number(resInsert.lastInsertRowid);

      // SES-11 & BR-10: Notify class students only if published
      if (status === 'published') {
        const members = db.prepare('SELECT student_id FROM class_members WHERE class_id = ?').all(classId);
        for (const m of members) {
          notifyUser(db, {
            userId: m.student_id,
            eventType: 'session_published',
            titleVi: `Buổi học mới: ${title}`,
            titleEn: `New session published: ${title}`,
            bodyVi: `Lớp "${access.cls.name}" vừa có buổi học mới: "${title}" (Ngày học: ${sessionDate}).`,
            bodyEn: `Class "${access.cls.name}" has a new published session: "${title}" (Date: ${sessionDate}).`,
            linkUrl: `#/classes/${classId}/sessions/${sessionId}`,
            sendEmail: true
          });
        }
      }

      return sendJson(res, 201, { ok: true, sessionId });
    }
  }

  // Session detail, update, delete: /api/sessions/:sessionId
  const sessionMatch = pathname.match(/^\/api\/sessions\/(\d+)$/);
  if (sessionMatch) {
    const sessionId = Number(sessionMatch[1]);
    const session = db.prepare('SELECT * FROM class_sessions WHERE id = ?').get(sessionId);
    if (!session) {
      return sendJson(res, 404, {
        error: 'SESSION_NOT_FOUND',
        message_vi: 'Không tìm thấy buổi học.',
        message_en: 'Session not found.'
      });
    }

    const access = checkClassAccess(db, currentUser, session.class_id);
    if (!access.allowed) {
      return sendJson(res, access.status, {
        error: access.code,
        message_vi: 'Bạn không có quyền truy cập buổi học của lớp này (BR-04).',
        message_en: 'You do not have permission to access this session (BR-04).'
      });
    }

    // BR-10: Draft sessions are hidden from students
    if (currentUser.role === 'student' && session.status === 'draft') {
      return sendJson(res, 404, {
        error: 'SESSION_NOT_PUBLISHED',
        message_vi: 'Buổi học chưa được công bố.',
        message_en: 'Session is not published yet.'
      });
    }

    if (method === 'GET') {
      const attachments = db.prepare(`
        SELECT id, session_id, original_name, mime_type, size_bytes, created_at
        FROM session_attachments WHERE session_id = ? ORDER BY id ASC
      `).all(sessionId);

      let mySubmission = null;
      if (currentUser.role === 'student') {
        mySubmission = db.prepare(`
          SELECT id, session_id, student_id, original_name, mime_type, size_bytes,
                 note, submitted_at, is_late, score, feedback, graded_at, allow_resubmit, needs_regrade
          FROM submissions
          WHERE session_id = ? AND student_id = ?
        `).get(sessionId, currentUser.id);
      }

      const submissionCount = db.prepare('SELECT COUNT(*) AS cnt FROM submissions WHERE session_id = ?').get(sessionId).cnt;

      return sendJson(res, 200, {
        session,
        class: access.cls,
        attachments,
        mySubmission,
        submissionCount
      });
    }

    // SES-08, BR-07, SES-11: Update session
    if (method === 'PUT') {
      if (currentUser.role === 'student') {
        return sendJson(res, 403, { error: 'FORBIDDEN' });
      }
      const body = await readJsonBody(req);
      const title = body.title !== undefined ? String(body.title).trim() : session.title;
      const sessionDate = body.session_date !== undefined ? String(body.session_date).trim() : session.session_date;
      const contentMd = body.content_md !== undefined ? String(body.content_md).trim() : session.content_md;
      const requiresSubmission =
        body.requires_submission !== undefined ? (body.requires_submission ? 1 : 0) : session.requires_submission;
      const deadline =
        body.deadline !== undefined
          ? requiresSubmission && body.deadline
            ? String(body.deadline).trim()
            : null
          : session.deadline;
      const status = body.status === 'draft' ? 'draft' : body.status === 'published' ? 'published' : session.status;

      if (!title || !sessionDate || !contentMd) {
        return sendJson(res, 400, {
          error: 'MISSING_SESSION_FIELDS',
          message_vi: 'Tiêu đề, ngày học và nội dung không được để trống.',
          message_en: 'Title, date, and content cannot be empty.'
        });
      }

      const nowIso = new Date().toISOString();
      const deadlineChanged = deadline !== session.deadline;

      db.prepare(`
        UPDATE class_sessions
        SET title = ?, session_date = ?, content_md = ?, requires_submission = ?,
            deadline = ?, status = ?, deadline_reminded = CASE WHEN ? != COALESCE(deadline, '') THEN 0 ELSE deadline_reminded END,
            updated_at = ?
        WHERE id = ?
      `).run(title, sessionDate, contentMd, requiresSubmission, deadline, status, deadline || '', nowIso, sessionId);

      // BR-06 & BR-07: Recalculate is_late for all submissions of this session if deadline changed
      if (deadlineChanged) {
        if (!deadline) {
          db.prepare('UPDATE submissions SET is_late = 0 WHERE session_id = ?').run(sessionId);
        } else {
          db.prepare('UPDATE submissions SET is_late = CASE WHEN submitted_at > ? THEN 1 ELSE 0 END WHERE session_id = ?').run(
            deadline,
            sessionId
          );
        }
      }

      // SES-11: If transitioned from draft to published, notify class students
      if (session.status === 'draft' && status === 'published') {
        const members = db.prepare('SELECT student_id FROM class_members WHERE class_id = ?').all(session.class_id);
        for (const m of members) {
          notifyUser(db, {
            userId: m.student_id,
            eventType: 'session_published',
            titleVi: `Buổi học mới: ${title}`,
            titleEn: `New session published: ${title}`,
            bodyVi: `Lớp "${access.cls.name}" vừa công bố buổi học: "${title}".`,
            bodyEn: `Class "${access.cls.name}" published a session: "${title}".`,
            linkUrl: `#/classes/${session.class_id}/sessions/${sessionId}`,
            sendEmail: true
          });
        }
      }

      return sendJson(res, 200, { ok: true });
    }

    // SES-08: Delete session (cascades submissions & files, logs audit)
    if (method === 'DELETE') {
      if (currentUser.role === 'student') {
        return sendJson(res, 403, { error: 'FORBIDDEN' });
      }

      const subFiles = db.prepare('SELECT stored_name FROM submissions WHERE session_id = ?').all(sessionId);
      for (const f of subFiles) {
        try {
          fs.unlinkSync(path.join(CONFIG.SUBMISSIONS_DIR, f.stored_name));
        } catch {}
      }

      const attFiles = db.prepare('SELECT stored_name FROM session_attachments WHERE session_id = ?').all(sessionId);
      for (const f of attFiles) {
        try {
          fs.unlinkSync(path.join(CONFIG.ATTACHMENTS_DIR, f.stored_name));
        } catch {}
      }

      db.prepare('DELETE FROM class_sessions WHERE id = ?').run(sessionId);

      logAudit(db, {
        actorId: currentUser.id,
        actorUsername: currentUser.username,
        action: 'SESSION_DELETE',
        targetType: 'session',
        targetId: sessionId,
        details: { class_id: session.class_id, title: session.title, deleted_submissions: subFiles.length },
        ipAddress: clientIp
      });

      return sendJson(res, 200, { ok: true, deletedSubmissions: subFiles.length });
    }
  }

  // =========================================================================
  // IMAGE UPLOAD FOR MARKDOWN EDITOR (SES-03, NFR-08)
  // =========================================================================
  if (pathname === '/api/uploads/image' && method === 'POST') {
    if (currentUser.role === 'student') {
      return sendJson(res, 403, { error: 'FORBIDDEN' });
    }
    const rl = checkRateLimit(`upload:${clientIp}`, 40, 60_000);
    if (!rl.allowed) {
      return sendJson(res, 429, { error: 'RATE_LIMITED' });
    }

    const settings = getSystemSettings(db);
    const maxBytes = (settings.max_image_size_mb || CONFIG.DEFAULT_MAX_IMAGE_SIZE_MB) * 1024 * 1024;
    const body = await readJsonBody(req, maxBytes * 2);

    const originalName = String(body.fileName || 'image.png');
    const mimeType = String(body.mimeType || 'image/png');
    const base64Data = String(body.dataBase64 || '').replace(/^data:[^;]+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');

    const validation = validateUploadedFile({
      originalName,
      mimeType,
      buffer,
      allowedExtensions: CONFIG.ALLOWED_IMAGE_EXTENSIONS,
      maxSizeBytes: maxBytes,
      requireImageMagic: true
    });

    if (!validation.valid) {
      return sendJson(res, 400, {
        error: validation.code,
        message_vi:
          validation.code === 'FILE_TOO_LARGE'
            ? `Ảnh vượt quá dung lượng tối đa ${validation.maxSizeMB} MB.`
            : 'Định dạng ảnh không hợp lệ (chỉ chấp nhận jpg, jpeg, png, gif, webp ≤ 5 MB).',
        message_en:
          validation.code === 'FILE_TOO_LARGE'
            ? `Image exceeds max size of ${validation.maxSizeMB} MB.`
            : 'Invalid image format (only jpg, jpeg, png, gif, webp <= 5 MB allowed).'
      });
    }

    fs.writeFileSync(path.join(CONFIG.IMAGES_DIR, validation.storedName), buffer);
    const nowIso = new Date().toISOString();
    db.prepare(`
      INSERT INTO uploaded_images (class_id, uploaded_by, original_name, stored_name, mime_type, size_bytes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(body.classId ? Number(body.classId) : null, currentUser.id, originalName, validation.storedName, mimeType, buffer.length, nowIso);

    const url = `/api/files/images/${validation.storedName}`;
    return sendJson(res, 201, {
      ok: true,
      url,
      markdown: `![${originalName.replace(/[\[\]]/g, '')}](${url})`
    });
  }

  // Serve uploaded Markdown images to authenticated users (NFR-08)
  const imageFileMatch = pathname.match(/^\/api\/files\/images\/([a-zA-Z0-9_.-]+)$/);
  if (imageFileMatch && method === 'GET') {
    const storedName = path.basename(imageFileMatch[1]);
    const row = db.prepare('SELECT * FROM uploaded_images WHERE stored_name = ?').get(storedName);
    const filePath = path.join(CONFIG.IMAGES_DIR, storedName);
    if (!row || !fs.existsSync(filePath)) {
      return sendJson(res, 404, { error: 'IMAGE_NOT_FOUND' });
    }
    const ext = path.extname(storedName).toLowerCase();
    const mimeMap = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp'
    };
    res.writeHead(200, {
      'Content-Type': mimeMap[ext] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, max-age=3600'
    });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  // =========================================================================
  // SESSION ATTACHMENTS (SES-04, NFR-08, NFR-09)
  // =========================================================================
  const sesAttMatch = pathname.match(/^\/api\/sessions\/(\d+)\/attachments$/);
  if (sesAttMatch && method === 'POST') {
    if (currentUser.role === 'student') {
      return sendJson(res, 403, { error: 'FORBIDDEN' });
    }
    const sessionId = Number(sesAttMatch[1]);
    const session = db.prepare('SELECT * FROM class_sessions WHERE id = ?').get(sessionId);
    if (!session) return sendJson(res, 404, { error: 'SESSION_NOT_FOUND' });

    const access = checkClassAccess(db, currentUser, session.class_id);
    if (!access.allowed) return sendJson(res, access.status, { error: access.code });

    const currentCount = db.prepare('SELECT COUNT(*) AS cnt FROM session_attachments WHERE session_id = ?').get(sessionId).cnt;
    if (currentCount >= CONFIG.MAX_ATTACHMENTS_PER_SESSION) {
      return sendJson(res, 400, {
        error: 'MAX_ATTACHMENTS_REACHED',
        message_vi: `Mỗi buổi học chỉ được đính kèm tối đa ${CONFIG.MAX_ATTACHMENTS_PER_SESSION} tài liệu.`,
        message_en: `Each session can have at most ${CONFIG.MAX_ATTACHMENTS_PER_SESSION} attachments.`
      });
    }

    const settings = getSystemSettings(db);
    const maxBytes = (settings.max_attachment_size_mb || CONFIG.DEFAULT_MAX_ATTACHMENT_SIZE_MB) * 1024 * 1024;
    const body = await readJsonBody(req, maxBytes * 2);

    const originalName = String(body.fileName || '');
    const mimeType = String(body.mimeType || 'application/octet-stream');
    const base64Data = String(body.dataBase64 || '').replace(/^data:[^;]+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');

    const validation = validateUploadedFile({
      originalName,
      mimeType,
      buffer,
      allowedExtensions: CONFIG.ALLOWED_ATTACHMENT_EXTENSIONS,
      maxSizeBytes: maxBytes
    });

    if (!validation.valid) {
      return sendJson(res, 400, {
        error: validation.code,
        message_vi:
          validation.code === 'FILE_TOO_LARGE'
            ? `File đính kèm vượt quá giới hạn ${validation.maxSizeMB} MB.`
            : `Định dạng file không được hỗ trợ (${validation.ext || 'unknown'}).`,
        message_en:
          validation.code === 'FILE_TOO_LARGE'
            ? `Attachment exceeds maximum size of ${validation.maxSizeMB} MB.`
            : `Unsupported attachment format (${validation.ext || 'unknown'}).`
      });
    }

    fs.writeFileSync(path.join(CONFIG.ATTACHMENTS_DIR, validation.storedName), buffer);
    const nowIso = new Date().toISOString();
    const resAtt = db.prepare(`
      INSERT INTO session_attachments (session_id, original_name, stored_name, mime_type, size_bytes, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(sessionId, originalName, validation.storedName, mimeType, buffer.length, nowIso);

    return sendJson(res, 201, {
      ok: true,
      attachment: {
        id: Number(resAtt.lastInsertRowid),
        session_id: sessionId,
        original_name: originalName,
        mime_type: mimeType,
        size_bytes: buffer.length,
        created_at: nowIso
      }
    });
  }

  const attItemMatch = pathname.match(/^\/api\/attachments\/(\d+)(?:\/(download))?$/);
  if (attItemMatch) {
    const attachmentId = Number(attItemMatch[1]);
    const isDownload = attItemMatch[2] === 'download';
    const att = db.prepare(`
      SELECT a.*, s.class_id, s.status AS session_status
      FROM session_attachments a
      JOIN class_sessions s ON s.id = a.session_id
      WHERE a.id = ?
    `).get(attachmentId);

    if (!att) return sendJson(res, 404, { error: 'ATTACHMENT_NOT_FOUND' });

    const access = checkClassAccess(db, currentUser, att.class_id);
    if (!access.allowed) return sendJson(res, access.status, { error: access.code });
    if (currentUser.role === 'student' && att.session_status === 'draft') {
      return sendJson(res, 403, { error: 'FORBIDDEN' });
    }

    if (isDownload && method === 'GET') {
      const filePath = path.join(CONFIG.ATTACHMENTS_DIR, att.stored_name);
      if (!fs.existsSync(filePath)) return sendJson(res, 404, { error: 'FILE_MISSING_ON_DISK' });

      const safeFilename = encodeURIComponent(att.original_name);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${att.original_name.replace(/["\\]/g, '_')}"; filename*=UTF-8''${safeFilename}`,
        'X-Content-Type-Options': 'nosniff'
      });
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    if (!isDownload && method === 'DELETE') {
      if (currentUser.role === 'student') return sendJson(res, 403, { error: 'FORBIDDEN' });
      try {
        fs.unlinkSync(path.join(CONFIG.ATTACHMENTS_DIR, att.stored_name));
      } catch {}
      db.prepare('DELETE FROM session_attachments WHERE id = ?').run(attachmentId);
      return sendJson(res, 200, { ok: true });
    }
  }

  // =========================================================================
  // 3.6 STUDENT SUBMISSION (SUB-01..SUB-11, BR-05..BR-08, AC-07, AC-08, AC-11)
  // =========================================================================
  const submitMatch = pathname.match(/^\/api\/sessions\/(\d+)\/submit$/);
  if (submitMatch && method === 'POST') {
    const rl = checkRateLimit(`submit:${clientIp}`, 30, 60_000);
    if (!rl.allowed) {
      return sendJson(res, 429, { error: 'RATE_LIMITED' });
    }

    // BR-05: Only students can submit assignments
    if (currentUser.role !== 'student') {
      return sendJson(res, 403, {
        error: 'ONLY_STUDENT_CAN_SUBMIT',
        message_vi: 'Chỉ Học sinh mới được phép nộp bài tập (BR-05).',
        message_en: 'Only Students are allowed to submit assignments (BR-05).'
      });
    }

    const sessionId = Number(submitMatch[1]);
    const session = db.prepare('SELECT * FROM class_sessions WHERE id = ?').get(sessionId);
    if (!session || session.status !== 'published') {
      return sendJson(res, 404, {
        error: 'SESSION_NOT_FOUND',
        message_vi: 'Không tìm thấy buổi học.',
        message_en: 'Session not found.'
      });
    }

    const access = checkClassAccess(db, currentUser, session.class_id);
    if (!access.allowed) {
      return sendJson(res, access.status, {
        error: access.code,
        message_vi: 'Bạn không thuộc lớp học này nên không thể nộp bài (SUB-10).',
        message_en: 'You are not a member of this class and cannot submit (SUB-10).'
      });
    }

    // CLS-04 & SUB-10: Archived class is read-only
    if (access.cls.status === 'archived') {
      return sendJson(res, 403, {
        error: 'CLASS_ARCHIVED',
        message_vi: 'Lớp học đã được lưu trữ (chỉ đọc), không thể nộp bài (SUB-10).',
        message_en: 'Class is archived (read-only), submissions are disabled (SUB-10).'
      });
    }

    if (!session.requires_submission) {
      return sendJson(res, 400, {
        error: 'SESSION_NO_SUBMISSION_REQUIRED',
        message_vi: 'Buổi học này không yêu cầu nộp bài tập.',
        message_en: 'This session does not require a submission.'
      });
    }

    const existing = db
      .prepare('SELECT * FROM submissions WHERE session_id = ? AND student_id = ?')
      .get(sessionId, currentUser.id);

    // SUB-07 & BR-08: Locked after grading unless teacher enabled allow_resubmit
    if (existing && (existing.score !== null || existing.graded_at !== null) && !existing.allow_resubmit) {
      return sendJson(res, 403, {
        error: 'SUBMISSION_LOCKED_GRADED',
        message_vi: 'Bài nộp đã được giáo viên chấm điểm nên bị khóa nộp lại. Vui lòng liên hệ giáo viên nếu cần mở "Cho phép nộp lại" (SUB-07).',
        message_en: 'Your submission has already been graded and is locked. Ask your teacher to enable "Allow Resubmission" if needed (SUB-07).'
      });
    }

    const settings = getSystemSettings(db);
    const maxMB = Number(settings.max_submission_size_mb || CONFIG.DEFAULT_MAX_SUBMISSION_SIZE_MB);
    const maxBytes = maxMB * 1024 * 1024;
    const allowedExts = Array.isArray(settings.allowed_submission_extensions)
      ? settings.allowed_submission_extensions
      : CONFIG.DEFAULT_SUBMISSION_EXTENSIONS;

    let body;
    try {
      body = await readJsonBody(req, maxBytes * 2 + 1024 * 1024);
    } catch (err) {
      if (err.code === 'PAYLOAD_TOO_LARGE') {
        return sendJson(res, 400, {
          error: 'FILE_TOO_LARGE',
          message_vi: `Dung lượng file vượt quá giới hạn cho phép (${maxMB} MB).`,
          message_en: `File size exceeds maximum limit (${maxMB} MB).`
        });
      }
      throw err;
    }

    const originalName = String(body.fileName || '').trim();
    const mimeType = String(body.mimeType || 'application/octet-stream');
    const note = String(body.note || '').trim();
    if (note.length > 500) {
      return sendJson(res, 400, {
        error: 'NOTE_TOO_LONG',
        message_vi: 'Ghi chú kèm bài nộp không được vượt quá 500 ký tự (SUB-04).',
        message_en: 'Submission note cannot exceed 500 characters (SUB-04).'
      });
    }

    const base64Data = String(body.dataBase64 || '').replace(/^data:[^;]+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');

    const validation = validateUploadedFile({
      originalName,
      mimeType,
      buffer,
      allowedExtensions: allowedExts,
      maxSizeBytes: maxBytes
    });

    if (!validation.valid) {
      return sendJson(res, 400, {
        error: validation.code,
        message_vi:
          validation.code === 'FILE_TOO_LARGE'
            ? `File bài nộp vượt quá dung lượng tối đa ${maxMB} MB (SUB-01).`
            : `Định dạng file ".${validation.ext || '?'}" không nằm trong danh sách cho phép (${allowedExts.join(', ')}) (SUB-02).`,
        message_en:
          validation.code === 'FILE_TOO_LARGE'
            ? `Submission file exceeds maximum size of ${maxMB} MB (SUB-01).`
            : `File extension ".${validation.ext || '?'}" is not allowed (${allowedExts.join(', ')}) (SUB-02).`
      });
    }

    fs.writeFileSync(path.join(CONFIG.SUBMISSIONS_DIR, validation.storedName), buffer);

    // Allow client/test override of simulated timestamp only in test mode if needed, otherwise current time
    const nowIso = new Date().toISOString();
    const isLate = session.deadline && nowIso > session.deadline ? 1 : 0;

    if (existing) {
      // SUB-05: Delete previous physical file and replace record
      try {
        fs.unlinkSync(path.join(CONFIG.SUBMISSIONS_DIR, existing.stored_name));
      } catch {}

      const wasGraded = existing.score !== null || existing.graded_at !== null;
      db.prepare(`
        UPDATE submissions
        SET original_name = ?, stored_name = ?, mime_type = ?, size_bytes = ?,
            note = ?, submitted_at = ?, is_late = ?,
            allow_resubmit = 0, needs_regrade = ?, digest_sent = 0
        WHERE id = ?
      `).run(
        originalName,
        validation.storedName,
        mimeType,
        buffer.length,
        note,
        nowIso,
        isLate,
        wasGraded ? 1 : 0,
        existing.id
      );
    } else {
      db.prepare(`
        INSERT INTO submissions (
          session_id, student_id, original_name, stored_name, mime_type, size_bytes,
          note, submitted_at, is_late, score, feedback, graded_by, graded_at, allow_resubmit, needs_regrade, digest_sent
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, '', NULL, NULL, 0, 0, 0)
      `).run(sessionId, currentUser.id, originalName, validation.storedName, mimeType, buffer.length, note, nowIso, isLate);
    }

    // SUB-11: Web notification to Teacher immediately (email is sent via daily digest)
    notifyUser(db, {
      userId: access.cls.teacher_id,
      eventType: 'submission_new',
      titleVi: `Bài nộp mới từ ${currentUser.full_name}`,
      titleEn: `New submission from ${currentUser.full_name}`,
      bodyVi: `Học sinh ${currentUser.full_name} (${currentUser.username}) vừa nộp bài "${originalName}" cho buổi "${session.title}"${isLate ? ' (Trễ hạn)' : ''}.`,
      bodyEn: `Student ${currentUser.full_name} (${currentUser.username}) submitted "${originalName}" for "${session.title}"${isLate ? ' (Late)' : ''}.`,
      linkUrl: `#/classes/${session.class_id}/sessions/${sessionId}/submissions`,
      sendEmail: false // Daily digest handles teacher email per SUB-11 / 3.8.1
    });

    const updatedSub = db
      .prepare('SELECT * FROM submissions WHERE session_id = ? AND student_id = ?')
      .get(sessionId, currentUser.id);

    return sendJson(res, 200, {
      ok: true,
      submission: updatedSub
    });
  }

  // =========================================================================
  // 3.7 GRADING & SUBMISSIONS LIST (GRD-01..GRD-09, AC-10, AC-11, AC-12, AC-15)
  // =========================================================================
  const sessionSubsMatch = pathname.match(/^\/api\/sessions\/(\d+)\/(submissions|submissions-zip)$/);
  if (sessionSubsMatch && method === 'GET') {
    const sessionId = Number(sessionSubsMatch[1]);
    const isZip = sessionSubsMatch[2] === 'submissions-zip';

    const session = db.prepare('SELECT * FROM class_sessions WHERE id = ?').get(sessionId);
    if (!session) return sendJson(res, 404, { error: 'SESSION_NOT_FOUND' });

    const access = checkClassAccess(db, currentUser, session.class_id);
    if (!access.allowed) return sendJson(res, access.status, { error: access.code });

    // SUB-09: Students cannot view class submission list
    if (currentUser.role === 'student') {
      return sendJson(res, 403, {
        error: 'FORBIDDEN_STUDENT',
        message_vi: 'Học sinh không được xem danh sách bài nộp của cả lớp (SUB-09).',
        message_en: 'Students cannot view other students’ submissions (SUB-09).'
      });
    }

    // GRD-03: Download all submissions of a session as a single ZIP file
    if (isZip) {
      const subs = db.prepare(`
        SELECT sub.*, u.username, u.full_name
        FROM submissions sub
        JOIN users u ON u.id = sub.student_id
        WHERE sub.session_id = ?
        ORDER BY u.username ASC
      `).all(sessionId);

      const zipFiles = [];
      for (const s of subs) {
        const fp = path.join(CONFIG.SUBMISSIONS_DIR, s.stored_name);
        if (fs.existsSync(fp)) {
          const downloadName = formatSubmissionDownloadName(
            s.username,
            session.title,
            session.session_date,
            s.original_name
          );
          zipFiles.push({
            name: downloadName,
            data: fs.readFileSync(fp)
          });
        }
      }

      const zipBuf = createZipBuffer(zipFiles);
      const zipFilename = `submissions_session_${sessionId}_${session.session_date}.zip`;
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${zipFilename}"`,
        'X-Content-Type-Options': 'nosniff'
      });
      res.end(zipBuf);
      return;
    }

    // GRD-01: List all class students and their submission status for this session
    const statusFilter = urlObj.searchParams.get('status') || '';
    const rows = db.prepare(`
      SELECT
        u.id AS student_id,
        u.username,
        u.full_name,
        u.email,
        sub.id AS submission_id,
        sub.original_name,
        sub.mime_type,
        sub.size_bytes,
        sub.note,
        sub.submitted_at,
        sub.is_late,
        sub.score,
        sub.feedback,
        sub.graded_at,
        sub.allow_resubmit,
        sub.needs_regrade
      FROM class_members cm
      JOIN users u ON u.id = cm.student_id
      LEFT JOIN submissions sub ON sub.session_id = ? AND sub.student_id = u.id
      WHERE cm.class_id = ?
      ORDER BY u.full_name ASC
    `).all(sessionId, session.class_id);

    const items = rows.map((r) => {
      let state = 'not_submitted';
      if (r.submission_id) {
        if (r.needs_regrade) state = 'needs_regrade';
        else if (r.score !== null || r.graded_at !== null) state = 'graded';
        else if (r.is_late) state = 'late';
        else state = 'on_time';
      }
      return { ...r, computed_status: state };
    });

    const filtered = statusFilter ? items.filter((it) => it.computed_status === statusFilter) : items;

    return sendJson(res, 200, {
      session,
      class: access.cls,
      items: filtered
    });
  }

  // Individual submission operations: /api/submissions/:id/(download|preview|raw-safe|grade|allow-resubmit)
  const subDetailMatch = pathname.match(/^\/api\/submissions\/(\d+)(?:\/(download|preview|raw-safe|grade|allow-resubmit))?$/);
  if (subDetailMatch) {
    const submissionId = Number(subDetailMatch[1]);
    const action = subDetailMatch[2] || null;

    const sub = db.prepare(`
      SELECT sub.*, u.username AS student_username, u.full_name AS student_name, u.email AS student_email,
             s.class_id, s.title AS session_title, s.session_date, s.deadline
      FROM submissions sub
      JOIN users u ON u.id = sub.student_id
      JOIN class_sessions s ON s.id = sub.session_id
      WHERE sub.id = ?
    `).get(submissionId);

    if (!sub) {
      return sendJson(res, 404, {
        error: 'SUBMISSION_NOT_FOUND',
        message_vi: 'Không tìm thấy bài nộp.',
        message_en: 'Submission not found.'
      });
    }

    const access = checkClassAccess(db, currentUser, sub.class_id);
    if (!access.allowed) {
      return sendJson(res, access.status, {
        error: access.code,
        message_vi: 'Bạn không có quyền truy cập bài nộp này.',
        message_en: 'You do not have permission to access this submission.'
      });
    }

    // SUB-09 & AC-10: A student can ONLY access their own submission!
    if (currentUser.role === 'student' && sub.student_id !== currentUser.id) {
      return sendJson(res, 403, {
        error: 'FORBIDDEN_OTHER_STUDENT_SUBMISSION',
        message_vi: 'Học sinh không được phép xem hoặc tải bài nộp của học sinh khác (SUB-09 / AC-10).',
        message_en: 'Students are not allowed to view or download another student’s submission (SUB-09 / AC-10).'
      });
    }

    // GET /api/submissions/:id
    if (!action && method === 'GET') {
      return sendJson(res, 200, { submission: sub, class: access.cls });
    }

    // GRD-02 & NFR-09 & AC-15: Download submission with standardized filename & attachment header
    if (action === 'download' && method === 'GET') {
      const filePath = path.join(CONFIG.SUBMISSIONS_DIR, sub.stored_name);
      if (!fs.existsSync(filePath)) {
        return sendJson(res, 404, { error: 'FILE_MISSING_ON_DISK' });
      }

      const formattedName = formatSubmissionDownloadName(
        sub.student_username,
        sub.session_title,
        sub.session_date,
        sub.original_name
      );
      const encodedName = encodeURIComponent(formattedName);

      // NFR-09 & AC-15: Always force Content-Disposition: attachment and nosniff so .html/.js never execute
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${formattedName}"; filename*=UTF-8''${encodedName}`,
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'"
      });
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    // GRD-04 & AC-15: Safe in-browser preview metadata/content (HTML/JS returned strictly as raw text, never executed)
    if (action === 'preview' && method === 'GET') {
      const filePath = path.join(CONFIG.SUBMISSIONS_DIR, sub.stored_name);
      if (!fs.existsSync(filePath)) {
        return sendJson(res, 404, { error: 'FILE_MISSING_ON_DISK' });
      }

      const ext = path.extname(sub.original_name).replace(/^\./, '').toLowerCase();
      const textExtensions = ['txt', 'md', 'py', 'html', 'css', 'js', 'java', 'c', 'cpp', 'ipynb', 'csv'];
      const imageExtensions = ['png', 'jpg', 'jpeg', 'gif', 'webp'];

      if (textExtensions.includes(ext)) {
        const buf = fs.readFileSync(filePath);
        const content = buf.subarray(0, 200 * 1024).toString('utf8');
        return sendJson(res, 200, {
          previewType: 'code',
          language: ext,
          originalName: sub.original_name,
          content
        });
      }

      if (imageExtensions.includes(ext)) {
        return sendJson(res, 200, {
          previewType: 'image',
          originalName: sub.original_name,
          rawUrl: `/api/submissions/${sub.id}/raw-safe`
        });
      }

      if (ext === 'pdf') {
        return sendJson(res, 200, {
          previewType: 'pdf',
          originalName: sub.original_name,
          rawUrl: `/api/submissions/${sub.id}/raw-safe`
        });
      }

      return sendJson(res, 200, {
        previewType: 'unsupported',
        originalName: sub.original_name
      });
    }

    // Safe inline stream ONLY for PDF and verified image extensions (never for .html / .js!)
    if (action === 'raw-safe' && method === 'GET') {
      const filePath = path.join(CONFIG.SUBMISSIONS_DIR, sub.stored_name);
      if (!fs.existsSync(filePath)) return sendJson(res, 404, { error: 'FILE_MISSING_ON_DISK' });
      const ext = path.extname(sub.original_name).replace(/^\./, '').toLowerCase();
      const safeInlineMimes = {
        pdf: 'application/pdf',
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        gif: 'image/gif',
        webp: 'image/webp'
      };

      if (!safeInlineMimes[ext]) {
        // NFR-09: Force download for anything else
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': `attachment; filename="${sub.original_name.replace(/["\\]/g, '_')}"`,
          'X-Content-Type-Options': 'nosniff'
        });
        fs.createReadStream(filePath).pipe(res);
        return;
      }

      res.writeHead(200, {
        'Content-Type': safeInlineMimes[ext],
        'Content-Disposition': 'inline',
        'X-Content-Type-Options': 'nosniff'
      });
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    // GRD-05, GRD-06, GRD-07, BR-09, AC-11, AC-12: Grade submission
    if (action === 'grade' && method === 'PUT') {
      if (currentUser.role === 'student') {
        return sendJson(res, 403, { error: 'FORBIDDEN' });
      }
      const body = await readJsonBody(req);
      const scoreCheck = validateScore(body.score);
      if (!scoreCheck.valid) {
        return sendJson(res, 400, {
          error: scoreCheck.reason,
          message_vi: 'Điểm số không hợp lệ. Điểm phải từ 0 đến 10 và tối đa 1 chữ số thập phân (ví dụ: 8.5).',
          message_en: 'Invalid score. Score must be between 0 and 10 with at most 1 decimal place (e.g., 8.5).'
        });
      }

      const feedback = String(body.feedback || '').trim();
      if (feedback.length > 2000) {
        return sendJson(res, 400, {
          error: 'FEEDBACK_TOO_LONG',
          message_vi: 'Nhận xét không được vượt quá 2000 ký tự (GRD-05).',
          message_en: 'Feedback cannot exceed 2000 characters (GRD-05).'
        });
      }

      const nowIso = new Date().toISOString();
      const hadPreviousGrade = sub.score !== null || sub.graded_at !== null;

      db.prepare(`
        UPDATE submissions
        SET score = ?, feedback = ?, graded_by = ?, graded_at = ?, allow_resubmit = 0, needs_regrade = 0
        WHERE id = ?
      `).run(scoreCheck.value, feedback, currentUser.id, nowIso, submissionId);

      logAudit(db, {
        actorId: currentUser.id,
        actorUsername: currentUser.username,
        action: hadPreviousGrade ? 'GRADE_UPDATE' : 'GRADE_CREATE',
        targetType: 'submission',
        targetId: submissionId,
        details: {
          student_username: sub.student_username,
          session_id: sub.session_id,
          old_score: sub.score,
          new_score: scoreCheck.value
        },
        ipAddress: clientIp
      });

      // GRD-07 & AC-11: Notify student via web + email
      const scoreLabelVi = scoreCheck.value !== null ? `${scoreCheck.value}/10` : 'Nhận xét mới';
      const scoreLabelEn = scoreCheck.value !== null ? `${scoreCheck.value}/10` : 'New feedback';
      notifyUser(db, {
        userId: sub.student_id,
        eventType: 'graded',
        titleVi: `Bài nộp "${sub.session_title}" đã được chấm (${scoreLabelVi})`,
        titleEn: `Submission for "${sub.session_title}" graded (${scoreLabelEn})`,
        bodyVi: `Giáo viên đã chấm bài của bạn ở buổi "${sub.session_title}". Điểm: ${scoreLabelVi}.${feedback ? ` Nhận xét: ${feedback}` : ''}`,
        bodyEn: `Your submission for "${sub.session_title}" has been graded. Score: ${scoreLabelEn}.${feedback ? ` Feedback: ${feedback}` : ''}`,
        linkUrl: `#/classes/${sub.class_id}/sessions/${sub.session_id}`,
        sendEmail: true
      });

      return sendJson(res, 200, {
        ok: true,
        score: scoreCheck.value,
        feedback,
        graded_at: nowIso
      });
    }

    // SUB-07 & BR-08: Allow student to resubmit after grading
    if (action === 'allow-resubmit' && method === 'POST') {
      if (currentUser.role === 'student') {
        return sendJson(res, 403, { error: 'FORBIDDEN' });
      }

      db.prepare(`
        UPDATE submissions SET allow_resubmit = 1, needs_regrade = 1 WHERE id = ?
      `).run(submissionId);

      notifyUser(db, {
        userId: sub.student_id,
        eventType: 'resubmit_allowed',
        titleVi: `Giáo viên cho phép nộp lại bài: ${sub.session_title}`,
        titleEn: `Resubmission enabled for: ${sub.session_title}`,
        bodyVi: `Giáo viên đã mở quyền nộp lại cho bạn ở buổi học "${sub.session_title}". Bạn có thể tải lên bài nộp mới.`,
        bodyEn: `Your teacher has allowed you to resubmit your work for session "${sub.session_title}".`,
        linkUrl: `#/classes/${sub.class_id}/sessions/${sub.session_id}`,
        sendEmail: true
      });

      return sendJson(res, 200, { ok: true });
    }
  }

  // =========================================================================
  // GRADEBOOK & EXCEL/CSV EXPORT (GRD-08, GRD-09, S08)
  // =========================================================================
  const gradebookMatch = pathname.match(/^\/api\/classes\/(\d+)\/gradebook$/);
  if (gradebookMatch && method === 'GET') {
    const classId = Number(gradebookMatch[1]);
    const access = checkClassAccess(db, currentUser, classId);
    if (!access.allowed) return sendJson(res, access.status, { error: access.code });

    const format = urlObj.searchParams.get('format') || 'json';

    const sessions = db.prepare(`
      SELECT id, title, session_date, requires_submission, deadline
      FROM class_sessions
      WHERE class_id = ? AND status = 'published' AND requires_submission = 1
      ORDER BY session_date ASC, id ASC
    `).all(classId);

    // GRD-09: Student personal gradebook
    if (currentUser.role === 'student') {
      const mySubs = db.prepare(`
        SELECT sub.*
        FROM submissions sub
        JOIN class_sessions s ON s.id = sub.session_id
        WHERE s.class_id = ? AND sub.student_id = ?
      `).all(classId, currentUser.id);

      const subMap = new Map(mySubs.map((s) => [s.session_id, s]));
      const items = sessions.map((ses) => {
        const sub = subMap.get(ses.id) || null;
        return {
          session_id: ses.id,
          title: ses.title,
          session_date: ses.session_date,
          deadline: ses.deadline,
          submitted_at: sub?.submitted_at || null,
          is_late: Boolean(sub?.is_late),
          score: sub?.score ?? null,
          feedback: sub?.feedback || '',
          needs_regrade: Boolean(sub?.needs_regrade)
        };
      });

      return sendJson(res, 200, {
        mode: 'student',
        class: access.cls,
        items
      });
    }

    // GRD-08: Teacher / Admin class gradebook matrix
    const students = db.prepare(`
      SELECT u.id, u.username, u.full_name, u.email
      FROM class_members cm
      JOIN users u ON u.id = cm.student_id
      WHERE cm.class_id = ?
      ORDER BY u.full_name ASC
    `).all(classId);

    const allSubs = db.prepare(`
      SELECT sub.session_id, sub.student_id, sub.score, sub.is_late, sub.submitted_at, sub.feedback, sub.needs_regrade
      FROM submissions sub
      JOIN class_sessions s ON s.id = sub.session_id
      WHERE s.class_id = ? AND s.status = 'published' AND s.requires_submission = 1
    `).all(classId);

    const subLookup = new Map();
    for (const s of allSubs) {
      subLookup.set(`${s.student_id}:${s.session_id}`, s);
    }

    const rows = students.map((st) => {
      const cells = {};
      let sum = 0;
      let gradedCount = 0;
      for (const ses of sessions) {
        const entry = subLookup.get(`${st.id}:${ses.id}`) || null;
        cells[ses.id] = entry;
        if (entry && entry.score !== null && entry.score !== undefined) {
          sum += Number(entry.score);
          gradedCount++;
        }
      }
      const average = gradedCount > 0 ? Math.round((sum / gradedCount) * 10) / 10 : null;
      return {
        student: st,
        cells,
        average
      };
    });

    if (format === 'csv') {
      const header = [
        'Username',
        'Họ và tên / Full Name',
        'Email',
        ...sessions.map((s) => `${s.title} (${s.session_date})`),
        'Điểm TB / Average'
      ];
      const csvRows = [header];
      for (const r of rows) {
        const line = [
          r.student.username,
          r.student.full_name,
          r.student.email,
          ...sessions.map((s) => {
            const c = r.cells[s.id];
            if (!c) return '';
            if (c.score !== null && c.score !== undefined) return c.score;
            return c.is_late ? 'Đã nộp (Trễ)' : 'Đã nộp';
          }),
          r.average !== null ? r.average : ''
        ];
        csvRows.push(line);
      }

      const csvBuf = toCsvBuffer(csvRows);
      const filename = `bang_diem_lop_${classId}.csv`;
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'X-Content-Type-Options': 'nosniff'
      });
      res.end(csvBuf);
      return;
    }

    return sendJson(res, 200, {
      mode: 'teacher',
      class: access.cls,
      sessions,
      rows
    });
  }

  // =========================================================================
  // 3.8 NOTIFICATIONS (NOT-01..NOT-05)
  // =========================================================================
  if (pathname === '/api/notifications' && method === 'GET') {
    const notifications = db.prepare(`
      SELECT * FROM notifications
      WHERE user_id = ?
      ORDER BY id DESC
      LIMIT 100
    `).all(currentUser.id);

    const unreadCount = db.prepare(`
      SELECT COUNT(*) AS cnt FROM notifications WHERE user_id = ? AND is_read = 0
    `).get(currentUser.id).cnt;

    return sendJson(res, 200, { notifications, unreadCount });
  }

  if (pathname === '/api/notifications/read-all' && method === 'POST') {
    db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').run(currentUser.id);
    return sendJson(res, 200, { ok: true });
  }

  const notifReadMatch = pathname.match(/^\/api\/notifications\/(\d+)\/read$/);
  if (notifReadMatch && method === 'POST') {
    const notifId = Number(notifReadMatch[1]);
    db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?').run(notifId, currentUser.id);
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, {
    error: 'NOT_FOUND',
    message_vi: 'Không tìm thấy đường dẫn API.',
    message_en: 'API endpoint not found.'
  });
}
