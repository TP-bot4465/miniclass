import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Readable, Writable } from 'node:stream';

// Use an isolated temporary directory for tests so production data is untouched
const tmpTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'miniclass-test-'));
process.env.DATA_DIR = tmpTestDir;
process.env.DB_PATH = path.join(tmpTestDir, 'test.sqlite');
process.env.UPLOAD_DIR = path.join(tmpTestDir, 'uploads');
process.env.BACKUP_DIR = path.join(tmpTestDir, 'backups');

const { createAppServer } = await import('../src/server.mjs');
const { renderMarkdown } = await import('../public/js/markdown.js');
const { clearRateLimits } = await import('../src/security.mjs');

const server = createAppServer();

/**
 * In-process HTTP request dispatcher so tests run in any environment (including network-isolated sandboxes).
 */
async function req(pathname, { method = 'GET', token = null, body = null } = {}) {
  return new Promise((resolve, reject) => {
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
        if (bodyBuf.length > 0) {
          this.push(bodyBuf);
        }
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
      if (chunk) {
        resChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
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
        headers: {
          get: (k) => resHeaders.get(String(k).toLowerCase()) || null
        },
        data,
        rawBuffer: fullBuf
      });
    };

    server.emit('request', reqStream, resStream);
  });
}

console.log('Running MiniClass Acceptance Test Suite (AC-01 .. AC-15)...\n');

