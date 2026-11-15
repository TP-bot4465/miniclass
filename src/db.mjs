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

  // Seed initial data if no users exist yet
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
  const today = now.slice(0, 10);
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const nextWeekDeadline = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
  const tomorrowDeadline = new Date(Date.now() + 18 * 60 * 60 * 1000).toISOString();

  const insertUser = db.prepare(`
    INSERT INTO users (username, email, password_hash, full_name, role, status, must_change_password, language, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'active', ?, 'vi', ?, ?)
  `);

  const adminRes = insertUser.run('admin', 'admin@miniclass.edu.vn', hashPassword('Admin1234'), 'Quản trị viên Hệ thống', 'admin', 0, now, now);
  const gvMinhRes = insertUser.run('gv_minh', 'minh.nguyen@miniclass.edu.vn', hashPassword('Teacher123'), 'ThS. Nguyễn Văn Minh', 'teacher', 0, now, now);
  const gvLanRes = insertUser.run('gv_lan', 'lan.tran@miniclass.edu.vn', hashPassword('Teacher123'), 'Cô Trần Thị Lan', 'teacher', 0, now, now);
  const hsAnRes = insertUser.run('hs_an', 'an.le@student.edu.vn', hashPassword('Student123'), 'Lê Hoàng An', 'student', 0, now, now);
  const hsBinhRes = insertUser.run('hs_binh', 'binh.pham@student.edu.vn', hashPassword('Student123'), 'Phạm Thanh Bình', 'student', 0, now, now);
  const hsChiRes = insertUser.run('hs_chi', 'chi.do@student.edu.vn', hashPassword('Student123'), 'Đỗ Mai Chi', 'student', 0, now, now);
  insertUser.run('hs_khanh', 'khanh.vu@student.edu.vn', hashPassword('TempPass123'), 'Vũ Quốc Khánh (Đăng nhập lần đầu)', 'student', 1, now, now);

  const adminId = Number(adminRes.lastInsertRowid);
  const gvMinhId = Number(gvMinhRes.lastInsertRowid);
  const gvLanId = Number(gvLanRes.lastInsertRowid);
  const hsAnId = Number(hsAnRes.lastInsertRowid);
  const hsBinhId = Number(hsBinhRes.lastInsertRowid);
  const hsChiId = Number(hsChiRes.lastInsertRowid);

  // Create sample classes
  const insertClass = db.prepare(`
    INSERT INTO classes (name, description, teacher_id, status, created_by, created_at, updated_at)
    VALUES (?, ?, ?, 'active', ?, ?, ?)
  `);
  const clsPython = Number(
    insertClass.run(
      'Lập trình Python Cơ bản - K12',
      'Lớp học nền tảng lập trình Python, cấu trúc điều khiển, hàm và xử lý dữ liệu.',
      gvMinhId,
      gvMinhId,
      now,
      now
    ).lastInsertRowid
  );
  const clsAlgo = Number(
    insertClass.run(
      'Cấu trúc Dữ liệu & Giải thuật',
      'Phân tích độ phức tạp thuật toán, danh sách liên kết, cây nhị phân, đồ thị và quy hoạch động.',
      gvMinhId,
      gvMinhId,
      now,
      now
    ).lastInsertRowid
  );
  const clsMath = Number(
    insertClass.run(
      'Toán Rời Rạc Ứng Dụng',
      'Logic mệnh đề, tổ hợp, lý thuyết đồ thị và đại số Boole.',
      gvLanId,
      gvLanId,
      now,
      now
    ).lastInsertRowid
  );

  // Add students to classes
  const insertMember = db.prepare(`
    INSERT INTO class_members (class_id, student_id, joined_at) VALUES (?, ?, ?)
  `);
  for (const sid of [hsAnId, hsBinhId, hsChiId]) {
    insertMember.run(clsPython, sid, now);
    insertMember.run(clsAlgo, sid, now);
  }
  insertMember.run(clsMath, hsAnId, now);
  insertMember.run(clsMath, hsBinhId, now);

  // Create sample sessions in Python class
  const insertSession = db.prepare(`
    INSERT INTO class_sessions (class_id, title, session_date, content_md, requires_submission, deadline, status, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const s1Id = Number(
    insertSession.run(
      clsPython,
      'Buổi 01: Biến, Kiểu dữ liệu và Toán tử trong Python',
      yesterday,
      `# Buổi 01: Làm quen với Python 3

Chào mừng các em đến với lớp **Lập trình Python Cơ bản**. Trong buổi học đầu tiên, chúng ta tìm hiểu các kiểu dữ liệu cơ sở và cách viết chương trình chuẩn PEP 8.

## 1. Bảng tóm tắt kiểu dữ liệu

| Kiểu dữ liệu | Cú pháp mẫu | Mô tả |
| :--- | :--- | :--- |
| \`int\` | \`x = 42\` | Số nguyên không giới hạn độ dài |
| \`float\` | \`pi = 3.14159\` | Số thực dấu phẩy động |
| \`str\` | \`name = "MiniClass"\` | Chuỗi ký tự Unicode |
| \`bool\` | \`is_valid = True\` | Giá trị logic Đúng / Sai |

## 2. Ví dụ minh họa

\`\`\`python
def tinh_diem_trung_binh(diem_so: list[float]) -> float:
    """Tính điểm trung bình thang 10 làm tròn 1 chữ số thập phân."""
    if not diem_so:
        return 0.0
    return round(sum(diem_so) / len(diem_so), 1)

print("Điểm TB:", tinh_diem_trung_binh([8.5, 9.0, 7.5]))
\`\`\`

## 3. Bài tập về nhà
Viết file \`bai1_tinh_toan.py\` nhập vào bán kính hình tròn và in ra chu vi, diện tích. Nộp trực tiếp tại mục **Nộp bài tập** bên dưới.`,
      1,
      nextWeekDeadline,
      'published',
      gvMinhId,
      now,
      now
    ).lastInsertRowid
  );

  const s2Id = Number(
    insertSession.run(
      clsPython,
      'Buổi 02: Cấu trúc rẽ nhánh if-elif-else và Vòng lặp',
      today,
      `# Buổi 02: Cấu trúc điều khiển & Vòng lặp

Trong buổi học này, chúng ta nắm vững cách điều khiển luồng thực thi của chương trình bằng \`if / elif / else\`, vòng lặp \`for\` và \`while\`.

## 1. Cú pháp vòng lặp \`for\` với \`range()\`

\`\`\`python
for i in range(1, 6):
    print(f"Lần lặp thứ {i}: bình phương = {i ** 2}")
\`\`\`

## 2. Yêu cầu bài nộp
- Nộp 1 file mã nguồn \`.py\` hoặc \`.ipynb\` giải bài toán kiểm tra số nguyên tố và liệt kê $N$ số Fibonacci đầu tiên.
- Lưu ý: Hạn nộp bài là **ngày mai**!`,
      1,
      tomorrowDeadline,
      'published',
      gvMinhId,
      now,
      now
    ).lastInsertRowid
  );

  insertSession.run(
    clsPython,
    'Buổi 03: [Bản nháp] Hàm, Module và Xử lý Ngoại lệ',
    today,
    `# Buổi 03: Tổ chức mã nguồn với Hàm và Module\n\nNội dung đang được giáo viên biên soạn (Trạng thái Nháp - Học sinh chưa nhìn thấy).`,
    1,
    nextWeekDeadline,
    'draft',
    gvMinhId,
    now,
    now
  );

  // Create a sample submission for hs_an in Session 1 (already graded) and hs_binh (submitted, awaiting grade)
  const samplePyAn = Buffer.from(
    `import math\n\ndef circle_metrics(r: float):\n    return 2 * math.pi * r, math.pi * (r ** 2)\n\nif __name__ == "__main__":\n    cv, dt = circle_metrics(5.0)\n    print(f"Chu vi: {cv:.2f}, Dien tich: {dt:.2f}")\n`,
    'utf8'
  );
  const storedAn = 'seed-an-bai1.py';
  fs.writeFileSync(path.join(CONFIG.SUBMISSIONS_DIR, storedAn), samplePyAn);

  const samplePyBinh = Buffer.from(
    `# Bai tap buoi 1 - Pham Thanh Binh\nr = 10\nprint("Chu vi:", 2 * 3.14 * r)\nprint("Dien tich:", 3.14 * r * r)\n`,
    'utf8'
  );
  const storedBinh = 'seed-binh-bai1.py';
  fs.writeFileSync(path.join(CONFIG.SUBMISSIONS_DIR, storedBinh), samplePyBinh);

  const insertSubmission = db.prepare(`
    INSERT INTO submissions (
      session_id, student_id, original_name, stored_name, mime_type, size_bytes,
      note, submitted_at, is_late, score, feedback, graded_by, graded_at, allow_resubmit, needs_regrade
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertSubmission.run(
    s1Id,
    hsAnId,
    'bai1_le_hoang_an.py',
    storedAn,
    'text/x-python',
    samplePyAn.length,
    'Em đã kiểm tra với nhiều giá trị bán kính khác nhau ạ.',
    now,
    0,
    9.5,
    'Code sạch, có chia hàm và chú thích type hint rõ ràng. Rất tốt!',
    gvMinhId,
    now,
    0,
    0
  );

  insertSubmission.run(
    s1Id,
    hsBinhId,
    'bai1_binh.py',
    storedBinh,
    'text/x-python',
    samplePyBinh.length,
    'Em nộp bài buổi 1 ạ.',
    now,
    0,
    null,
    '',
    null,
    null,
    0,
    0
  );

  // Sample notifications
  const insertNotif = db.prepare(`
    INSERT INTO notifications (user_id, event_type, title_vi, title_en, body_vi, body_en, link_url, is_read, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
  `);
  insertNotif.run(
    hsAnId,
    'graded',
    'Bài nộp đã được chấm điểm',
    'Your submission has been graded',
    'ThS. Nguyễn Văn Minh đã chấm 9.5 điểm cho bài nộp của bạn ở "Buổi 01: Biến, Kiểu dữ liệu và Toán tử trong Python".',
    'ThS. Nguyễn Văn Minh graded 9.5 on your submission in "Buổi 01: Biến, Kiểu dữ liệu và Toán tử trong Python".',
    `#/classes/${clsPython}/sessions/${s1Id}`,
    now
  );
  insertNotif.run(
    gvMinhId,
    'submission_new',
    'Có bài nộp mới từ Phạm Thanh Bình',
    'New submission from Phạm Thanh Bình',
    'Học sinh Phạm Thanh Bình vừa nộp bài cho "Buổi 01: Biến, Kiểu dữ liệu và Toán tử trong Python".',
    'Student Phạm Thanh Bình submitted work for "Buổi 01: Biến, Kiểu dữ liệu và Toán tử trong Python".',
    `#/classes/${clsPython}/sessions/${s1Id}/submissions`,
    now
  );

  logAudit(db, {
    actorId: adminId,
    actorUsername: 'admin',
    action: 'SYSTEM_SEED',
    targetType: 'system',
    targetId: 'init',
    details: { message: 'Khởi tạo dữ liệu mẫu hệ thống MiniClass v1.0' }
  });
}
