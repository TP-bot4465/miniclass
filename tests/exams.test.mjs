import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Readable, Writable } from 'node:stream';

const tmpTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'miniclass-exam-test-'));
process.env.DATA_DIR = tmpTestDir;
process.env.DB_PATH = path.join(tmpTestDir, 'exam-test.sqlite');
process.env.UPLOAD_DIR = path.join(tmpTestDir, 'uploads');
process.env.BACKUP_DIR = path.join(tmpTestDir, 'backups');

const { createAppServer } = await import('../src/server.mjs');
const server = createAppServer();

async function req(pathname, { method = 'GET', token = null, body = null } = {}) {
  return new Promise((resolve) => {
    const headers = { host: 'localhost:3000' };
    if (token) headers['authorization'] = `Bearer ${token}`;

    let bodyBuf = Buffer.alloc(0);
    if (body !== null) {
      headers['content-type'] = 'application/json';
      bodyBuf = Buffer.from(JSON.stringify(body), 'utf8');
      headers['content-length'] = String(bodyBuf.length);
    }

    const reqStream = new Readable({
      read() {
        if (bodyBuf.length > 0) this.push(bodyBuf);
        this.push(null);
      }
    });
    reqStream.url = pathname;
    reqStream.method = method;
    reqStream.headers = headers;
    reqStream.socket = { remoteAddress: '127.0.0.1' };

    const resChunks = [];
    let statusCode = 200;
    const resHeaders = new Map();

    const resStream = new Writable({
      write(chunk, _enc, cb) {
        resChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        cb();
      }
    });

    resStream.headersSent = false;
    resStream.writeHead = (status, hdrs = {}) => {
      statusCode = status;
      resStream.headersSent = true;
      for (const [k, v] of Object.entries(hdrs)) {
        resHeaders.set(k.toLowerCase(), v);
      }
    };
    resStream.end = (chunk) => {
      if (chunk) resChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      resStream.emit('finish');
      const fullBuf = Buffer.concat(resChunks);
      const ct = String(resHeaders.get('content-type') || '');
      let data = fullBuf.toString('utf8');
      if (ct.includes('application/json') && data) {
        try {
          data = JSON.parse(data);
        } catch {}
      }
      resolve({
        status: statusCode,
        headers: { get: (k) => resHeaders.get(String(k).toLowerCase()) || null },
        data
      });
    };

    server.emit('request', reqStream, resStream);
  });
}

console.log('Running MiniClass Exam & Anti-Cheat Test Suite...\n');