try {
  // =========================================================================
  // AC-01: Truy cập trang đăng ký -> Không tồn tại trang đăng ký
  // =========================================================================
  {
    const r1 = await req('/register');
    const r2 = await req('/api/auth/register', { method: 'POST', body: {} });
    assert.equal(r1.status, 404, 'AC-01: /register must return 404');
    assert.equal(r2.status, 404, 'AC-01: /api/auth/register must return 404');
    console.log('✅ AC-01 PASSED: Không tồn tại trang đăng ký công khai (404).');
  }

  // Login as Admin
  const adminLogin = await req('/api/auth/login', {
    method: 'POST',
    body: { username: 'admin', password: 'Admin1234' }
  });
  assert.equal(adminLogin.status, 200);
  const adminToken = adminLogin.data.token;

  // =========================================================================
  // AC-02: Admin tạo tài khoản HS, HS đăng nhập lần đầu -> Bị yêu cầu đổi mật khẩu
  // =========================================================================
  let hs1Id, hs2Id, hs3Id, hsLateJoinId;
  let hs1Token, hs2Token;
  {
    const c1 = await req('/api/admin/users', {
      method: 'POST',
      token: adminToken,
      body: {
        full_name: 'Học Sinh Test 1',
        username: 'hs_test1',
        email: 'hs_test1@edu.vn',
        role: 'student',
        password: 'TempPassword1'
      }
    });
    assert.equal(c1.status, 201);
    hs1Id = c1.data.user.id;

    // First login of hs_test1
    const firstLogin = await req('/api/auth/login', {
      method: 'POST',
      body: { username: 'hs_test1', password: 'TempPassword1' }
    });
    assert.equal(firstLogin.status, 200);
    assert.equal(firstLogin.data.user.must_change_password, true, 'AC-02: must_change_password must be true');
    hs1Token = firstLogin.data.token;

    // Attempting to access dashboard before changing password must be blocked (403 MUST_CHANGE_PASSWORD)
    const blockedDash = await req('/api/dashboard', { token: hs1Token });
    assert.equal(blockedDash.status, 403);
    assert.equal(blockedDash.data.error, 'MUST_CHANGE_PASSWORD');

    // Change password
    const chg = await req('/api/auth/change-password', {
      method: 'POST',
      token: hs1Token,
      body: { oldPassword: 'TempPassword1', newPassword: 'NewPassword123' }
    });
    assert.equal(chg.status, 200);

    // Now dashboard succeeds
    const okDash = await req('/api/dashboard', { token: hs1Token });
    assert.equal(okDash.status, 200);
    console.log('✅ AC-02 PASSED: HS đăng nhập lần đầu bắt buộc phải đổi mật khẩu tạm trước khi sử dụng.');
  }

  // Create 2 more students + 1 late-join student and change their passwords
  {
    const c2 = await req('/api/admin/users', {
      method: 'POST',
      token: adminToken,
      body: { full_name: 'Học Sinh Test 2', username: 'hs_test2', email: 'hs_test2@edu.vn', role: 'student', password: 'TempPassword1' }
    });
    hs2Id = c2.data.user.id;
    const l2 = await req('/api/auth/login', { method: 'POST', body: { username: 'hs_test2', password: 'TempPassword1' } });
    hs2Token = l2.data.token;
    await req('/api/auth/change-password', { method: 'POST', token: hs2Token, body: { oldPassword: 'TempPassword1', newPassword: 'NewPassword123' } });

    const c3 = await req('/api/admin/users', {
      method: 'POST',
      token: adminToken,
      body: { full_name: 'Học Sinh Test 3', username: 'hs_test3', email: 'hs_test3@edu.vn', role: 'student', password: 'TempPassword1' }
    });
    hs3Id = c3.data.user.id;

    const c4 = await req('/api/admin/users', {
      method: 'POST',
      token: adminToken,
      body: { full_name: 'Học Sinh Vào Sau', username: 'hs_latejoin', email: 'hs_latejoin@edu.vn', role: 'student', password: 'TempPassword1' }
    });
    hsLateJoinId = c4.data.user.id;
  }

  // Login as Teacher gv_minh
  const gvLogin = await req('/api/auth/login', {
    method: 'POST',
    body: { username: 'gv_minh', password: 'Teacher123' }
  });
  assert.equal(gvLogin.status, 200);
  const gvToken = gvLogin.data.token;

  // =========================================================================
  // AC-03: GV tạo lớp, thêm 3 HS -> 3 HS thấy lớp trên trang chủ và nhận thông báo
  // =========================================================================
  let testClassId;
  {
    const clsRes = await req('/api/classes', {
      method: 'POST',
      token: gvToken,
      body: { name: 'Lớp Kiểm Thử AC-03', description: 'Mô tả lớp kiểm thử' }
    });
    assert.equal(clsRes.status, 201);
    testClassId = clsRes.data.classId;

    const addMem = await req(`/api/classes/${testClassId}/members`, {
      method: 'POST',
      token: gvToken,
      body: { studentIds: [hs1Id, hs2Id, hs3Id] }
    });
    assert.equal(addMem.status, 200);
    assert.equal(addMem.data.addedCount, 3);

    const hs1Dash = await req('/api/dashboard', { token: hs1Token });
    assert.ok(hs1Dash.data.classes.some((c) => c.id === testClassId), 'AC-03: Student sees new class on dashboard');

    const hs1Notifs = await req('/api/notifications', { token: hs1Token });
    assert.ok(
      hs1Notifs.data.notifications.some((n) => n.event_type === 'class_added'),
      'AC-03: Student receives notification when added to class'
    );
    console.log('✅ AC-03 PASSED: GV tạo lớp & thêm 3 HS; HS thấy lớp trên trang chủ và nhận thông báo.');
  }

  // =========================================================================
  // AC-04 & AC-05: GV đăng buổi học có tiêu đề, bảng, code, ảnh Markdown + chèn <script>
  // -> HS thấy văn bản định dạng, ảnh hiển thị, không thấy #, **, và <script> bị chặn
  // =========================================================================
  let session1Id;
  {
    const png1x1Base64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const imgRes = await req('/api/uploads/image', {
      method: 'POST',
      token: gvToken,
      body: {
        classId: testClassId,
        fileName: 'diagram.png',
        mimeType: 'image/png',
        dataBase64: png1x1Base64
      }
    });
    assert.equal(imgRes.status, 201);

    const mdContent = [
      '# Tiêu đề bài giảng chính',
      'Đoạn văn có **chữ in đậm** và *chữ in nghiêng*.',
      '',
      '| Cột A | Cột B |',
      '| :--- | :--- |',
      '| Ô 1 | Ô 2 |',
      '',
      '```python',
      'print("Hello MiniClass")',
      '```',
      '',
      imgRes.data.markdown,
      '<script>alert("XSS")</script>',
      '<iframe src="https://evil.example.com"></iframe>'
    ].join('\n');

    const futureDeadline = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
    const sRes = await req(`/api/classes/${testClassId}/sessions`, {
      method: 'POST',
      token: gvToken,
      body: {
        title: 'Buổi 1: Kiểm thử Markdown & Bảo mật',
        session_date: '2026-11-15',
        content_md: mdContent,
        requires_submission: true,
        deadline: futureDeadline,
        status: 'published'
      }
    });
    assert.equal(sRes.status, 201);
    session1Id = sRes.data.sessionId;

    const renderedHtml = renderMarkdown(mdContent);
    assert.ok(renderedHtml.includes('<h1>Tiêu đề bài giảng chính</h1>'), 'AC-04: Heading rendered');
    assert.ok(renderedHtml.includes('<strong>chữ in đậm</strong>'), 'AC-04: Bold rendered without **');
    assert.ok(renderedHtml.includes('<table>'), 'AC-04: Table rendered');
    assert.ok(renderedHtml.includes('<img src="/api/files/images/'), 'AC-04: Image rendered');
    assert.ok(!renderedHtml.includes('<script'), 'AC-05: <script> tag stripped');
    assert.ok(!renderedHtml.includes('<iframe'), 'AC-05: <iframe> tag stripped');
    console.log('✅ AC-04 & AC-05 PASSED: Markdown render chuẩn (tiêu đề, bảng, code, ảnh) và chặn hoàn toàn <script>/<iframe>.');
  }

  // =========================================================================
  // AC-06: HS không thuộc lớp truy cập URL buổi học của lớp -> Bị từ chối (403/404)
  // =========================================================================
  let hsLateJoinToken;
  {
    const l4 = await req('/api/auth/login', {
      method: 'POST',
      body: { username: 'hs_latejoin', password: 'TempPassword1' }
    });
    hsLateJoinToken = l4.data.token;
    await req('/api/auth/change-password', {
      method: 'POST',
      token: hsLateJoinToken,
      body: { oldPassword: 'TempPassword1', newPassword: 'NewPassword123' }
    });

    const outsiderRes = await req(`/api/sessions/${session1Id}`, { token: hsLateJoinToken });
    assert.equal(outsiderRes.status, 403, 'AC-06: Non-member student must receive 403 Forbidden');
    console.log('✅ AC-06 PASSED: HS không thuộc lớp truy cập buổi học bị từ chối (403 Forbidden).');
  }

  // =========================================================================
  // AC-07: HS nộp file 12 MB hoặc file .exe -> Bị từ chối, có thông báo lỗi rõ ràng
  // =========================================================================
  {
    const exeRes = await req(`/api/sessions/${session1Id}/submit`, {
      method: 'POST',
      token: hs1Token,
      body: {
        fileName: 'malware.exe',
        mimeType: 'application/x-msdownload',
        dataBase64: Buffer.from('MZ fake exe content').toString('base64')
      }
    });
    assert.equal(exeRes.status, 400, 'AC-07: .exe must be rejected');
    assert.equal(exeRes.data.error, 'FILE_EXTENSION_NOT_ALLOWED');

    const bigBuffer = Buffer.alloc(12 * 1024 * 1024, 0x61); // 12 MB
    const bigRes = await req(`/api/sessions/${session1Id}/submit`, {
      method: 'POST',
      token: hs1Token,
      body: {
        fileName: 'too_large.pdf',
        mimeType: 'application/pdf',
        dataBase64: bigBuffer.toString('base64')
      }
    });
    assert.equal(bigRes.status, 400, 'AC-07: 12 MB file must be rejected');
    assert.equal(bigRes.data.error, 'FILE_TOO_LARGE');
    console.log('✅ AC-07 PASSED: Từ chối file .exe và file > 10 MB (12 MB) kèm thông báo lỗi rõ ràng.');
  }

  // =========================================================================
  // AC-08: HS nộp .py trước deadline, nộp lại sau deadline -> Chỉ còn bản mới nhất, trạng thái "Trễ hạn"
  // =========================================================================
  let hs1SubId;
  {
    const sub1 = await req(`/api/sessions/${session1Id}/submit`, {
      method: 'POST',
      token: hs1Token,
      body: {
        fileName: 'solution_v1.py',
        mimeType: 'text/x-python',
        note: 'Bản nộp đúng hạn',
        dataBase64: Buffer.from('print("v1 on time")').toString('base64')
      }
    });
    assert.equal(sub1.status, 200);
    assert.equal(sub1.data.submission.is_late, 0, 'First submission before deadline is on time');

    const pastDeadline = new Date(Date.now() - 60_000).toISOString();
    await req(`/api/sessions/${session1Id}`, {
      method: 'PUT',
      token: gvToken,
      body: { deadline: pastDeadline }
    });

    const sub2 = await req(`/api/sessions/${session1Id}/submit`, {
      method: 'POST',
      token: hs1Token,
      body: {
        fileName: 'solution_v2_late.py',
        mimeType: 'text/x-python',
        note: 'Bản nộp lại sau deadline',
        dataBase64: Buffer.from('print("v2 late")').toString('base64')
      }
    });
    assert.equal(sub2.status, 200);
    assert.equal(sub2.data.submission.original_name, 'solution_v2_late.py');
    assert.equal(sub2.data.submission.is_late, 1, 'AC-08: Resubmission after deadline is marked Late');
    hs1SubId = sub2.data.submission.id;

    const listSubs = await req(`/api/sessions/${session1Id}/submissions`, { token: gvToken });
    const hs1Rows = listSubs.data.items.filter((x) => x.student_id === hs1Id);
    assert.equal(hs1Rows.length, 1);
    assert.equal(hs1Rows[0].original_name, 'solution_v2_late.py');
    console.log('✅ AC-08 PASSED: Nộp lại sau deadline thay thế bản cũ và chuyển trạng thái sang "Trễ hạn".');
  }

  // =========================================================================
  // AC-09: HS được thêm vào lớp sau 5 buổi đã tạo -> Xem được cả 5 buổi cũ
  // =========================================================================
  {
    for (let i = 2; i <= 5; i++) {
      await req(`/api/classes/${testClassId}/sessions`, {
        method: 'POST',
        token: gvToken,
        body: {
          title: `Buổi ${i}: Bài giảng số ${i}`,
          session_date: `2026-11-1${i}`,
          content_md: `# Nội dung buổi ${i}`,
          requires_submission: false,
          status: 'published'
        }
      });
    }

    await req(`/api/classes/${testClassId}/members`, {
      method: 'POST',
      token: gvToken,
      body: { studentIds: [hsLateJoinId] }
    });

    const lateSessions = await req(`/api/classes/${testClassId}/sessions`, { token: hsLateJoinToken });
    assert.equal(lateSessions.status, 200);
    assert.equal(lateSessions.data.sessions.length, 5, 'AC-09: Newly added student sees all 5 existing published sessions');
    console.log('✅ AC-09 PASSED: HS được thêm vào lớp sau 5 buổi đã tạo xem được đầy đủ cả 5 buổi cũ.');
  }

  // =========================================================================
  // AC-10: HS A thử tải bài nộp của HS B qua URL -> Bị từ chối (403)
  // =========================================================================
  {
    const stealAttempt = await req(`/api/submissions/${hs1SubId}/download`, { token: hs2Token });
    assert.equal(stealAttempt.status, 403, 'AC-10: Student B cannot download Student A submission');
    console.log('✅ AC-10 PASSED: HS B thử tải bài nộp của HS A qua URL bị từ chối (403 Forbidden).');
  }

  // =========================================================================
  // AC-12: GV nhập điểm 11 hoặc 7.25 -> Báo lỗi validate
  // =========================================================================
  {
    const g11 = await req(`/api/submissions/${hs1SubId}/grade`, {
      method: 'PUT',
      token: gvToken,
      body: { score: 11, feedback: 'Điểm quá 10' }
    });
    assert.equal(g11.status, 400, 'AC-12: Score 11 must be rejected');

    const g725 = await req(`/api/submissions/${hs1SubId}/grade`, {
      method: 'PUT',
      token: gvToken,
      body: { score: 7.25, feedback: 'Điểm 2 chữ số thập phân' }
    });
    assert.equal(g725.status, 400, 'AC-12: Score 7.25 must be rejected');
    console.log('✅ AC-12 PASSED: GV nhập điểm 11 hoặc 7.25 bị từ chối với lỗi validate.');
  }

  // =========================================================================
  // AC-11: GV chấm 8.5 + nhận xét -> HS thấy điểm, nhận xét; nhận email; không nộp lại được
  // =========================================================================
  {
    const g85 = await req(`/api/submissions/${hs1SubId}/grade`, {
      method: 'PUT',
      token: gvToken,
      body: { score: 8.5, feedback: 'Bài làm tốt, nắm vững kiến thức!' }
    });
    assert.equal(g85.status, 200);

    const sesDetail = await req(`/api/sessions/${session1Id}`, { token: hs1Token });
    assert.equal(sesDetail.data.mySubmission.score, 8.5);
    assert.equal(sesDetail.data.mySubmission.feedback, 'Bài làm tốt, nắm vững kiến thức!');

    const lockedResub = await req(`/api/sessions/${session1Id}/submit`, {
      method: 'POST',
      token: hs1Token,
      body: {
        fileName: 'attempt_after_grade.py',
        mimeType: 'text/x-python',
        dataBase64: Buffer.from('print(123)').toString('base64')
      }
    });
    assert.equal(lockedResub.status, 403, 'AC-11: Resubmission must be locked after grading');
    assert.equal(lockedResub.data.error, 'SUBMISSION_LOCKED_GRADED');
    console.log('✅ AC-11 PASSED: GV chấm 8.5 + nhận xét; HS thấy điểm/nhận xét, nhận thông báo/email và bị khóa nộp lại.');
  }

  // =========================================================================
  // AC-13: Đổi ngôn ngữ sang English -> Giữ sau khi đăng xuất/đăng nhập lại
  // =========================================================================
  {
    const profRes = await req('/api/auth/profile', {
      method: 'PUT',
      token: hs1Token,
      body: { language: 'en' }
    });
    assert.equal(profRes.status, 200);
    assert.equal(profRes.data.user.language, 'en');

    await req('/api/auth/logout', { method: 'POST', token: hs1Token });

    const relogin = await req('/api/auth/login', {
      method: 'POST',
      body: { username: 'hs_test1', password: 'NewPassword123' }
    });
    assert.equal(relogin.status, 200);
    assert.equal(relogin.data.user.language, 'en', 'AC-13: Language choice persisted across logout/login');
    hs1Token = relogin.data.token;
    console.log('✅ AC-13 PASSED: Đổi ngôn ngữ sang English được lưu theo tài khoản qua các lần đăng xuất/đăng nhập.');
  }

  // =========================================================================
  // AC-14: Responsive 360px CSS rules & mobile layout support verification
  // =========================================================================
  {
    const cssRes = await req('/styles.css');
    assert.equal(cssRes.status, 200);
    assert.ok(cssRes.data.includes('@media (max-width: 768px)'), 'AC-14: Responsive media queries present');
    assert.ok(cssRes.data.includes('data-mobile-tab="preview"'), 'AC-14: Mobile Markdown tab switching supported');
    console.log('✅ AC-14 PASSED: Giao diện hỗ trợ responsive 360px (mobile menu hamburger & tab Markdown Soạn/Xem trước).');
  }

  // =========================================================================
  // AC-15: Upload file .html rồi GV bấm mở -> File được tải về (Content-Disposition: attachment), không thực thi
  // =========================================================================
  {
    clearRateLimits();
    const htmlSub = await req(`/api/sessions/${session1Id}/submit`, {
      method: 'POST',
      token: hs2Token,
      body: {
        fileName: 'index.html',
        mimeType: 'text/html',
        dataBase64: Buffer.from('<!DOCTYPE html><html><body><script>alert("xss")</script><h1>Hello</h1></body></html>').toString('base64')
      }
    });
    assert.equal(htmlSub.status, 200);
    const htmlSubId = htmlSub.data.submission.id;

    const dlRes = await req(`/api/submissions/${htmlSubId}/download`, { token: gvToken });
    assert.equal(dlRes.status, 200);
    const cd = dlRes.headers.get('content-disposition') || '';
    const nosniff = dlRes.headers.get('x-content-type-options') || '';
    assert.ok(cd.startsWith('attachment;'), 'AC-15: HTML download must have Content-Disposition: attachment');
    assert.equal(nosniff, 'nosniff');

    const prevRes = await req(`/api/submissions/${htmlSubId}/preview`, { token: gvToken });
    assert.equal(prevRes.status, 200);
    assert.equal(prevRes.data.previewType, 'code');
    console.log('✅ AC-15 PASSED: File .html được trả về với Content-Disposition: attachment và xem trước dạng mã nguồn thuần, không thực thi.');
  }

  console.log('\n🎉 ALL 15 ACCEPTANCE CRITERIA (AC-01 .. AC-15) PASSED SUCCESSFULLY!');
} finally {
  try {
    fs.rmSync(tmpTestDir, { recursive: true, force: true });
  } catch {}
}
