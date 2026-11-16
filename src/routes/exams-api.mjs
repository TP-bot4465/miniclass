import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getDb, logAudit } from '../db.mjs';
import { authenticateRequest, sendJson, readJsonBody } from './api.mjs';
import { parseCsvRows, toCsvBuffer } from '../csv.mjs';
import { notifyUser } from '../email.mjs';
import { EXAM_FILES_DIR } from '../exams-db.mjs';

const ALLOWED_ESSAY_FILE_EXTS = [
  'doc', 'docx', 'pdf', 'txt', 'md', 'js', 'py', 'lua', 'c', 'cpp', 'h', 'hpp', 'ino', 'zip', 'rar'
];

function checkClassPermission(db, user, classId) {
  const cls = db.prepare(`
    SELECT c.*, u.full_name AS teacher_name
    FROM classes c
    JOIN users u ON u.id = c.teacher_id
    WHERE c.id = ?
  `).get(classId);

  if (!cls) return { allowed: false, status: 404, code: 'CLASS_NOT_FOUND' };
  if (user.role === 'admin') return { allowed: true, cls };
  if (user.role === 'teacher') {
    if (cls.teacher_id !== user.id) return { allowed: false, status: 403, code: 'FORBIDDEN_CLASS' };
    return { allowed: true, cls };
  }
  if (user.role === 'student') {
    const m = db.prepare('SELECT id FROM class_members WHERE class_id = ? AND student_id = ?').get(classId, user.id);
    if (!m) return { allowed: false, status: 403, code: 'FORBIDDEN_NOT_MEMBER' };
    return { allowed: true, cls };
  }
  return { allowed: false, status: 403, code: 'FORBIDDEN' };
}

