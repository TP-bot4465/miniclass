import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from './config.mjs';
import { hashPassword } from './security.mjs';

let dbInstance = null;

export function getDb() {
  if (dbInstance) return dbInstance;
  fs.mkdirSync(path.dirname(CONFIG.DB_PATH), { recursive: true });
  dbInstance = new DatabaseSync(CONFIG.DB_PATH);
  dbInstance.exec('PRAGMA journal_mode = WAL;');
  dbInstance.exec('PRAGMA foreign_keys = ON;');
  initSchema(dbInstance);
  return dbInstance;
}

export function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      full_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin', 'teacher', 'student')),
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'locked')),
      must_change_password INTEGER NOT NULL DEFAULT 1,
      language TEXT NOT NULL DEFAULT 'vi' CHECK(language IN ('vi', 'en')),
      email_prefs_json TEXT NOT NULL DEFAULT '{"class_added":true,"session_published":true,"submission_new":true,"graded":true,"resubmit_allowed":true,"deadline_reminder":true}',
      failed_login_attempts INTEGER NOT NULL DEFAULT 0,
      locked_until TEXT DEFAULT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions_auth (
      token TEXT PRIMARY KEY,
      csrf_token TEXT NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      last_activity_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS classes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      teacher_id INTEGER NOT NULL REFERENCES users(id),
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'archived')),
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS class_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
      student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      joined_at TEXT NOT NULL,
      UNIQUE(class_id, student_id)
    );

    CREATE TABLE IF NOT EXISTS class_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      session_date TEXT NOT NULL,
      content_md TEXT NOT NULL,
      requires_submission INTEGER NOT NULL DEFAULT 0,
      deadline TEXT DEFAULT NULL,
      status TEXT NOT NULL DEFAULT 'published' CHECK(status IN ('draft', 'published')),
      deadline_reminded INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS session_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES class_sessions(id) ON DELETE CASCADE,
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS uploaded_images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      class_id INTEGER REFERENCES classes(id) ON DELETE SET NULL,
      uploaded_by INTEGER NOT NULL REFERENCES users(id),
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL UNIQUE,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES class_sessions(id) ON DELETE CASCADE,
      student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      submitted_at TEXT NOT NULL,
      is_late INTEGER NOT NULL DEFAULT 0,
      score REAL DEFAULT NULL,
      feedback TEXT NOT NULL DEFAULT '',
      graded_by INTEGER REFERENCES users(id),
      graded_at TEXT DEFAULT NULL,
      allow_resubmit INTEGER NOT NULL DEFAULT 0,
      needs_regrade INTEGER NOT NULL DEFAULT 0,
      digest_sent INTEGER NOT NULL DEFAULT 0,
      UNIQUE(session_id, student_id)
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      title_vi TEXT NOT NULL,
      title_en TEXT NOT NULL,
      body_vi TEXT NOT NULL,
      body_en TEXT NOT NULL,
      link_url TEXT NOT NULL DEFAULT '#/',
      is_read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS email_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      to_email TEXT NOT NULL,
      event_type TEXT NOT NULL,
      subject TEXT NOT NULL,
      body_text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'sent', 'failed')),
      error_message TEXT DEFAULT NULL,
      created_at TEXT NOT NULL,
      sent_at TEXT DEFAULT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      actor_username TEXT NOT NULL,
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT DEFAULT NULL,
      details_json TEXT NOT NULL DEFAULT '{}',
      ip_address TEXT DEFAULT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS system_settings (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_classes_teacher ON classes(teacher_id);
    CREATE INDEX IF NOT EXISTS idx_class_members_class ON class_members(class_id);
    CREATE INDEX IF NOT EXISTS idx_class_members_student ON class_members(student_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_class_date ON class_sessions(class_id, session_date DESC);
    CREATE INDEX IF NOT EXISTS idx_submissions_session ON submissions(session_id);
    CREATE INDEX IF NOT EXISTS idx_submissions_student ON submissions(student_id);
    CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at DESC);
  `);

  // Ensure default system settings exist (ADM-03)
  const now = new Date().toISOString();
  const defaultSettings = {
    allowed_submission_extensions: CONFIG.DEFAULT_SUBMISSION_EXTENSIONS,
    max_submission_size_mb: CONFIG.DEFAULT_MAX_SUBMISSION_SIZE_MB,
    max_attachment_size_mb: CONFIG.DEFAULT_MAX_ATTACHMENT_SIZE_MB,
    max_image_size_mb: CONFIG.DEFAULT_MAX_IMAGE_SIZE_MB,
    badge_color_mode: 'subtle' // OI-01: 'subtle' (muted red/green badges) or 'monochrome'
  };

  const upsertSetting = db.prepare(`
    INSERT INTO system_settings (key, value_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO NOTHING
  `);

  for (const [k, v] of Object.entries(defaultSettings)) {
    upsertSetting.run(k, JSON.stringify(v), now);
  }

  // Prune audit logs older than 12 months (ADM-02)
  const twelveMonthsAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('DELETE FROM audit_logs WHERE created_at < ?').run(twelveMonthsAgo);

  // Seed initial accounts only if no users exist yet
  const userCount = db.prepare('SELECT COUNT(*) AS cnt FROM users').get().cnt;
  if (userCount === 0) {
    seedInitialData(db);
  }
}

export function getSystemSettings(db = getDb()) {
  const rows = db.prepare('SELECT key, value_json FROM system_settings').all();
  const settings = {
    allowed_submission_extensions: CONFIG.DEFAULT_SUBMISSION_EXTENSIONS,
    max_submission_size_mb: CONFIG.DEFAULT_MAX_SUBMISSION_SIZE_MB,
    max_attachment_size_mb: CONFIG.DEFAULT_MAX_ATTACHMENT_SIZE_MB,
    max_image_size_mb: CONFIG.DEFAULT_MAX_IMAGE_SIZE_MB,
    badge_color_mode: 'subtle'
  };
  for (const r of rows) {
    try {
      settings[r.key] = JSON.parse(r.value_json);
    } catch {
      // ignore malformed
    }
  }
  return settings;
}

export function updateSystemSettings(updates, db = getDb()) {
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO system_settings (key, value_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
  `);
  for (const [k, v] of Object.entries(updates)) {
    stmt.run(k, JSON.stringify(v), now);
  }
  return getSystemSettings(db);
}

