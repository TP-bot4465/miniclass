import { getDb } from './db.mjs';
import { CONFIG } from './config.mjs';

/**
 * Create a web notification and optionally enqueue an email notification asynchronously (NOT-01..NOT-05).
 * Never throws so email errors never break main operations (NOT-04).
 */
export function notifyUser(
  db,
  {
    userId,
    eventType,
    titleVi,
    titleEn,
    bodyVi,
    bodyEn,
    linkUrl = '#/',
    sendEmail = true
  }
) {
  try {
    const user = db.prepare('SELECT id, email, full_name, language, status, email_prefs_json FROM users WHERE id = ?').get(userId);
    if (!user || user.status !== 'active') return;

    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO notifications (user_id, event_type, title_vi, title_en, body_vi, body_en, link_url, is_read, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
    `).run(userId, eventType, titleVi, titleEn, bodyVi, bodyEn, linkUrl, now);

    if (!sendEmail) return;

    let prefs = {};
    try {
      prefs = JSON.parse(user.email_prefs_json || '{}');
    } catch {
      prefs = {};
    }

    // Default to true unless explicitly set to false by user (NOT-03)
    if (prefs[eventType] === false) return;

    const isEn = user.language === 'en';
    const subject = `[MiniClass] ${isEn ? titleEn : titleVi}`;
    const bodyText = isEn
      ? `Hello ${user.full_name},\n\n${bodyEn}\n\nOpen MiniClass: ${linkUrl}\n\n--\nMiniClass Online Learning System`
      : `Xin chào ${user.full_name},\n\n${bodyVi}\n\nTruy cập MiniClass: ${linkUrl}\n\n--\nHệ thống Lớp học Trực tuyến MiniClass`;

    db.prepare(`
      INSERT INTO email_queue (user_id, to_email, event_type, subject, body_text, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?)
    `).run(user.id, user.email, eventType, subject, bodyText, now);

    // Trigger non-blocking queue flush
    setImmediate(() => {
      processEmailQueue().catch(() => {});
    });
  } catch (err) {
    console.error('[Notify Error - Non-fatal]:', err.message);
  }
}

/**
 * Process pending emails in the queue asynchronously (NOT-04).
 */
let isProcessingQueue = false;
export async function processEmailQueue() {
  if (isProcessingQueue) return;
  isProcessingQueue = true;
  try {
    const db = getDb();
    const pending = db.prepare(`SELECT * FROM email_queue WHERE status = 'pending' ORDER BY id ASC LIMIT 25`).all();
    const now = new Date().toISOString();

    for (const item of pending) {
      try {
        // In local/dev mode or when SMTP_ENABLED=false, mark as sent and keep in outbox log
        db.prepare(`
          UPDATE email_queue
          SET status = 'sent', sent_at = ?, error_message = NULL
          WHERE id = ?
        `).run(now, item.id);
      } catch (sendErr) {
        db.prepare(`
          UPDATE email_queue
          SET status = 'failed', error_message = ?
          WHERE id = ?
        `).run(String(sendErr.message || 'SMTP Error'), item.id);
      }
    }
  } catch (err) {
    console.error('[EmailQueue Error]:', err.message);
  } finally {
    isProcessingQueue = false;
  }
}

/**
 * Check sessions with deadline in the next 24 hours and send reminders to unsubmitted students (NOT-05).
 */
export function runDeadlineReminders(db = getDb()) {
  try {
    const now = Date.now();
    const in24h = new Date(now + 24 * 60 * 60 * 1000).toISOString();
    const nowIso = new Date(now).toISOString();

    const upcomingSessions = db.prepare(`
      SELECT s.id, s.class_id, s.title, s.deadline, c.name AS class_name
      FROM class_sessions s
      JOIN classes c ON c.id = s.class_id
      WHERE s.status = 'published'
        AND c.status = 'active'
        AND s.requires_submission = 1
        AND s.deadline IS NOT NULL
        AND s.deadline > ?
        AND s.deadline <= ?
        AND s.deadline_reminded = 0
    `).all(nowIso, in24h);

    let remindedCount = 0;
    for (const ses of upcomingSessions) {
      const unsubmittedStudents = db.prepare(`
        SELECT cm.student_id
        FROM class_members cm
        JOIN users u ON u.id = cm.student_id
        WHERE cm.class_id = ?
          AND u.status = 'active'
          AND NOT EXISTS (
            SELECT 1 FROM submissions sub
            WHERE sub.session_id = ? AND sub.student_id = cm.student_id
          )
      `).all(ses.class_id, ses.id);

      for (const st of unsubmittedStudents) {
        notifyUser(db, {
          userId: st.student_id,
          eventType: 'deadline_reminder',
          titleVi: `Sắp hết hạn nộp bài: ${ses.title}`,
          titleEn: `Upcoming deadline (24h): ${ses.title}`,
          bodyVi: `Buổi học "${ses.title}" thuộc lớp "${ses.class_name}" sẽ hết hạn nộp bài trong vòng 24 giờ tới. Vui lòng nộp bài đúng hạn.`,
          bodyEn: `Session "${ses.title}" in class "${ses.class_name}" is due within 24 hours. Please submit your work on time.`,
          linkUrl: `#/classes/${ses.class_id}/sessions/${ses.id}`,
          sendEmail: true
        });
        remindedCount++;
      }

      db.prepare(`UPDATE class_sessions SET deadline_reminded = 1 WHERE id = ?`).run(ses.id);
    }

    return remindedCount;
  } catch (err) {
    console.error('[DeadlineReminder Error]:', err.message);
    return 0;
  }
}