try {
  // Login as Teacher gv_minh and Student hs_an
  const gvLogin = await req('/api/auth/login', {
    method: 'POST',
    body: { username: 'gv_minh', password: 'Teacher123' }
  });
  assert.equal(gvLogin.status, 200);
  const gvToken = gvLogin.data.token;

  const hsLogin = await req('/api/auth/login', {
    method: 'POST',
    body: { username: 'hs_an', password: 'Student123' }
  });
  assert.equal(hsLogin.status, 200);
  const hsToken = hsLogin.data.token;

  // 1. Download Sample CSV & Parse CSV
  {
    const sampleRes = await req('/api/exams/sample-csv', { token: gvToken });
    assert.equal(sampleRes.status, 200);
    assert.ok(sampleRes.data.includes('question,option_a,option_b,option_c,option_d,correct_answer,points'));

    const parsedRes = await req('/api/exams/parse-csv', {
      method: 'POST',
      token: gvToken,
      body: { csvText: sampleRes.data }
    });
    assert.equal(parsedRes.status, 200);
    assert.equal(parsedRes.data.questions.length, 3);
    console.log('✅ EX-01 PASSED: Tải mẫu CSV & parse câu hỏi trắc nghiệm từ CSV hoạt động chính xác.');
  }

  // 2. Teacher creates an exam with MCQ + Essay (Python & C Arduino)
  let examId, qMcq1Id, qMcq2Id, qEssay1Id, qEssay2Id;
  {
    const classesRes = await req('/api/classes', { token: gvToken });
    const classId = classesRes.data.classes[0].id;

    const createRes = await req('/api/exams', {
      method: 'POST',
      token: gvToken,
      body: {
        class_id: classId,
        title: 'Kiểm tra Lập trình Nhúng & Python',
        description: 'Đề thi 2 phần có chống gian lận',
        duration_minutes: 30,
        status: 'published',
        questions: [
          {
            part_type: 'mcq',
            question_text: 'Hàm nào trong Arduino chạy 1 lần khi khởi động?',
            option_a: 'setup()',
            option_b: 'loop()',
            option_c: 'init()',
            option_d: 'begin()',
            correct_answer: 'A',
            points: 2
          },
          {
            part_type: 'mcq',
            question_text: 'Từ khóa khai báo hàm trong Lua là gì?',
            option_a: 'def',
            option_b: 'function',
            option_c: 'fn',
            option_d: 'sub',
            correct_answer: 'B',
            points: 2
          },
          {
            part_type: 'essay',
            question_text: 'Viết code C Arduino nhấp nháy đèn LED ở chân 13.',
            essay_lang: 'c_arduino',
            points: 3
          },
          {
            part_type: 'essay',
            question_text: 'Trình bày nguyên lý hoạt động và đính kèm file Word (.docx).',
            essay_lang: 'word',
            points: 3
          }
        ]
      }
    });
    assert.equal(createRes.status, 201);
    examId = createRes.data.examId;
    console.log('✅ EX-02 PASSED: Giáo viên tạo bài kiểm tra gồm Trắc nghiệm + Tự luận (Code Arduino/Lua/Python/Word).');
  }

  // 3. Student views exam before starting -> questions hidden, timer not started
  {
    const preView = await req(`/api/exams/${examId}`, { token: hsToken });
    assert.equal(preView.status, 200);
    assert.equal(preView.data.myAttempt, null);
    assert.equal(preView.data.questions.length, 0, 'Questions must not be exposed before starting');
    console.log('✅ EX-03 PASSED: Trước khi bấm Bắt đầu, thời gian chưa chạy và nội dung câu hỏi được bảo mật.');
  }

  // 4. Student clicks Start -> timer starts & questions returned (without correct_answer)
  {
    const startRes = await req(`/api/exams/${examId}/start`, { method: 'POST', token: hsToken });
    assert.equal(startRes.status, 200);
    assert.equal(startRes.data.attempt.status, 'in_progress');
    assert.ok(startRes.data.attempt.started_at);
    assert.ok(startRes.data.attempt.expires_at);

    const activeView = await req(`/api/exams/${examId}`, { token: hsToken });
    assert.equal(activeView.data.questions.length, 4);
    assert.equal(activeView.data.questions[0].correct_answer, undefined, 'correct_answer must be hidden during exam');
    qMcq1Id = activeView.data.questions[0].id;
    qMcq2Id = activeView.data.questions[1].id;
    qEssay1Id = activeView.data.questions[2].id;
    qEssay2Id = activeView.data.questions[3].id;
    console.log('✅ EX-04 PASSED: Bắt đầu làm bài kích hoạt bộ đếm thời gian và trả đề thi bảo mật đáp án.');
  }

  // 5. Anti-cheat logging (right-click & tab hidden)
  {
    const ac1 = await req(`/api/exams/${examId}/anti-cheat`, {
      method: 'POST',
      token: hsToken,
      body: { event_type: 'right_click', details: 'Bấm chuột phải trong phòng thi' }
    });
    assert.equal(ac1.status, 200);
    assert.equal(ac1.data.violation_count, 1);

    const ac2 = await req(`/api/exams/${examId}/anti-cheat`, {
      method: 'POST',
      token: hsToken,
      body: { event_type: 'tab_hidden', details: 'Thoát tab trình duyệt' }
    });
    assert.equal(ac2.status, 200);
    assert.equal(ac2.data.violation_count, 2);
    console.log('✅ EX-05 PASSED: Ghi log chống gian lận khi học sinh bấm chuột phải hoặc thoát tab.');
  }

  // 6. Student submits exam -> Immediate MCQ score calculated, Essay saved
  let attemptId;
  {
    const subRes = await req(`/api/exams/${examId}/submit`, {
      method: 'POST',
      token: hsToken,
      body: {
        answers: [
          { question_id: qMcq1Id, selected_option: 'A' }, // Correct (+2)
          { question_id: qMcq2Id, selected_option: 'A' }, // Wrong (0)
          {
            question_id: qEssay1Id,
            essay_lang: 'c_arduino',
            essay_text: 'void setup() { pinMode(13, OUTPUT); }\nvoid loop() { digitalWrite(13, HIGH); delay(500); }'
          },
          {
            question_id: qEssay2Id,
            essay_lang: 'word',
            essay_text: 'Em đính kèm file Word báo cáo.',
            fileName: 'baocao_arduino.docx',
            mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            dataBase64: Buffer.from('PK fake docx content').toString('base64')
          }
        ]
      }
    });
    assert.equal(subRes.status, 200);
    assert.equal(subRes.data.attempt.mcq_score, 2, 'MCQ score calculated immediately (2/4)');
    assert.equal(subRes.data.attempt.status, 'submitted');
    attemptId = subRes.data.attempt.id;
    console.log('✅ EX-06 PASSED: Nộp bài có ngay điểm Trắc nghiệm (2.0đ) và lưu bài làm Code Arduino + file Word.');
  }

  // 7. Teacher inspects anti-cheat logs & grades Essay part -> Total score computed
  {
    const attDetail = await req(`/api/exam-attempts/${attemptId}`, { token: gvToken });
    assert.equal(attDetail.status, 200);
    assert.equal(attDetail.data.antiCheatLogs.length, 2);

    const gradeRes = await req(`/api/exam-attempts/${attemptId}/grade`, {
      method: 'PUT',
      token: gvToken,
      body: {
        grades: [
          { question_id: qEssay1Id, awarded_points: 3, teacher_comment: 'Code Arduino chuẩn!' },
          { question_id: qEssay2Id, awarded_points: 2.5, teacher_comment: 'Trình bày rõ ràng.' }
        ],
        teacher_feedback: 'Hoàn thành tốt cả lý thuyết và thực hành.'
      }
    });
    assert.equal(gradeRes.status, 200);
    assert.equal(gradeRes.data.mcq_score, 2);
    assert.equal(gradeRes.data.essay_score, 5.5);
    assert.equal(gradeRes.data.total_score, 7.5);
    console.log('✅ EX-07 PASSED: Giáo viên xem log chống gian lận và chấm điểm tay Tự luận -> Tổng điểm 7.5/10.');
  }

  console.log('\n🎉 ALL EXAM & ANTI-CHEAT TESTS PASSED SUCCESSFULLY!');
} finally {
  try {
    fs.rmSync(tmpTestDir, { recursive: true, force: true });
  } catch {}
}