export function logAudit(db, { actorId, actorUsername, action, targetType, targetId, details = {}, ipAddress = '127.0.0.1' }) {
  db.prepare(`
    INSERT INTO audit_logs (actor_id, actor_username, action, target_type, target_id, details_json, ip_address, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    actorId || null,
    actorUsername || 'system',
    action,
    targetType,
    targetId !== undefined && targetId !== null ? String(targetId) : null,
    JSON.stringify(details),
    ipAddress,
    new Date().toISOString()
  );
}

export function seedInitialData(db = getDb()) {
  const now = new Date().toISOString();

  const upsertUser = db.prepare(`
    INSERT INTO users (username, email, password_hash, full_name, role, status, must_change_password, language, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'active', 0, 'vi', ?, ?)
    ON CONFLICT(username) DO NOTHING
  `);

  upsertUser.run(
    'admin',
    'admin@miniclass.edu.vn',
    hashPassword('Abc1234!@'),
    'Quản trị viên Hệ thống',
    'admin',
    now,
    now
  );

  upsertUser.run(
    'nguyenthanhphong',
    'nguyenthanhphong@miniclass.edu.vn',
    hashPassword('1234'),
    'Nguyễn Thanh Phong',
    'teacher',
    now,
    now
  );

  const adminRow = db.prepare("SELECT id FROM users WHERE username = 'admin'").get();
  logAudit(db, {
    actorId: adminRow?.id || null,
    actorUsername: 'admin',
    action: 'SYSTEM_SEED',
    targetType: 'system',
    targetId: 'init',
    details: { message: 'Khởi tạo dữ liệu thực tế: admin và giáo viên Nguyễn Thanh Phong (nguyenthanhphong)' }
  });
}