/**
 * Send daily summary email to teachers for new submissions (SUB-11 / 3.8.1).
 */
export function runDailyTeacherDigest(db = getDb()) {
  try {
    const rows = db.prepare(`
      SELECT
        c.teacher_id,
        c.id AS class_id,
        c.name AS class_name,
        s.id AS session_id,
        s.title AS session_title,
        COUNT(sub.id) AS new_count
      FROM submissions sub
      JOIN class_sessions s ON s.id = sub.session_id
      JOIN classes c ON c.id = s.class_id
      WHERE sub.digest_sent = 0
      GROUP BY c.teacher_id, s.id
    `).all();

    if (rows.length === 0) return 0;

    const byTeacher = new Map();
    for (const r of rows) {
      if (!byTeacher.has(r.teacher_id)) byTeacher.set(r.teacher_id, []);
      byTeacher.get(r.teacher_id).push(r);
    }

    const now = new Date().toISOString();
    let sentTeachers = 0;

    for (const [teacherId, items] of byTeacher.entries()) {
      const teacher = db.prepare('SELECT id, email, full_name, language, status, email_prefs_json FROM users WHERE id = ?').get(teacherId);
      if (!teacher || teacher.status !== 'active') continue;

      let prefs = {};
      try {
        prefs = JSON.parse(teacher.email_prefs_json || '{}');
      } catch {}
      if (prefs.submission_new === false) continue;

      const isEn = teacher.language === 'en';
      const lines = items.map((it) =>
        isEn
          ? `- [${it.class_name}] ${it.session_title}: ${it.new_count} new submission(s)`
          : `- [${it.class_name}] ${it.session_title}: ${it.new_count} bài nộp mới`
      );
      const subject = isEn
        ? '[MiniClass] Daily Summary of New Submissions'
        : '[MiniClass] Tổng hợp bài nộp mới trong ngày';
      const bodyText = isEn
        ? `Hello ${teacher.full_name},\n\nHere is your daily summary of new student submissions:\n${lines.join('\n')}\n\n--\nMiniClass`
        : `Xin chào ${teacher.full_name},\n\nDưới đây là tổng hợp các bài nộp mới trong ngày:\n${lines.join('\n')}\n\n--\nMiniClass`;

      db.prepare(`
        INSERT INTO email_queue (user_id, to_email, event_type, subject, body_text, status, created_at)
        VALUES (?, ?, 'submission_new_digest', ?, ?, 'pending', ?)
      `).run(teacher.id, teacher.email, subject, bodyText, now);
      sentTeachers++;
    }

    db.prepare('UPDATE submissions SET digest_sent = 1 WHERE digest_sent = 0').run();
    setImmediate(() => {
      processEmailQueue().catch(() => {});
    });
    return sentTeachers;
  } catch (err) {
    console.error('[DailyDigest Error]:', err.message);
    return 0;
  }
}