export async function handleExamsApiRequest(req, res, urlObj) {
  const db = getDb();
  const pathname = urlObj.pathname;
  const method = req.method.toUpperCase();
  const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || '127.0.0.1';

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
  if (currentUser.must_change_password) {
    return sendJson(res, 403, {
      error: 'MUST_CHANGE_PASSWORD',
      message_vi: 'Bạn cần đổi mật khẩu tạm thời trước khi sử dụng hệ thống.',
      message_en: 'You must change your temporary password before using the system.'
    });
  }

  // 1. Download Sample CSV for MCQ Questions
  if (pathname === '/api/exams/sample-csv' && method === 'GET') {
    const sampleRows = [
      ['question', 'option_a', 'option_b', 'option_c', 'option_d', 'correct_answer', 'points'],
      [
        'Trong ngôn ngữ C của Arduino, hàm nào chạy lặp lại liên tục sau khi khởi động?',
        'setup()',
        'loop()',
        'main()',
        'start()',
        'B',
        '1'
      ],
      [
        'Trong Python, kiểu dữ liệu nào lưu trữ các cặp khóa - giá trị (key-value)?',
        'list',
        'tuple',
        'dict',
        'set',
        'C',
        '1'
      ],
      [
        'Trong Lua, chỉ số (index) đầu tiên của một mảng (table) mặc định bắt đầu từ mấy?',
        '0',
        '1',
        '-1',
        '2',
        'B',
        '1'
      ]
    ];
    const buf = toCsvBuffer(sampleRows);
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="mau_cau_hoi_trac_nghiem.csv"',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(buf);
    return;
  }

  // 2. Parse CSV Text into MCQ Questions
  if (pathname === '/api/exams/parse-csv' && method === 'POST') {
    if (currentUser.role === 'student') {
      return sendJson(res, 403, { error: 'FORBIDDEN' });
    }
    const body = await readJsonBody(req);
    const rows = parseCsvRows(body.csvText || '');
    if (rows.length === 0) {
      return sendJson(res, 400, {
        error: 'CSV_EMPTY',
        message_vi: 'Nội dung CSV trống hoặc không hợp lệ.',
        message_en: 'CSV content is empty or invalid.'
      });
    }

    let startIdx = 0;
    const headerLower = rows[0].map((c) => String(c || '').toLowerCase().trim());
    if (headerLower.includes('question') || headerLower.includes('option_a') || headerLower.includes('câu hỏi')) {
      startIdx = 1;
    }

    const questions = [];
    const errors = [];

    for (let i = startIdx; i < rows.length; i++) {
      const rowNum = i + 1;
      const r = rows[i];
      const question_text = String(r[0] || '').trim();
      const option_a = String(r[1] || '').trim();
      const option_b = String(r[2] || '').trim();
      const option_c = String(r[3] || '').trim();
      const option_d = String(r[4] || '').trim();
      const correct_answer = String(r[5] || '').trim().toUpperCase();
      const pointsRaw = r[6] !== undefined && String(r[6]).trim() !== '' ? Number(r[6]) : 1;

      if (!question_text || !option_a || !option_b) {
        errors.push({
          row: rowNum,
          message_vi: `Dòng ${rowNum}: Thiếu nội dung câu hỏi hoặc phương án A, B.`,
          message_en: `Row ${rowNum}: Missing question text or options A, B.`
        });
        continue;
      }

      if (!['A', 'B', 'C', 'D'].includes(correct_answer)) {
        errors.push({
          row: rowNum,
          message_vi: `Dòng ${rowNum}: Đáp án đúng phải là A, B, C hoặc D (nhận được "${correct_answer}").`,
          message_en: `Row ${rowNum}: correct_answer must be A, B, C, or D (got "${correct_answer}").`
        });
        continue;
      }

      const points = !Number.isNaN(pointsRaw) && pointsRaw > 0 ? Math.round(pointsRaw * 100) / 100 : 1;
      questions.push({
        part_type: 'mcq',
        question_text,
        option_a,
        option_b,
        option_c,
        option_d,
        correct_answer,
        essay_lang: 'text',
        points
      });
    }

    return sendJson(res, 200, { ok: true, questions, errors });
  }

  // 3. List Exams & Create Exam (/api/exams)
  if (pathname === '/api/exams' && method === 'GET') {
    const classIdFilter = urlObj.searchParams.get('classId') ? Number(urlObj.searchParams.get('classId')) : null;

    if (currentUser.role === 'student') {
      let sql = `
        SELECT e.*, c.name AS class_name, u.full_name AS teacher_name,
               (SELECT COUNT(*) FROM exam_questions q WHERE q.exam_id = e.id AND q.part_type = 'mcq') AS mcq_count,
               (SELECT COUNT(*) FROM exam_questions q WHERE q.exam_id = e.id AND q.part_type = 'essay') AS essay_count,
               (SELECT COALESCE(SUM(q.points), 0) FROM exam_questions q WHERE q.exam_id = e.id) AS max_points,
               att.id AS attempt_id, att.status AS attempt_status, att.started_at, att.expires_at,
               att.submitted_at, att.mcq_score, att.essay_score, att.total_score, att.violation_count
        FROM exams e
        JOIN classes c ON c.id = e.class_id
        JOIN class_members cm ON cm.class_id = c.id
        JOIN users u ON u.id = c.teacher_id
        LEFT JOIN exam_attempts att ON att.exam_id = e.id AND att.student_id = ?
        WHERE cm.student_id = ? AND e.status = 'published'
      `;
      const params = [currentUser.id, currentUser.id];
      if (classIdFilter) {
        sql += ` AND e.class_id = ?`;
        params.push(classIdFilter);
      }
      sql += ` ORDER BY e.id DESC`;
      const exams = db.prepare(sql).all(...params);
      return sendJson(res, 200, { exams });
    }

    // Teacher or Admin
    let sql = `
      SELECT e.*, c.name AS class_name, u.full_name AS teacher_name,
             (SELECT COUNT(*) FROM exam_questions q WHERE q.exam_id = e.id AND q.part_type = 'mcq') AS mcq_count,
             (SELECT COUNT(*) FROM exam_questions q WHERE q.exam_id = e.id AND q.part_type = 'essay') AS essay_count,
             (SELECT COALESCE(SUM(q.points), 0) FROM exam_questions q WHERE q.exam_id = e.id) AS max_points,
             (SELECT COUNT(*) FROM exam_attempts att WHERE att.exam_id = e.id) AS attempt_count,
             (SELECT COUNT(*) FROM exam_attempts att WHERE att.exam_id = e.id AND att.status = 'submitted') AS ungraded_count
      FROM exams e
      JOIN classes c ON c.id = e.class_id
      JOIN users u ON u.id = c.teacher_id
      WHERE 1=1
    `;
    const params = [];
    if (currentUser.role === 'teacher') {
      sql += ` AND c.teacher_id = ?`;
      params.push(currentUser.id);
    }
    if (classIdFilter) {
      sql += ` AND e.class_id = ?`;
      params.push(classIdFilter);
    }
    sql += ` ORDER BY e.id DESC`;
    const exams = db.prepare(sql).all(...params);
    return sendJson(res, 200, { exams });
  }

  if (pathname === '/api/exams' && method === 'POST') {
    if (currentUser.role === 'student') {
      return sendJson(res, 403, { error: 'FORBIDDEN' });
    }
    const body = await readJsonBody(req);
    const classId = Number(body.class_id);
    const title = String(body.title || '').trim();
    const description = String(body.description || '').trim();
    const durationMinutes = Math.max(1, Math.min(300, Number(body.duration_minutes || 45)));
    const status = body.status === 'draft' ? 'draft' : 'published';
    const questions = Array.isArray(body.questions) ? body.questions : [];

    if (!classId || !title) {
      return sendJson(res, 400, {
        error: 'MISSING_FIELDS',
        message_vi: 'Vui lòng chọn lớp học và nhập tiêu đề bài kiểm tra.',
        message_en: 'Please select a class and enter an exam title.'
      });
    }

    const perm = checkClassPermission(db, currentUser, classId);
    if (!perm.allowed) {
      return sendJson(res, perm.status, { error: perm.code });
    }

    if (questions.length === 0) {
      return sendJson(res, 400, {
        error: 'NO_QUESTIONS',
        message_vi: 'Bài kiểm tra phải có ít nhất 1 câu hỏi (Trắc nghiệm hoặc Tự luận).',
        message_en: 'Exam must contain at least 1 question.'
      });
    }

    const nowIso = new Date().toISOString();
    const resExam = db.prepare(`
      INSERT INTO exams (class_id, title, description, duration_minutes, status, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(classId, title, description, durationMinutes, status, currentUser.id, nowIso, nowIso);

    const examId = Number(resExam.lastInsertRowid);
    const insertQ = db.prepare(`
      INSERT INTO exam_questions (
        exam_id, part_type, question_text, option_a, option_b, option_c, option_d,
        correct_answer, essay_lang, points, sort_order
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    questions.forEach((q, idx) => {
      const partType = q.part_type === 'essay' ? 'essay' : 'mcq';
      const pts = Math.max(0.1, Number(q.points || 1));
      insertQ.run(
        examId,
        partType,
        String(q.question_text || '').trim(),
        String(q.option_a || '').trim(),
        String(q.option_b || '').trim(),
        String(q.option_c || '').trim(),
        String(q.option_d || '').trim(),
        partType === 'mcq' ? String(q.correct_answer || 'A').trim().toUpperCase() : '',
        partType === 'essay' ? String(q.essay_lang || 'text').trim() : 'text',
        pts,
        idx + 1
      );
    });

    if (status === 'published') {
      const members = db.prepare('SELECT student_id FROM class_members WHERE class_id = ?').all(classId);
      for (const m of members) {
        notifyUser(db, {
          userId: m.student_id,
          eventType: 'session_published',
          titleVi: `Bài kiểm tra mới: ${title}`,
          titleEn: `New exam published: ${title}`,
          bodyVi: `Lớp "${perm.cls.name}" có bài kiểm tra mới: "${title}" (Thời gian: ${durationMinutes} phút).`,
          bodyEn: `Class "${perm.cls.name}" has a new exam: "${title}" (Duration: ${durationMinutes} mins).`,
          linkUrl: `#/exams/${examId}`,
          sendEmail: false
        });
      }
    }

    logAudit(db, {
      actorId: currentUser.id,
      actorUsername: currentUser.username,
      action: 'EXAM_CREATE',
      targetType: 'exam',
      targetId: examId,
      details: { class_id: classId, title, question_count: questions.length },
      ipAddress: clientIp
    });

    return sendJson(res, 201, { ok: true, examId });
  }

  // 4. Exam Detail, Update, Delete, Start, Submit, Anti-Cheat, Attempts: /api/exams/:examId/*
  const examRouteMatch = pathname.match(/^\/api\/exams\/(\d+)(?:\/(start|submit|anti-cheat|attempts))?$/);
  if (examRouteMatch) {
    const examId = Number(examRouteMatch[1]);
    const subAction = examRouteMatch[2] || null;

    const exam = db.prepare(`
      SELECT e.*, c.name AS class_name, c.teacher_id, c.status AS class_status, u.full_name AS teacher_name
      FROM exams e
      JOIN classes c ON c.id = e.class_id
      JOIN users u ON u.id = c.teacher_id
      WHERE e.id = ?
    `).get(examId);

    if (!exam) {
      return sendJson(res, 404, {
        error: 'EXAM_NOT_FOUND',
        message_vi: 'Không tìm thấy bài kiểm tra.',
        message_en: 'Exam not found.'
      });
    }

    const perm = checkClassPermission(db, currentUser, exam.class_id);
    if (!perm.allowed) {
      return sendJson(res, perm.status, {
        error: perm.code,
        message_vi: 'Bạn không có quyền truy cập bài kiểm tra này.',
        message_en: 'You do not have permission to access this exam.'
      });
    }

    if (currentUser.role === 'student' && exam.status === 'draft') {
      return sendJson(res, 404, { error: 'EXAM_NOT_PUBLISHED' });
    }

    // GET /api/exams/:examId
    if (!subAction && method === 'GET') {
      const allQuestions = db.prepare(`
        SELECT * FROM exam_questions WHERE exam_id = ? ORDER BY sort_order ASC, id ASC
      `).all(examId);

      const mcqPoints = allQuestions.filter((q) => q.part_type === 'mcq').reduce((a, b) => a + b.points, 0);
      const essayPoints = allQuestions.filter((q) => q.part_type === 'essay').reduce((a, b) => a + b.points, 0);

      if (currentUser.role === 'student') {
        const myAttempt = db.prepare(`
          SELECT * FROM exam_attempts WHERE exam_id = ? AND student_id = ?
        `).get(examId, currentUser.id);

        // Before student clicks "Start Exam", do not expose question texts
        if (!myAttempt) {
          return sendJson(res, 200, {
            exam: {
              ...exam,
              mcq_count: allQuestions.filter((q) => q.part_type === 'mcq').length,
              essay_count: allQuestions.filter((q) => q.part_type === 'essay').length,
              mcq_points: mcqPoints,
              essay_points: essayPoints,
              total_points: mcqPoints + essayPoints
            },
            myAttempt: null,
            questions: []
          });
        }

        const myAnswers = db.prepare(`
          SELECT * FROM exam_answers WHERE attempt_id = ?
        `).all(myAttempt.id);
        const ansMap = new Map(myAnswers.map((a) => [a.question_id, a]));

        const isFinished = myAttempt.status === 'submitted' || myAttempt.status === 'graded';
        const safeQuestions = allQuestions.map((q) => {
          const ans = ansMap.get(q.id) || null;
          return {
            id: q.id,
            part_type: q.part_type,
            question_text: q.question_text,
            option_a: q.option_a,
            option_b: q.option_b,
            option_c: q.option_c,
            option_d: q.option_d,
            essay_lang: q.essay_lang,
            points: q.points,
            // Only reveal correct_answer after submission
            correct_answer: isFinished ? q.correct_answer : undefined,
            my_answer: ans
          };
        });

        return sendJson(res, 200, {
          exam: {
            ...exam,
            mcq_count: allQuestions.filter((q) => q.part_type === 'mcq').length,
            essay_count: allQuestions.filter((q) => q.part_type === 'essay').length,
            mcq_points: mcqPoints,
            essay_points: essayPoints,
            total_points: mcqPoints + essayPoints
          },
          myAttempt,
          questions: safeQuestions
        });
      }

      // Teacher / Admin gets full questions including correct_answer
      return sendJson(res, 200, {
        exam: {
          ...exam,
          mcq_count: allQuestions.filter((q) => q.part_type === 'mcq').length,
          essay_count: allQuestions.filter((q) => q.part_type === 'essay').length,
          mcq_points: mcqPoints,
          essay_points: essayPoints,
          total_points: mcqPoints + essayPoints
        },
        questions: allQuestions
      });
    }

    // PUT /api/exams/:examId (Update exam & questions)
    if (!subAction && method === 'PUT') {
      if (currentUser.role === 'student') return sendJson(res, 403, { error: 'FORBIDDEN' });
      const body = await readJsonBody(req);
      const title = body.title !== undefined ? String(body.title).trim() : exam.title;
      const description = body.description !== undefined ? String(body.description).trim() : exam.description;
      const durationMinutes =
        body.duration_minutes !== undefined
          ? Math.max(1, Math.min(300, Number(body.duration_minutes)))
          : exam.duration_minutes;
      const status = body.status === 'draft' ? 'draft' : body.status === 'published' ? 'published' : exam.status;

      const nowIso = new Date().toISOString();
      db.prepare(`
        UPDATE exams SET title = ?, description = ?, duration_minutes = ?, status = ?, updated_at = ?
        WHERE id = ?
      `).run(title, description, durationMinutes, status, nowIso, examId);

      if (Array.isArray(body.questions) && body.questions.length > 0) {
        const attemptCount = db.prepare('SELECT COUNT(*) AS cnt FROM exam_attempts WHERE exam_id = ?').get(examId).cnt;
        if (attemptCount === 0) {
          db.prepare('DELETE FROM exam_questions WHERE exam_id = ?').run(examId);
          const insertQ = db.prepare(`
            INSERT INTO exam_questions (
              exam_id, part_type, question_text, option_a, option_b, option_c, option_d,
              correct_answer, essay_lang, points, sort_order
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `);
          body.questions.forEach((q, idx) => {
            const partType = q.part_type === 'essay' ? 'essay' : 'mcq';
            const pts = Math.max(0.1, Number(q.points || 1));
            insertQ.run(
              examId,
              partType,
              String(q.question_text || '').trim(),
              String(q.option_a || '').trim(),
              String(q.option_b || '').trim(),
              String(q.option_c || '').trim(),
              String(q.option_d || '').trim(),
              partType === 'mcq' ? String(q.correct_answer || 'A').trim().toUpperCase() : '',
              partType === 'essay' ? String(q.essay_lang || 'text').trim() : 'text',
              pts,
              idx + 1
            );
          });
        }
      }

      return sendJson(res, 200, { ok: true });
    }

    // DELETE /api/exams/:examId
    if (!subAction && method === 'DELETE') {
      if (currentUser.role === 'student') return sendJson(res, 403, { error: 'FORBIDDEN' });
      const files = db.prepare(`
        SELECT a.file_stored_name
        FROM exam_answers a
        JOIN exam_attempts att ON att.id = a.attempt_id
        WHERE att.exam_id = ? AND a.file_stored_name IS NOT NULL
      `).all(examId);

      for (const f of files) {
        try {
          fs.unlinkSync(path.join(EXAM_FILES_DIR, f.file_stored_name));
        } catch {}
      }

      db.prepare('DELETE FROM exams WHERE id = ?').run(examId);
      logAudit(db, {
        actorId: currentUser.id,
        actorUsername: currentUser.username,
        action: 'EXAM_DELETE',
        targetType: 'exam',
        targetId: examId,
        details: { title: exam.title },
        ipAddress: clientIp
      });
      return sendJson(res, 200, { ok: true });
    }

    // POST /api/exams/:examId/start (Timer starts only when student clicks Start)
    if (subAction === 'start' && method === 'POST') {
      if (currentUser.role !== 'student') {
        return sendJson(res, 403, {
          error: 'ONLY_STUDENT_CAN_START_EXAM',
          message_vi: 'Chỉ Học sinh mới có thể bắt đầu làm bài kiểm tra.',
          message_en: 'Only Students can start an exam attempt.'
        });
      }
      if (exam.class_status === 'archived') {
        return sendJson(res, 403, {
          error: 'CLASS_ARCHIVED',
          message_vi: 'Lớp học đã lưu trữ nên không thể làm bài kiểm tra.',
          message_en: 'Class is archived.'
        });
      }

      let attempt = db.prepare('SELECT * FROM exam_attempts WHERE exam_id = ? AND student_id = ?').get(examId, currentUser.id);
      if (!attempt) {
        const now = Date.now();
        const startedAt = new Date(now).toISOString();
        const expiresAt = new Date(now + exam.duration_minutes * 60 * 1000).toISOString();

        const resAtt = db.prepare(`
          INSERT INTO exam_attempts (exam_id, student_id, started_at, expires_at, status, mcq_score, violation_count)
          VALUES (?, ?, ?, ?, 'in_progress', 0, 0)
        `).run(examId, currentUser.id, startedAt, expiresAt);

        attempt = db.prepare('SELECT * FROM exam_attempts WHERE id = ?').get(Number(resAtt.lastInsertRowid));
      }

      return sendJson(res, 200, { ok: true, attempt });
    }

    // POST /api/exams/:examId/anti-cheat (Log right-click / tab switch / blur)
    if (subAction === 'anti-cheat' && method === 'POST') {
      if (currentUser.role !== 'student') return sendJson(res, 200, { ok: true });
      const attempt = db.prepare('SELECT * FROM exam_attempts WHERE exam_id = ? AND student_id = ?').get(examId, currentUser.id);
      if (!attempt || attempt.status !== 'in_progress') {
        return sendJson(res, 200, { ok: true });
      }

      const body = await readJsonBody(req);
      const eventType = String(body.event_type || 'unknown').slice(0, 50);
      const details = String(body.details || '').slice(0, 300);
      const nowIso = new Date().toISOString();

      db.prepare(`
        INSERT INTO exam_anticheat_logs (attempt_id, student_id, event_type, details, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(attempt.id, currentUser.id, eventType, details, nowIso);

      db.prepare(`
        UPDATE exam_attempts SET violation_count = violation_count + 1 WHERE id = ?
      `).run(attempt.id);

      const updated = db.prepare('SELECT violation_count FROM exam_attempts WHERE id = ?').get(attempt.id);
      return sendJson(res, 200, { ok: true, violation_count: updated.violation_count });
    }

    // POST /api/exams/:examId/submit (Auto-grade MCQ immediately + store Essay code/Word file)
    if (subAction === 'submit' && method === 'POST') {
      if (currentUser.role !== 'student') {
        return sendJson(res, 403, { error: 'FORBIDDEN' });
      }
      const attempt = db.prepare('SELECT * FROM exam_attempts WHERE exam_id = ? AND student_id = ?').get(examId, currentUser.id);
      if (!attempt) {
        return sendJson(res, 400, {
          error: 'ATTEMPT_NOT_STARTED',
          message_vi: 'Bạn chưa bắt đầu làm bài kiểm tra này.',
          message_en: 'You have not started this exam yet.'
        });
      }
      if (attempt.status !== 'in_progress') {
        return sendJson(res, 400, {
          error: 'ALREADY_SUBMITTED',
          message_vi: 'Bài kiểm tra đã được nộp trước đó.',
          message_en: 'Exam has already been submitted.'
        });
      }

      const body = await readJsonBody(req, 25 * 1024 * 1024);
      const submittedAnswers = Array.isArray(body.answers) ? body.answers : [];
      const ansByQId = new Map(submittedAnswers.map((a) => [Number(a.question_id), a]));

      const questions = db.prepare('SELECT * FROM exam_questions WHERE exam_id = ? ORDER BY sort_order ASC').all(examId);
      let mcqScore = 0;
      let essayCount = 0;

      const upsertAns = db.prepare(`
        INSERT INTO exam_answers (
          attempt_id, question_id, selected_option, essay_text, essay_lang,
          file_original_name, file_stored_name, file_mime_type, file_size_bytes,
          is_correct, awarded_points
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(attempt_id, question_id) DO UPDATE SET
          selected_option = excluded.selected_option,
          essay_text = excluded.essay_text,
          essay_lang = excluded.essay_lang,
          file_original_name = excluded.file_original_name,
          file_stored_name = excluded.file_stored_name,
          file_mime_type = excluded.file_mime_type,
          file_size_bytes = excluded.file_size_bytes,
          is_correct = excluded.is_correct,
          awarded_points = excluded.awarded_points
      `);

      for (const q of questions) {
        const subAns = ansByQId.get(q.id) || {};
        if (q.part_type === 'mcq') {
          const sel = String(subAns.selected_option || '').trim().toUpperCase();
          const isCorrect = sel && sel === String(q.correct_answer || '').trim().toUpperCase() ? 1 : 0;
          const pts = isCorrect ? Number(q.points) : 0;
          mcqScore += pts;
          upsertAns.run(attempt.id, q.id, sel, '', 'text', null, null, null, null, isCorrect, pts);
        } else {
          essayCount++;
          const essayText = String(subAns.essay_text || '');
          const essayLang = String(subAns.essay_lang || q.essay_lang || 'text');
          let fileOrig = null;
          let fileStored = null;
          let fileMime = null;
          let fileSize = null;

          if (subAns.fileName && subAns.dataBase64) {
            const ext = path.extname(String(subAns.fileName)).replace(/^\./, '').toLowerCase();
            if (!ALLOWED_ESSAY_FILE_EXTS.includes(ext)) {
              return sendJson(res, 400, {
                error: 'INVALID_ESSAY_FILE_EXT',
                message_vi: `Định dạng file "${ext}" không được hỗ trợ cho câu tự luận.`,
                message_en: `File extension "${ext}" is not supported for essay answers.`
              });
            }
            const rawB64 = String(subAns.dataBase64).replace(/^data:[^;]+;base64,/, '');
            const buf = Buffer.from(rawB64, 'base64');
            if (buf.length > 10 * 1024 * 1024) {
              return sendJson(res, 400, {
                error: 'ESSAY_FILE_TOO_LARGE',
                message_vi: 'File đính kèm phần tự luận không được vượt quá 10 MB.',
                message_en: 'Essay attachment cannot exceed 10 MB.'
              });
            }
            fileOrig = String(subAns.fileName);
            fileStored = `${crypto.randomUUID()}.${ext}`;
            fileMime = String(subAns.mimeType || 'application/octet-stream');
            fileSize = buf.length;
            fs.writeFileSync(path.join(EXAM_FILES_DIR, fileStored), buf);
          }

          upsertAns.run(
            attempt.id,
            q.id,
            '',
            essayText,
            essayLang,
            fileOrig,
            fileStored,
            fileMime,
            fileSize,
            null,
            null
          );
        }
      }

      mcqScore = Math.round(mcqScore * 100) / 100;
      const nowIso = new Date().toISOString();
      const newStatus = essayCount === 0 ? 'graded' : 'submitted';
      const totalScore = essayCount === 0 ? mcqScore : null;
      const essayScore = essayCount === 0 ? 0 : null;

      db.prepare(`
        UPDATE exam_attempts
        SET submitted_at = ?, status = ?, mcq_score = ?, essay_score = ?, total_score = ?
        WHERE id = ?
      `).run(nowIso, newStatus, mcqScore, essayScore, totalScore, attempt.id);

      notifyUser(db, {
        userId: exam.teacher_id,
        eventType: 'submission_new',
        titleVi: `Học sinh ${currentUser.full_name} đã nộp bài kiểm tra`,
        titleEn: `Student ${currentUser.full_name} submitted exam`,
        bodyVi: `${currentUser.full_name} đã hoàn thành "${exam.title}" (Điểm Trắc nghiệm: ${mcqScore}).`,
        bodyEn: `${currentUser.full_name} completed "${exam.title}" (MCQ Score: ${mcqScore}).`,
        linkUrl: `#/exams/${examId}/attempts`,
        sendEmail: false
      });

      const updatedAttempt = db.prepare('SELECT * FROM exam_attempts WHERE id = ?').get(attempt.id);
      return sendJson(res, 200, {
        ok: true,
        attempt: updatedAttempt
      });
    }

    // GET /api/exams/:examId/attempts (Teacher/Admin views all student attempts & anti-cheat counts)
    if (subAction === 'attempts' && method === 'GET') {
      if (currentUser.role === 'student') return sendJson(res, 403, { error: 'FORBIDDEN' });

      const rows = db.prepare(`
        SELECT
          u.id AS student_id, u.username, u.full_name, u.email,
          att.id AS attempt_id, att.started_at, att.expires_at, att.submitted_at,
          att.status, att.mcq_score, att.essay_score, att.total_score,
          att.violation_count, att.teacher_feedback
        FROM class_members cm
        JOIN users u ON u.id = cm.student_id
        LEFT JOIN exam_attempts att ON att.exam_id = ? AND att.student_id = u.id
        WHERE cm.class_id = ?
        ORDER BY u.full_name ASC
      `).all(examId, exam.class_id);

      return sendJson(res, 200, {
        exam,
        items: rows
      });
    }
  }

  // 5. Attempt Detail & Teacher Manual Grading for Essay Part: /api/exam-attempts/:attemptId(/grade)
  const attemptMatch = pathname.match(/^\/api\/exam-attempts\/(\d+)(?:\/(grade))?$/);
  if (attemptMatch) {
    const attemptId = Number(attemptMatch[1]);
    const isGrade = attemptMatch[2] === 'grade';

    const attempt = db.prepare(`
      SELECT att.*, u.username AS student_username, u.full_name AS student_name, u.email AS student_email,
             e.class_id, e.title AS exam_title, e.duration_minutes
      FROM exam_attempts att
      JOIN users u ON u.id = att.student_id
      JOIN exams e ON e.id = att.exam_id
      WHERE att.id = ?
    `).get(attemptId);

    if (!attempt) {
      return sendJson(res, 404, { error: 'ATTEMPT_NOT_FOUND' });
    }

    const perm = checkClassPermission(db, currentUser, attempt.class_id);
    if (!perm.allowed) return sendJson(res, perm.status, { error: perm.code });

    if (currentUser.role === 'student' && attempt.student_id !== currentUser.id) {
      return sendJson(res, 403, { error: 'FORBIDDEN_OTHER_STUDENT_ATTEMPT' });
    }

    if (!isGrade && method === 'GET') {
      const questions = db.prepare(`
        SELECT q.*,
               ans.id AS answer_id, ans.selected_option, ans.essay_text, ans.essay_lang AS student_essay_lang,
               ans.file_original_name, ans.file_size_bytes,
               ans.is_correct, ans.awarded_points, ans.teacher_comment
        FROM exam_questions q
        LEFT JOIN exam_answers ans ON ans.question_id = q.id AND ans.attempt_id = ?
        WHERE q.exam_id = ?
        ORDER BY q.sort_order ASC, q.id ASC
      `).all(attemptId, attempt.exam_id);

      const logs = db.prepare(`
        SELECT * FROM exam_anticheat_logs
        WHERE attempt_id = ?
        ORDER BY id ASC
      `).all(attemptId);

      return sendJson(res, 200, {
        attempt,
        questions,
        antiCheatLogs: logs
      });
    }

    if (isGrade && method === 'PUT') {
      if (currentUser.role === 'student') return sendJson(res, 403, { error: 'FORBIDDEN' });

      const body = await readJsonBody(req);
      const grades = Array.isArray(body.grades) ? body.grades : [];
      const teacherFeedback = String(body.teacher_feedback || '').trim();

      const updateAns = db.prepare(`
        INSERT INTO exam_answers (attempt_id, question_id, awarded_points, teacher_comment)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(attempt_id, question_id) DO UPDATE SET
          awarded_points = excluded.awarded_points,
          teacher_comment = excluded.teacher_comment
      `);

      for (const g of grades) {
        const qId = Number(g.question_id);
        const q = db.prepare('SELECT * FROM exam_questions WHERE id = ? AND exam_id = ?').get(qId, attempt.exam_id);
        if (!q || q.part_type !== 'essay') continue;

        const pts = Math.max(0, Math.min(Number(q.points), Number(g.awarded_points || 0)));
        const comment = String(g.teacher_comment || '').trim();
        updateAns.run(attemptId, qId, Math.round(pts * 100) / 100, comment);
      }

      const essaySumRow = db.prepare(`
        SELECT COALESCE(SUM(ans.awarded_points), 0) AS essay_sum
        FROM exam_answers ans
        JOIN exam_questions q ON q.id = ans.question_id
        WHERE ans.attempt_id = ? AND q.part_type = 'essay'
      `).get(attemptId);

      const essayScore = Math.round(Number(essaySumRow.essay_sum || 0) * 100) / 100;
      const totalScore = Math.round((Number(attempt.mcq_score || 0) + essayScore) * 100) / 100;

      db.prepare(`
        UPDATE exam_attempts
        SET essay_score = ?, total_score = ?, teacher_feedback = ?, status = 'graded'
        WHERE id = ?
      `).run(essayScore, totalScore, teacherFeedback, attemptId);

      notifyUser(db, {
        userId: attempt.student_id,
        eventType: 'graded',
        titleVi: `Đã có điểm tổng kết bài kiểm tra: ${attempt.exam_title}`,
        titleEn: `Exam graded: ${attempt.exam_title}`,
        bodyVi: `Bài kiểm tra "${attempt.exam_title}" đã được chấm xong. Điểm Trắc nghiệm: ${attempt.mcq_score}, Điểm Tự luận: ${essayScore}, Tổng điểm: ${totalScore}.`,
        bodyEn: `Your exam "${attempt.exam_title}" has been graded. MCQ: ${attempt.mcq_score}, Essay: ${essayScore}, Total: ${totalScore}.`,
        linkUrl: `#/exams/${attempt.exam_id}`,
        sendEmail: true
      });

      return sendJson(res, 200, {
        ok: true,
        mcq_score: attempt.mcq_score,
        essay_score: essayScore,
        total_score: totalScore
      });
    }
  }

  // 6. Download Essay Attachment: /api/exam-answers/:answerId/download
  const ansDlMatch = pathname.match(/^\/api\/exam-answers\/(\d+)\/download$/);
  if (ansDlMatch && method === 'GET') {
    const answerId = Number(ansDlMatch[1]);
    const ans = db.prepare(`
      SELECT ans.*, att.student_id, e.class_id
      FROM exam_answers ans
      JOIN exam_attempts att ON att.id = ans.attempt_id
      JOIN exams e ON e.id = att.exam_id
      WHERE ans.id = ?
    `).get(answerId);

    if (!ans || !ans.file_stored_name) {
      return sendJson(res, 404, { error: 'FILE_NOT_FOUND' });
    }

    const perm = checkClassPermission(db, currentUser, ans.class_id);
    if (!perm.allowed) return sendJson(res, perm.status, { error: perm.code });
    if (currentUser.role === 'student' && ans.student_id !== currentUser.id) {
      return sendJson(res, 403, { error: 'FORBIDDEN' });
    }

    const filePath = path.join(EXAM_FILES_DIR, ans.file_stored_name);
    if (!fs.existsSync(filePath)) {
      return sendJson(res, 404, { error: 'FILE_MISSING_ON_DISK' });
    }

    const encoded = encodeURIComponent(ans.file_original_name || 'essay_submission');
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${String(ans.file_original_name || 'file').replace(/["\\]/g, '_')}"; filename*=UTF-8''${encoded}`,
      'X-Content-Type-Options': 'nosniff'
    });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  return sendJson(res, 404, { error: 'EXAM_API_NOT_FOUND' });
}
