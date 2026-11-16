import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from './config.mjs';

export const EXAM_FILES_DIR = path.join(CONFIG.UPLOAD_DIR, 'exam_files');
fs.mkdirSync(EXAM_FILES_DIR, { recursive: true });

export function initExamsSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS exams (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      duration_minutes INTEGER NOT NULL DEFAULT 45,
      status TEXT NOT NULL DEFAULT 'published' CHECK(status IN ('draft', 'published')),
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS exam_questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
      part_type TEXT NOT NULL CHECK(part_type IN ('mcq', 'essay')),
      question_text TEXT NOT NULL,
      option_a TEXT DEFAULT '',
      option_b TEXT DEFAULT '',
      option_c TEXT DEFAULT '',
      option_d TEXT DEFAULT '',
      correct_answer TEXT DEFAULT '',
      essay_lang TEXT DEFAULT 'text',
      points REAL NOT NULL DEFAULT 1.0,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS exam_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
      student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      started_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      submitted_at TEXT DEFAULT NULL,
      status TEXT NOT NULL DEFAULT 'in_progress' CHECK(status IN ('in_progress', 'submitted', 'graded')),
      mcq_score REAL NOT NULL DEFAULT 0,
      essay_score REAL DEFAULT NULL,
      total_score REAL DEFAULT NULL,
      teacher_feedback TEXT NOT NULL DEFAULT '',
      violation_count INTEGER NOT NULL DEFAULT 0,
      UNIQUE(exam_id, student_id)
    );

    CREATE TABLE IF NOT EXISTS exam_answers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      attempt_id INTEGER NOT NULL REFERENCES exam_attempts(id) ON DELETE CASCADE,
      question_id INTEGER NOT NULL REFERENCES exam_questions(id) ON DELETE CASCADE,
      selected_option TEXT DEFAULT '',
      essay_text TEXT DEFAULT '',
      essay_lang TEXT DEFAULT 'text',
      file_original_name TEXT DEFAULT NULL,
      file_stored_name TEXT DEFAULT NULL,
      file_mime_type TEXT DEFAULT NULL,
      file_size_bytes INTEGER DEFAULT NULL,
      is_correct INTEGER DEFAULT NULL,
      awarded_points REAL DEFAULT NULL,
      teacher_comment TEXT NOT NULL DEFAULT '',
      UNIQUE(attempt_id, question_id)
    );

    CREATE TABLE IF NOT EXISTS exam_anticheat_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      attempt_id INTEGER NOT NULL REFERENCES exam_attempts(id) ON DELETE CASCADE,
      student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      details TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_exams_class ON exams(class_id);
    CREATE INDEX IF NOT EXISTS idx_exam_questions_exam ON exam_questions(exam_id, sort_order ASC);
    CREATE INDEX IF NOT EXISTS idx_exam_attempts_exam ON exam_attempts(exam_id);
    CREATE INDEX IF NOT EXISTS idx_exam_attempts_student ON exam_attempts(student_id);
    CREATE INDEX IF NOT EXISTS idx_exam_anticheat_attempt ON exam_anticheat_logs(attempt_id, created_at ASC);
  `);

  // Seed a sample exam if no exams exist yet and classes exist
  const examCount = db.prepare('SELECT COUNT(*) AS cnt FROM exams').get().cnt;
  const firstClass = db.prepare('SELECT id, teacher_id FROM classes ORDER BY id ASC LIMIT 1').get();
  if (examCount === 0 && firstClass) {
    const now = new Date().toISOString();
    const resExam = db.prepare(`
      INSERT INTO exams (class_id, title, description, duration_minutes, status, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'published', ?, ?, ?)
    `).run(
      firstClass.id,
      'Kiểm tra định kỳ số 01: Cơ sở Lập trình & Giải thuật',
      'Bài kiểm tra gồm 2 phần: Phần 1 Trắc nghiệm (chấm điểm tự động ngay) và Phần 2 Tự luận / Viết code (Giáo viên chấm tay). Thời gian tính từ lúc bấm Bắt đầu.',
      30,
      firstClass.teacher_id,
      now,
      now
    );

    const examId = Number(resExam.lastInsertRowid);
    const insertQ = db.prepare(`
      INSERT INTO exam_questions (
        exam_id, part_type, question_text, option_a, option_b, option_c, option_d,
        correct_answer, essay_lang, points, sort_order
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertQ.run(
      examId,
      'mcq',
      'Trong Python, kiểu dữ liệu nào sau đây là bất biến (immutable)?',
      'list',
      'dict',
      'tuple',
      'set',
      'C',
      'text',
      2.0,
      1
    );

    insertQ.run(
      examId,
      'mcq',
      'Kết quả của biểu thức 7 // 2 trong Python 3 là bao nhiêu?',
      '3.5',
      '3',
      '4',
      '1',
      'B',
      'text',
      2.0,
      2
    );

    insertQ.run(
      examId,
      'mcq',
      'Từ khóa nào dùng để khai báo hàm trong Python?',
      'function',
      'func',
      'def',
      'lambda',
      'C',
      'text',
      2.0,
      3
    );

    insertQ.run(
      examId,
      'essay',
      'Viết hàm kiểm tra một số nguyên dương n có phải là số nguyên tố hay không (có thể viết bằng Python, JS, Lua, C++, C Arduino hoặc đính kèm file Word/Code).',
      '',
      '',
      '',
      '',
      '',
      'python',
      4.0,
      4
    );
  }
}
