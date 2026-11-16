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
}
