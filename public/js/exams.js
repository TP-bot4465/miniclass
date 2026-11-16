import { escapeHtml, highlightCode } from '/js/markdown.js';
import { t, formatDateTime, formatBytes, showToast, openModal } from '/js/app.js';

let activeExamTimer = null;
let activeAntiCheatCleanup = null;

export function cleanupExamListeners() {
  if (activeExamTimer) {
    clearInterval(activeExamTimer);
    activeExamTimer = null;
  }
  if (activeAntiCheatCleanup) {
    activeAntiCheatCleanup();
    activeAntiCheatCleanup = null;
  }
}

const ESSAY_LANG_LABELS = {
  python: 'Python (.py)',
  javascript: 'JavaScript (.js)',
  lua: 'Lua (.lua)',
  cpp: 'C++ (.cpp)',
  c_arduino: 'C / Arduino (.c / .ino)',
  word: 'Word / Văn bản (.docx / text)',
  text: 'Văn bản tự luận'
};

async function examFetch(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && typeof options.body === 'object') {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(options.body);
  }
  const res = await fetch(url, { ...options, headers });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await res.json() : { rawText: await res.text() };
  if (!res.ok) {
    throw new Error(data?.message_vi || data?.message_en || data?.error || `HTTP ${res.status}`);
  }
  return data;
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Không thể đọc file.'));
    reader.readAsDataURL(file);
  });
}

// =========================================================================
// 1. EXAM DIRECTORY SCREEN (#/exams)
// =========================================================================
export async function renderExamsListScreen(currentUser) {
  cleanupExamListeners();
  const app = document.getElementById('app-root');
  app.innerHTML = `<div class="empty-state">${t('loading')}</div>`;

  try {
    const [examsData, classesData] = await Promise.all([
      examFetch('/api/exams'),
      examFetch('/api/classes')
    ]);
    const exams = examsData.exams || [];
    const classes = classesData.classes || [];
    const canManage = currentUser.role === 'admin' || currentUser.role === 'teacher';

    let selectedClassId = '';

    const renderList = () => {
      const filtered = selectedClassId
        ? exams.filter((e) => Number(e.class_id) === Number(selectedClassId))
        : exams;

      const listContainer = document.getElementById('exams-list-container');
      if (!listContainer) return;

      if (filtered.length === 0) {
        listContainer.innerHTML = `<div class="empty-state">Chưa có bài kiểm tra nào trong danh mục này.</div>`;
        return;
      }

      listContainer.innerHTML = `
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>Bài kiểm tra</th>
                <th>Lớp học</th>
                <th>Cấu trúc đề</th>
                <th>Thời gian</th>
                <th>${canManage ? 'Lượt thi / Chờ chấm' : 'Kết quả của bạn'}</th>
                <th>Thao tác</th>
              </tr>
            </thead>
            <tbody>
              ${filtered
                .map((ex) => {
                  let statusCell = '';
                  if (canManage) {
                    statusCell = `
                      <span class="badge">${ex.attempt_count || 0} lượt thi</span>
                      ${
                        ex.ungraded_count > 0
                          ? `<span class="badge badge-late" style="margin-left:4px;">${ex.ungraded_count} chờ chấm TL</span>`
                          : ''
                      }
                    `;
                  } else {
                    if (!ex.attempt_id) {
                      statusCell = `<span class="badge badge-muted">Chưa tham gia</span>`;
                    } else if (ex.attempt_status === 'in_progress') {
                      statusCell = `<span class="badge badge-dark">Đang làm bài</span>`;
                    } else if (ex.attempt_status === 'submitted') {
                      statusCell = `<span class="badge">TN: ${ex.mcq_score}đ (Chờ chấm TL)</span>`;
                    } else if (ex.attempt_status === 'graded') {
                      statusCell = `<span class="badge badge-graded">Tổng: ${ex.total_score} / ${ex.max_points}đ</span>`;
                    }
                  }

                  return `
                    <tr>
                      <td>
                        <a href="#/exams/${ex.id}">${escapeHtml(ex.title)}</a>
                        ${ex.status === 'draft' ? `<span class="badge badge-muted" style="margin-left:6px;">Bản nháp</span>` : ''}
                      </td>
                      <td>${escapeHtml(ex.class_name)}</td>
                      <td>
                        ${ex.mcq_count} câu TN · ${ex.essay_count} câu TL (${ex.max_points}đ)
                      </td>
                      <td>${ex.duration_minutes} phút</td>
                      <td>${statusCell}</td>
                      <td>
                        <div style="display:flex;gap:6px;flex-wrap:nowrap;">
                          <a href="#/exams/${ex.id}" class="btn btn-primary btn-sm">
                            ${canManage ? 'Xem đề' : !ex.attempt_id ? 'Vào thi' : ex.attempt_status === 'in_progress' ? 'Tiếp tục thi' : 'Xem kết quả'}
                          </a>
                          ${
                            canManage
                              ? `
                            <a href="#/exams/${ex.id}/attempts" class="btn btn-secondary btn-sm">Bài làm & Chấm điểm</a>
                            <a href="#/exams/${ex.id}/edit" class="btn btn-ghost btn-sm">Sửa</a>
                            <button type="button" class="btn btn-danger btn-sm btn-del-exam" data-id="${ex.id}" data-title="${escapeHtml(ex.title)}">Xóa</button>
                          `
                              : ''
                          }
                        </div>
                      </td>
                    </tr>
                  `;
                })
                .join('')}
            </tbody>
          </table>
        </div>
      `;

      listContainer.querySelectorAll('.btn-del-exam').forEach((btn) => {
        btn.addEventListener('click', () => {
          const eid = Number(btn.dataset.id);
          const etitle = btn.dataset.title;
          openModal({
            title: 'Xóa bài kiểm tra',
            bodyHtml: `
              <p>Bạn có chắc chắn muốn xóa bài kiểm tra "${escapeHtml(etitle)}" cùng toàn bộ dữ liệu bài làm liên quan?</p>
              <div class="modal-footer">
                <button type="button" class="btn btn-ghost" id="del-ex-cancel">${t('btn_cancel')}</button>
                <button type="button" class="btn btn-danger" id="del-ex-ok">${t('usr_delete')}</button>
              </div>
            `,
            onMount: (close) => {
              document.getElementById('del-ex-cancel')?.addEventListener('click', close);
              document.getElementById('del-ex-ok')?.addEventListener('click', async () => {
                await examFetch(`/api/exams/${eid}`, { method: 'DELETE' });
                close();
                showToast('Đã xóa bài kiểm tra.');
                renderExamsListScreen(currentUser);
              });
            }
          });
        });
      });
    };

    app.innerHTML = `
      <div class="page-header">
        <div>
          <h1 class="page-title">Danh mục Kiểm tra</h1>
          <p class="page-subtitle">Quản lý đề kiểm tra Trắc nghiệm (chấm tự động) kết hợp Tự luận / Code (chấm tay) có giám sát chống gian lận.</p>
        </div>
        ${canManage ? `<a href="#/exams/new" class="btn btn-primary">Tạo bài kiểm tra</a>` : ''}
      </div>

      <div class="filter-bar">
        <select id="exam-class-filter" class="form-select" style="max-width:280px;">
          <option value="">Tất cả lớp học</option>
          ${classes.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')}
        </select>
      </div>

      <div id="exams-list-container"></div>
    `;

    document.getElementById('exam-class-filter')?.addEventListener('change', (e) => {
      selectedClassId = e.target.value;
      renderList();
    });

    renderList();
  } catch (err) {
    app.innerHTML = `<div class="alert alert-error">${escapeHtml(err.message)}</div>`;
  }
}

// =========================================================================
// 2. TEACHER CREATE / EDIT EXAM SCREEN (#/exams/new, #/exams/:id/edit)
// =========================================================================
export async function renderExamEditorScreen(currentUser, examId = null) {
  cleanupExamListeners();
  const app = document.getElementById('app-root');
  if (currentUser.role === 'student') {
    app.innerHTML = `<div class="alert alert-error">403 Forbidden</div>`;
    return;
  }

  app.innerHTML = `<div class="empty-state">${t('loading')}</div>`;

  try {
    const classesData = await examFetch('/api/classes');
    const classes = (classesData.classes || []).filter((c) => c.status === 'active');

    let existingExam = null;
    let questions = [];

    if (examId) {
      const detail = await examFetch(`/api/exams/${examId}`);
      existingExam = detail.exam;
      questions = (detail.questions || []).map((q) => ({ ...q }));
    } else {
      questions = [
        {
          part_type: 'mcq',
          question_text: '',
          option_a: '',
          option_b: '',
          option_c: '',
          option_d: '',
          correct_answer: 'A',
          essay_lang: 'text',
          points: 1
        },
        {
          part_type: 'essay',
          question_text: '',
          option_a: '',
          option_b: '',
          option_c: '',
          option_d: '',
          correct_answer: '',
          essay_lang: 'python',
          points: 2
        }
      ];
    }

    app.innerHTML = `
      <div style="margin-bottom:12px;">
        <a href="#/exams" class="btn btn-ghost btn-sm">Danh mục Kiểm tra</a>
      </div>

      <div class="page-header">
        <h1 class="page-title">${examId ? 'Sửa bài kiểm tra' : 'Tạo bài kiểm tra mới'}</h1>
        <div id="exam-total-points-badge" class="badge badge-graded">Tổng điểm: 0</div>
      </div>

      <div id="exam-editor-err"></div>

      <div class="card">
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px;">
          <div class="form-group">
            <label class="form-label" for="ex-class">Lớp học áp dụng *</label>
            <select id="ex-class" class="form-select" ${examId ? 'disabled' : ''}>
              ${classes
                .map(
                  (c) =>
                    `<option value="${c.id}" ${existingExam && existingExam.class_id === c.id ? 'selected' : ''}>${escapeHtml(c.name)}</option>`
                )
                .join('')}
            </select>
          </div>

          <div class="form-group">
            <label class="form-label" for="ex-duration">Thời gian làm bài (phút - chỉ chạy khi HS bấm bắt đầu) *</label>
            <input type="number" id="ex-duration" class="form-input" min="1" max="300" value="${existingExam ? existingExam.duration_minutes : 45}" required />
          </div>

          <div class="form-group">
            <label class="form-label" for="ex-status">Trạng thái phát hành</label>
            <select id="ex-status" class="form-select">
              <option value="published" ${!existingExam || existingExam.status === 'published' ? 'selected' : ''}>Công bố (Học sinh thấy ngay)</option>
              <option value="draft" ${existingExam?.status === 'draft' ? 'selected' : ''}>Bản nháp (Ẩn với Học sinh)</option>
            </select>
          </div>
        </div>

        <div class="form-group">
          <label class="form-label" for="ex-title">Tiêu đề bài kiểm tra *</label>
          <input type="text" id="ex-title" class="form-input" value="${escapeHtml(existingExam?.title || '')}" placeholder="VD: Kiểm tra giữa kỳ Lập trình Python & C Arduino" required />
        </div>

        <div class="form-group">
          <label class="form-label" for="ex-desc">Hướng dẫn / Quy định phòng thi</label>
          <textarea id="ex-desc" class="form-textarea" rows="2" placeholder="VD: Không mở tài liệu hoặc chuyển tab trong lúc làm bài.">${escapeHtml(existingExam?.description || '')}</textarea>
        </div>
      </div>

      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;margin-bottom:16px;">
          <div>
            <h2 style="margin:0;font-size:17px;">Phần 1 & Phần 2: Danh sách câu hỏi</h2>
            <p class="page-subtitle">Thêm câu hỏi Trắc nghiệm (chấm tự động hoặc nhập từ CSV) và câu hỏi Tự luận / Code (JS, Python, Lua, C++, C Arduino, Word).</p>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <a href="/api/exams/sample-csv" class="btn btn-ghost btn-sm" download>Tải xuống mẫu CSV</a>
            <button type="button" class="btn btn-secondary btn-sm" id="btn-import-mcq-csv">Nhập câu hỏi từ CSV</button>
            <button type="button" class="btn btn-secondary btn-sm" id="btn-add-mcq">Thêm câu Trắc nghiệm</button>
            <button type="button" class="btn btn-primary btn-sm" id="btn-add-essay">Thêm câu Tự luận / Code</button>
          </div>
        </div>

        <div id="questions-builder-list" style="display:flex;flex-direction:column;gap:14px;"></div>

        <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:22px;padding-top:16px;border-top:1px solid var(--border-color);">
          <a href="#/exams" class="btn btn-ghost">${t('btn_cancel')}</a>
          <button type="button" class="btn btn-primary" id="btn-save-exam">Lưu bài kiểm tra</button>
        </div>
      </div>
    `;

    const syncDomToQuestions = () => {
      const cards = document.querySelectorAll('.q-builder-card');
      cards.forEach((card, idx) => {
        const q = questions[idx];
        if (!q) return;
        q.question_text = card.querySelector('.qb-text')?.value || '';
        q.points = Math.max(0.1, Number(card.querySelector('.qb-points')?.value || 1));
        if (q.part_type === 'mcq') {
          q.option_a = card.querySelector('.qb-opt-a')?.value || '';
          q.option_b = card.querySelector('.qb-opt-b')?.value || '';
          q.option_c = card.querySelector('.qb-opt-c')?.value || '';
          q.option_d = card.querySelector('.qb-opt-d')?.value || '';
          q.correct_answer = card.querySelector('.qb-correct')?.value || 'A';
        } else {
          q.essay_lang = card.querySelector('.qb-lang')?.value || 'text';
        }
      });
    };

    const updateTotalBadge = () => {
      const total = questions.reduce((acc, q) => acc + Number(q.points || 0), 0);
      const mcqTotal = questions.filter((q) => q.part_type === 'mcq').reduce((acc, q) => acc + Number(q.points || 0), 0);
      const essayTotal = questions.filter((q) => q.part_type === 'essay').reduce((acc, q) => acc + Number(q.points || 0), 0);
      const badge = document.getElementById('exam-total-points-badge');
      if (badge) {
        badge.textContent = `Tổng điểm: ${Math.round(total * 100) / 100} (TN: ${Math.round(mcqTotal * 100) / 100} · TL: ${Math.round(essayTotal * 100) / 100})`;
      }
    };

    const renderQuestionsBuilder = () => {
      const container = document.getElementById('questions-builder-list');
      if (!container) return;

      if (questions.length === 0) {
        container.innerHTML = `<div class="empty-state">Chưa có câu hỏi nào. Hãy bấm "Thêm câu Trắc nghiệm", "Thêm câu Tự luận / Code" hoặc "Nhập câu hỏi từ CSV".</div>`;
        updateTotalBadge();
        return;
      }

      container.innerHTML = questions
        .map((q, idx) => {
          const isMcq = q.part_type === 'mcq';
          return `
            <div class="q-builder-card" style="padding:16px;border:1px solid var(--border-color);border-radius:var(--radius-sm);background:var(--bg-canvas);">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;gap:8px;flex-wrap:wrap;">
                <div>
                  <span class="badge ${isMcq ? '' : 'badge-graded'}">
                    Câu ${idx + 1} — ${isMcq ? 'Phần Trắc nghiệm (Có điểm ngay)' : 'Phần Tự luận / Lý thuyết (Chấm tay)'}
                  </span>
                </div>
                <div style="display:flex;align-items:center;gap:8px;">
                  <label style="font-size:12px;color:var(--text-muted);">Điểm:</label>
                  <input type="number" step="0.25" min="0.25" max="100" class="form-input qb-points" style="width:85px;padding:4px 8px;" value="${q.points}" />
                  <button type="button" class="btn btn-danger btn-sm btn-remove-q" data-idx="${idx}">Xóa câu</button>
                </div>
              </div>

              <div class="form-group" style="margin-bottom:10px;">
                <textarea class="form-textarea qb-text" rows="2" placeholder="Nhập nội dung câu hỏi số ${idx + 1}...">${escapeHtml(q.question_text)}</textarea>
              </div>

              ${
                isMcq
                  ? `
                <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;">
                  <div>
                    <label class="form-label">Phương án A *</label>
                    <input type="text" class="form-input qb-opt-a" value="${escapeHtml(q.option_a)}" />
                  </div>
                  <div>
                    <label class="form-label">Phương án B *</label>
                    <input type="text" class="form-input qb-opt-b" value="${escapeHtml(q.option_b)}" />
                  </div>
                  <div>
                    <label class="form-label">Phương án C</label>
                    <input type="text" class="form-input qb-opt-c" value="${escapeHtml(q.option_c)}" />
                  </div>
                  <div>
                    <label class="form-label">Phương án D</label>
                    <input type="text" class="form-input qb-opt-d" value="${escapeHtml(q.option_d)}" />
                  </div>
                </div>
                <div style="margin-top:10px;display:flex;align-items:center;gap:10px;">
                  <label class="form-label" style="margin:0;">Đáp án đúng:</label>
                  <select class="form-select qb-correct" style="width:120px;">
                    <option value="A" ${q.correct_answer === 'A' ? 'selected' : ''}>A</option>
                    <option value="B" ${q.correct_answer === 'B' ? 'selected' : ''}>B</option>
                    <option value="C" ${q.correct_answer === 'C' ? 'selected' : ''}>C</option>
                    <option value="D" ${q.correct_answer === 'D' ? 'selected' : ''}>D</option>
                  </select>
                </div>
              `
                  : `
                <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
                  <label class="form-label" style="margin:0;">Ngôn ngữ / Hình thức trả lời:</label>
                  <select class="form-select qb-lang" style="max-width:280px;">
                    ${Object.entries(ESSAY_LANG_LABELS)
                      .map(
                        ([k, label]) =>
                          `<option value="${k}" ${q.essay_lang === k ? 'selected' : ''}>${escapeHtml(label)}</option>`
                      )
                      .join('')}
                  </select>
                </div>
              `
              }
            </div>
          `;
        })
        .join('');

      container.querySelectorAll('.qb-points').forEach((inp) => {
        inp.addEventListener('input', () => {
          syncDomToQuestions();
          updateTotalBadge();
        });
      });

      container.querySelectorAll('.btn-remove-q').forEach((btn) => {
        btn.addEventListener('click', () => {
          syncDomToQuestions();
          questions.splice(Number(btn.dataset.idx), 1);
          renderQuestionsBuilder();
        });
      });

      updateTotalBadge();
    };

    renderQuestionsBuilder();

    document.getElementById('btn-add-mcq')?.addEventListener('click', () => {
      syncDomToQuestions();
      questions.push({
        part_type: 'mcq',
        question_text: '',
        option_a: '',
        option_b: '',
        option_c: '',
        option_d: '',
        correct_answer: 'A',
        essay_lang: 'text',
        points: 1
      });
      renderQuestionsBuilder();
    });

    document.getElementById('btn-add-essay')?.addEventListener('click', () => {
      syncDomToQuestions();
      questions.push({
        part_type: 'essay',
        question_text: '',
        option_a: '',
        option_b: '',
        option_c: '',
        option_d: '',
        correct_answer: '',
        essay_lang: 'python',
        points: 2
      });
      renderQuestionsBuilder();
    });

    // CSV Import Modal for MCQ Questions
    document.getElementById('btn-import-mcq-csv')?.addEventListener('click', () => {
      syncDomToQuestions();
      openModal({
        title: 'Nhập câu hỏi Trắc nghiệm từ file CSV',
        size: 'lg',
        bodyHtml: `
          <p style="font-size:13px;color:var(--text-muted);margin-top:0;">
            Cấu trúc 7 cột chuẩn: <code>question,option_a,option_b,option_c,option_d,correct_answer,points</code>
            (<a href="/api/exams/sample-csv" download>Tải xuống mẫu CSV tại đây</a>).
          </p>
          <div class="form-group">
            <input type="file" id="ex-csv-file" accept=".csv,.txt,.tsv" class="form-input" />
          </div>
          <div class="form-group">
            <textarea id="ex-csv-text" class="form-textarea" rows="6" placeholder="question,option_a,option_b,option_c,option_d,correct_answer,points&#10;Hàm nào dùng để in ra màn hình trong Python?,echo(),console.log(),print(),write(),C,1"></textarea>
          </div>
          <div id="ex-csv-err"></div>
          <div class="modal-footer">
            <button type="button" class="btn btn-ghost" id="ex-csv-cancel">${t('btn_cancel')}</button>
            <button type="button" class="btn btn-primary" id="ex-csv-confirm">Nạp câu hỏi vào đề</button>
          </div>
        `,
        onMount: (close) => {
          document.getElementById('ex-csv-cancel')?.addEventListener('click', close);
          document.getElementById('ex-csv-file')?.addEventListener('change', (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () => {
              document.getElementById('ex-csv-text').value = reader.result || '';
            };
            reader.readAsText(file, 'utf8');
          });

          document.getElementById('ex-csv-confirm')?.addEventListener('click', async () => {
            const csvText = document.getElementById('ex-csv-text').value;
            const errBox = document.getElementById('ex-csv-err');
            try {
              const res = await examFetch('/api/exams/parse-csv', {
                method: 'POST',
                body: { csvText }
              });
              if (res.questions.length > 0) {
                // Remove empty placeholder MCQ if any
                questions = questions.filter((q) => q.question_text.trim() !== '');
                questions.push(...res.questions);
                renderQuestionsBuilder();
              }
              if (res.errors && res.errors.length > 0) {
                errBox.innerHTML = `<div class="alert alert-error">Đã nạp ${res.questions.length} câu, phát hiện ${res.errors.length} dòng lỗi:<br/>${res.errors.map((er) => escapeHtml(er.message_vi)).join('<br/>')}</div>`;
              } else {
                close();
                showToast(`Đã nạp thành công ${res.questions.length} câu hỏi trắc nghiệm từ CSV.`);
              }
            } catch (err) {
              errBox.innerHTML = `<div class="alert alert-error">${escapeHtml(err.message)}</div>`;
            }
          });
        }
      });
    });

    document.getElementById('btn-save-exam')?.addEventListener('click', async () => {
      syncDomToQuestions();
      const errBox = document.getElementById('exam-editor-err');
      errBox.innerHTML = '';

      const class_id = Number(document.getElementById('ex-class').value);
      const title = document.getElementById('ex-title').value.trim();
      const description = document.getElementById('ex-desc').value.trim();
      const duration_minutes = Number(document.getElementById('ex-duration').value || 45);
      const status = document.getElementById('ex-status').value;

      const validQuestions = questions.filter((q) => q.question_text.trim() !== '');
      if (validQuestions.length === 0) {
        errBox.innerHTML = `<div class="alert alert-error">Vui lòng nhập nội dung cho ít nhất 1 câu hỏi.</div>`;
        return;
      }

      for (let i = 0; i < validQuestions.length; i++) {
        const q = validQuestions[i];
        if (q.part_type === 'mcq' && (!q.option_a.trim() || !q.option_b.trim())) {
          errBox.innerHTML = `<div class="alert alert-error">Câu trắc nghiệm số ${i + 1} phải có ít nhất phương án A và B.</div>`;
          return;
        }
      }

      try {
        if (examId) {
          await examFetch(`/api/exams/${examId}`, {
            method: 'PUT',
            body: { title, description, duration_minutes, status, questions: validQuestions }
          });
          showToast('Đã cập nhật bài kiểm tra.');
          window.location.hash = `#/exams/${examId}`;
        } else {
          const res = await examFetch('/api/exams', {
            method: 'POST',
            body: { class_id, title, description, duration_minutes, status, questions: validQuestions }
          });
          showToast('Đã tạo bài kiểm tra mới.');
          window.location.hash = `#/exams/${res.examId}`;
        }
      } catch (err) {
        errBox.innerHTML = `<div class="alert alert-error">${escapeHtml(err.message)}</div>`;
      }
    });
  } catch (err) {
    app.innerHTML = `<div class="alert alert-error">${escapeHtml(err.message)}</div>`;
  }
}

// =========================================================================
// 3. EXAM ROOM & ANTI-CHEAT MONITOR (#/exams/:id)
// =========================================================================
export async function renderExamTakeOrViewScreen(currentUser, examId) {
  cleanupExamListeners();
  const app = document.getElementById('app-root');
  app.innerHTML = `<div class="empty-state">${t('loading')}</div>`;

  try {
    const data = await examFetch(`/api/exams/${examId}`);
    const { exam, myAttempt, questions } = data;
    const isManager = currentUser.role === 'admin' || currentUser.role === 'teacher';

    // Teacher / Admin Preview Mode
    if (isManager) {
      const mcqList = questions.filter((q) => q.part_type === 'mcq');
      const essayList = questions.filter((q) => q.part_type === 'essay');

      app.innerHTML = `
        <div style="margin-bottom:12px;">
          <a href="#/exams" class="btn btn-ghost btn-sm">Danh mục Kiểm tra</a>
        </div>

        <div class="page-header">
          <div>
            <h1 class="page-title">${escapeHtml(exam.title)}</h1>
            <p class="page-subtitle">
              Lớp: ${escapeHtml(exam.class_name)} · Thời gian: ${exam.duration_minutes} phút · Tổng điểm: ${exam.total_points}đ (TN: ${exam.mcq_points}đ · TL: ${exam.essay_points}đ)
            </p>
          </div>
          <div style="display:flex;gap:8px;">
            <a href="#/exams/${examId}/attempts" class="btn btn-primary btn-sm">Danh sách bài thi & Chấm điểm</a>
            <a href="#/exams/${examId}/edit" class="btn btn-secondary btn-sm">Sửa đề</a>
          </div>
        </div>

        ${exam.description ? `<div class="alert">${escapeHtml(exam.description)}</div>` : ''}

        <div class="card">
          <h2 style="margin-top:0;font-size:17px;">Phần 1: Trắc nghiệm (${mcqList.length} câu — Chấm điểm tự động)</h2>
          ${
            mcqList.length === 0
              ? `<p style="color:var(--text-muted);">Không có câu hỏi trắc nghiệm.</p>`
              : mcqList
                  .map(
                    (q, idx) => `
                <div style="padding:12px 0;border-bottom:1px solid var(--border-color);">
                  <div style="margin-bottom:6px;">Câu ${idx + 1} (${q.points}đ): ${escapeHtml(q.question_text)}</div>
                  <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;font-size:13px;color:var(--text-muted);">
                    <div>A. ${escapeHtml(q.option_a)}</div>
                    <div>B. ${escapeHtml(q.option_b)}</div>
                    ${q.option_c ? `<div>C. ${escapeHtml(q.option_c)}</div>` : ''}
                    ${q.option_d ? `<div>D. ${escapeHtml(q.option_d)}</div>` : ''}
                  </div>
                  <div style="margin-top:6px;font-size:12px;"><span class="badge badge-graded">Đáp án đúng: ${escapeHtml(q.correct_answer)}</span></div>
                </div>
              `
                  )
                  .join('')
          }
        </div>

        <div class="card">
          <h2 style="margin-top:0;font-size:17px;">Phần 2: Tự luận / Lý thuyết (${essayList.length} câu — Giáo viên chấm tay)</h2>
          ${
            essayList.length === 0
              ? `<p style="color:var(--text-muted);">Không có câu hỏi tự luận.</p>`
              : essayList
                  .map(
                    (q, idx) => `
                <div style="padding:12px 0;border-bottom:1px solid var(--border-color);">
                  <div style="margin-bottom:6px;">Câu ${idx + 1} (${q.points}đ): ${escapeHtml(q.question_text)}</div>
                  <span class="badge">Ngôn ngữ / Định dạng: ${escapeHtml(ESSAY_LANG_LABELS[q.essay_lang] || q.essay_lang)}</span>
                </div>
              `
                  )
                  .join('')
          }
        </div>
      `;
      return;
    }

    // Student View 1: Not started yet -> Show start screen (Timer only starts when clicking Start)
    if (!myAttempt) {
      app.innerHTML = `
        <div style="margin-bottom:12px;">
          <a href="#/exams" class="btn btn-ghost btn-sm">Danh mục Kiểm tra</a>
        </div>

        <div class="card" style="max-width:680px;margin:24px auto;">
          <h1 class="page-title" style="margin-bottom:8px;">${escapeHtml(exam.title)}</h1>
          <p class="page-subtitle" style="margin-bottom:16px;">Lớp: ${escapeHtml(exam.class_name)} · Giáo viên: ${escapeHtml(exam.teacher_name)}</p>

          ${exam.description ? `<div class="alert">${escapeHtml(exam.description)}</div>` : ''}

          <div style="padding:16px;background:var(--bg-canvas);border:1px solid var(--border-color);border-radius:var(--radius-sm);margin-bottom:18px;">
            <div style="margin-bottom:6px;">Thời gian làm bài: ${exam.duration_minutes} phút (Chỉ bắt đầu tính giờ khi bấm nút "Bắt đầu làm bài")</div>
            <div style="margin-bottom:6px;">Phần 1 (Trắc nghiệm): ${exam.mcq_count} câu (${exam.mcq_points} điểm — Có kết quả ngay khi nộp)</div>
            <div style="margin-bottom:6px;">Phần 2 (Tự luận / Code): ${exam.essay_count} câu (${exam.essay_points} điểm — Giáo viên chấm tay)</div>
            <div>Tổng điểm toàn bài: ${exam.total_points} điểm</div>
          </div>

          <div class="alert alert-error" style="margin-bottom:20px;">
            Chế độ giám sát chống gian lận: Trong suốt thời gian làm bài, hệ thống tự động ghi nhận nhật ký nếu bạn bấm chuột phải hoặc chuyển tab / rời khỏi màn hình bài thi.
          </div>

          <div style="display:flex;justify-content:flex-end;gap:10px;">
            <a href="#/exams" class="btn btn-ghost">Quay lại</a>
            <button type="button" class="btn btn-primary" id="btn-start-exam-now">Bắt đầu làm bài</button>
          </div>
        </div>
      `;

      document.getElementById('btn-start-exam-now')?.addEventListener('click', async () => {
        try {
          await examFetch(`/api/exams/${examId}/start`, { method: 'POST' });
          renderExamTakeOrViewScreen(currentUser, examId);
        } catch (err) {
          showToast(err.message, true);
        }
      });
      return;
    }

    // Student View 2: Already Submitted or Graded -> Show Immediate MCQ Results & Essay Status
    if (myAttempt.status === 'submitted' || myAttempt.status === 'graded') {
      const mcqList = questions.filter((q) => q.part_type === 'mcq');
      const essayList = questions.filter((q) => q.part_type === 'essay');

      app.innerHTML = `
        <div style="margin-bottom:12px;">
          <a href="#/exams" class="btn btn-ghost btn-sm">Danh mục Kiểm tra</a>
        </div>

        <div class="page-header">
          <div>
            <h1 class="page-title">Kết quả bài kiểm tra: ${escapeHtml(exam.title)}</h1>
            <p class="page-subtitle">
              Bắt đầu: ${formatDateTime(myAttempt.started_at)} · Nộp lúc: ${formatDateTime(myAttempt.submitted_at)}
            </p>
          </div>
        </div>

        <div class="stat-grid">
          <div class="stat-card">
            <div class="stat-label">Điểm Phần Trắc nghiệm (Có ngay)</div>
            <div class="stat-value">${myAttempt.mcq_score} / ${exam.mcq_points}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Điểm Phần Tự luận (Chấm tay)</div>
            <div class="stat-value">
              ${myAttempt.essay_score !== null && myAttempt.essay_score !== undefined ? `${myAttempt.essay_score} / ${exam.essay_points}` : 'Chờ chấm'}
            </div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Tổng điểm bài kiểm tra</div>
            <div class="stat-value">
              ${myAttempt.total_score !== null && myAttempt.total_score !== undefined ? `${myAttempt.total_score} / ${exam.total_points}` : 'Chờ chấm TL'}
            </div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Ghi nhận vi phạm quy chế</div>
            <div class="stat-value">${myAttempt.violation_count} lần</div>
          </div>
        </div>

        ${
          myAttempt.teacher_feedback
            ? `<div class="alert alert-success">Nhận xét của Giáo viên: ${escapeHtml(myAttempt.teacher_feedback)}</div>`
            : ''
        }

        <div class="card">
          <h2 style="margin-top:0;font-size:17px;">Chi tiết Phần 1: Trắc nghiệm</h2>
          ${mcqList
            .map((q, idx) => {
              const sel = q.my_answer?.selected_option || 'Chưa chọn';
              const isOk = Boolean(q.my_answer?.is_correct);
              return `
                <div style="padding:12px 0;border-bottom:1px solid var(--border-color);">
                  <div style="display:flex;justify-content:space-between;gap:8px;margin-bottom:6px;">
                    <span>Câu ${idx + 1} (${q.points}đ): ${escapeHtml(q.question_text)}</span>
                    <span class="badge ${isOk ? 'badge-graded' : 'badge-late'}">
                      ${isOk ? `Đúng (+${q.points}đ)` : `Sai (0đ) · Đáp án đúng: ${escapeHtml(q.correct_answer)}`}
                    </span>
                  </div>
                  <div style="font-size:13px;color:var(--text-muted);">
                    Bạn đã chọn: ${escapeHtml(sel)}
                  </div>
                </div>
              `;
            })
            .join('')}
        </div>

        ${
          essayList.length > 0
            ? `
          <div class="card">
            <h2 style="margin-top:0;font-size:17px;">Chi tiết Phần 2: Tự luận / Code</h2>
            ${essayList
              .map((q, idx) => {
                const ans = q.my_answer || {};
                return `
                  <div style="padding:14px 0;border-bottom:1px solid var(--border-color);">
                    <div style="display:flex;justify-content:space-between;gap:8px;margin-bottom:8px;">
                      <span>Câu ${idx + 1} (${q.points}đ): ${escapeHtml(q.question_text)}</span>
                      <span class="badge ${ans.awarded_points !== null && ans.awarded_points !== undefined ? 'badge-graded' : ''}">
                        ${ans.awarded_points !== null && ans.awarded_points !== undefined ? `Điểm: ${ans.awarded_points} / ${q.points}đ` : 'Đang chờ GV chấm'}
                      </span>
                    </div>
                    ${
                      ans.essay_text
                        ? `<div class="md-code-block"><div class="code-lang-header">${escapeHtml(ans.essay_lang || q.essay_lang)}</div><pre><code>${highlightCode(ans.essay_text, ans.essay_lang || q.essay_lang)}</code></pre></div>`
                        : ''
                    }
                    ${
                      ans.file_original_name
                        ? `<div style="margin-top:6px;"><a href="/api/exam-answers/${ans.id}/download" class="btn btn-ghost btn-sm" download>File đã nộp: ${escapeHtml(ans.file_original_name)}</a></div>`
                        : ''
                    }
                    ${
                      ans.teacher_comment
                        ? `<div class="alert" style="margin-top:8px;margin-bottom:0;">Nhận xét của GV: ${escapeHtml(ans.teacher_comment)}</div>`
                        : ''
                    }
                  </div>
                `;
              })
              .join('')}
          </div>
        `
            : ''
        }
      `;
      return;
    }

    // Student View 3: Active Exam Room (in_progress) with Live Timer & Anti-Cheat Monitor
    const mcqList = questions.filter((q) => q.part_type === 'mcq');
    const essayList = questions.filter((q) => q.part_type === 'essay');
    let violationCount = Number(myAttempt.violation_count || 0);
    const pendingEssayFiles = new Map();

    app.innerHTML = `
      <div class="card" style="position:sticky;top:64px;z-index:80;border-color:var(--text-main);">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;">
          <div>
            <div style="font-size:16px;font-weight:500;">Phòng thi: ${escapeHtml(exam.title)}</div>
            <div style="font-size:12px;color:var(--text-muted);" id="anticheat-status-line">
              Giám sát chống gian lận đang bật · Số lần vi phạm (chuột phải / thoát tab): <span id="ac-count-val">${violationCount}</span>
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:12px;">
            <div class="badge badge-dark" style="font-size:15px;padding:6px 12px;" id="exam-timer-display">--:--</div>
            <button type="button" class="btn btn-primary" id="btn-submit-exam-final">Nộp bài kiểm tra</button>
          </div>
        </div>
        <div id="anticheat-live-alert" style="display:none;margin-top:10px;" class="alert alert-error"></div>
      </div>

      ${
        mcqList.length > 0
          ? `
        <div class="card">
          <h2 style="margin-top:0;font-size:17px;">Phần 1: Trắc nghiệm (${mcqList.length} câu — Chấm điểm tự động ngay sau khi nộp)</h2>
          ${mcqList
            .map(
              (q, idx) => `
            <div class="exam-q-block" data-qid="${q.id}" data-type="mcq" style="padding:14px 0;border-bottom:1px solid var(--border-color);">
              <div style="margin-bottom:10px;">Câu ${idx + 1} (${q.points} điểm): ${escapeHtml(q.question_text)}</div>
              <div style="display:flex;flex-direction:column;gap:8px;">
                ${['A', 'B', 'C', 'D']
                  .map((optKey) => {
                    const optText = q[`option_${optKey.toLowerCase()}`];
                    if (!optText) return '';
                    return `
                      <label style="display:flex;align-items:center;gap:10px;padding:8px 12px;border:1px solid var(--border-color);border-radius:var(--radius-sm);background:var(--bg-canvas);cursor:pointer;">
                        <input type="radio" name="mcq_${q.id}" value="${optKey}" />
                        <span>${optKey}. ${escapeHtml(optText)}</span>
                      </label>
                    `;
                  })
                  .join('')}
              </div>
            </div>
          `
            )
            .join('')}
        </div>
      `
          : ''
      }

      ${
        essayList.length > 0
          ? `
        <div class="card">
          <h2 style="margin-top:0;font-size:17px;">Phần 2: Tự luận / Viết Code (${essayList.length} câu — Giáo viên chấm tay)</h2>
          ${essayList
            .map(
              (q, idx) => `
            <div class="exam-q-block" data-qid="${q.id}" data-type="essay" style="padding:16px 0;border-bottom:1px solid var(--border-color);">
              <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px;">
                <div>Câu ${idx + 1} (${q.points} điểm): ${escapeHtml(q.question_text)}</div>
                <select class="form-select essay-lang-select" data-qid="${q.id}" style="max-width:240px;">
                  ${Object.entries(ESSAY_LANG_LABELS)
                    .map(
                      ([k, label]) =>
                        `<option value="${k}" ${q.essay_lang === k ? 'selected' : ''}>${escapeHtml(label)}</option>`
                    )
                    .join('')}
                </select>
              </div>

              <div class="form-group" style="margin-bottom:10px;">
                <textarea class="form-textarea essay-code-input" data-qid="${q.id}" rows="8" placeholder="Nhập câu trả lời lý thuyết hoặc viết code (JS, Python, Lua, C++, C Arduino) tại đây..."></textarea>
              </div>

              <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
                <label class="form-label" style="margin:0;">Hoặc đính kèm file bài làm (.docx, .py, .js, .lua, .cpp, .c, .ino, .pdf ≤ 10 MB):</label>
                <input type="file" class="form-input essay-file-input" data-qid="${q.id}" accept=".doc,.docx,.pdf,.txt,.md,.js,.py,.lua,.c,.cpp,.h,.hpp,.ino,.zip" style="max-width:340px;" />
              </div>
            </div>
          `
            )
            .join('')}
        </div>
      `
          : ''
      }
    `;

    // Bind file inputs for essay questions
    app.querySelectorAll('.essay-file-input').forEach((inp) => {
      inp.addEventListener('change', (e) => {
        const qId = Number(inp.dataset.qid);
        const file = e.target.files?.[0];
        if (!file) {
          pendingEssayFiles.delete(qId);
          return;
        }
        if (file.size > 10 * 1024 * 1024) {
          showToast('File đính kèm vượt quá 10 MB.', true);
          inp.value = '';
          return;
        }
        pendingEssayFiles.set(qId, file);
      });
    });

    // Anti-Cheat Event Logger (Right-click & Tab switch / Window blur)
    let lastBlurTime = 0;
    const recordAntiCheat = async (eventType, detailsText) => {
      try {
        const alertEl = document.getElementById('anticheat-live-alert');
        if (alertEl) {
          alertEl.style.display = 'block';
          alertEl.textContent = `Cảnh báo giám sát: Hệ thống đã ghi nhận hành vi "${detailsText}" lúc ${new Date().toLocaleTimeString()}.`;
        }
        const res = await examFetch(`/api/exams/${examId}/anti-cheat`, {
          method: 'POST',
          body: { event_type: eventType, details: detailsText }
        });
        if (res.violation_count !== undefined) {
          violationCount = res.violation_count;
          const cntEl = document.getElementById('ac-count-val');
          if (cntEl) cntEl.textContent = String(violationCount);
        }
      } catch {}
    };

    const onContextMenu = (e) => {
      e.preventDefault();
      recordAntiCheat('right_click', 'Bấm chuột phải trong phòng thi');
    };

    const onVisibilityChange = () => {
      if (document.hidden) {
        lastBlurTime = Date.now();
        recordAntiCheat('tab_hidden', 'Thoát tab hoặc ẩn trình duyệt khi đang làm bài');
      }
    };

    const onWindowBlur = () => {
      if (Date.now() - lastBlurTime > 1500) {
        lastBlurTime = Date.now();
        recordAntiCheat('window_blur', 'Rời khỏi cửa sổ bài kiểm tra');
      }
    };

    document.addEventListener('contextmenu', onContextMenu);
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('blur', onWindowBlur);

    activeAntiCheatCleanup = () => {
      document.removeEventListener('contextmenu', onContextMenu);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('blur', onWindowBlur);
    };

    let isSubmitting = false;
    const doSubmitExam = async (isAutoTimeout = false) => {
      if (isSubmitting) return;
      isSubmitting = true;
      cleanupExamListeners();

      try {
        const answersPayload = [];
        for (const q of questions) {
          if (q.part_type === 'mcq') {
            const checked = document.querySelector(`input[name="mcq_${q.id}"]:checked`);
            answersPayload.push({
              question_id: q.id,
              selected_option: checked ? checked.value : ''
            });
          } else {
            const textEl = document.querySelector(`.essay-code-input[data-qid="${q.id}"]`);
            const langEl = document.querySelector(`.essay-lang-select[data-qid="${q.id}"]`);
            const fileObj = pendingEssayFiles.get(q.id);
            let fileData = {};
            if (fileObj) {
              const dataBase64 = await readFileAsDataUrl(fileObj);
              fileData = {
                fileName: fileObj.name,
                mimeType: fileObj.type,
                dataBase64
              };
            }
            answersPayload.push({
              question_id: q.id,
              essay_text: textEl ? textEl.value : '',
              essay_lang: langEl ? langEl.value : q.essay_lang,
              ...fileData
            });
          }
        }

        await examFetch(`/api/exams/${examId}/submit`, {
          method: 'POST',
          body: { answers: answersPayload }
        });

        showToast(isAutoTimeout ? 'Hết giờ làm bài! Hệ thống đã tự động thu bài.' : 'Đã nộp bài kiểm tra thành công!');
        renderExamTakeOrViewScreen(currentUser, examId);
      } catch (err) {
        isSubmitting = false;
        showToast(err.message, true);
      }
    };

    // Live Countdown Timer from expires_at
    const expiresMs = new Date(myAttempt.expires_at).getTime();
    const updateTimer = () => {
      const remSec = Math.max(0, Math.floor((expiresMs - Date.now()) / 1000));
      const mm = String(Math.floor(remSec / 60)).padStart(2, '0');
      const ss = String(remSec % 60).padStart(2, '0');
      const timerEl = document.getElementById('exam-timer-display');
      if (timerEl) {
        timerEl.textContent = `Thời gian còn lại: ${mm}:${ss}`;
        if (remSec <= 60) {
          timerEl.className = 'badge badge-late';
        }
      }
      if (remSec <= 0) {
        doSubmitExam(true);
      }
    };
    updateTimer();
    activeExamTimer = setInterval(updateTimer, 1000);

    document.getElementById('btn-submit-exam-final')?.addEventListener('click', () => {
      openModal({
        title: 'Xác nhận nộp bài kiểm tra',
        bodyHtml: `
          <p>Bạn có chắc chắn muốn nộp bài kiểm tra ngay bây giờ? Sau khi nộp, phần Trắc nghiệm sẽ được chấm điểm ngay và bạn không thể sửa lại bài làm.</p>
          <div class="modal-footer">
            <button type="button" class="btn btn-ghost" id="sub-ex-cancel">${t('btn_cancel')}</button>
            <button type="button" class="btn btn-primary" id="sub-ex-ok">Nộp bài</button>
          </div>
        `,
        onMount: (close) => {
          document.getElementById('sub-ex-cancel')?.addEventListener('click', close);
          document.getElementById('sub-ex-ok')?.addEventListener('click', () => {
            close();
            doSubmitExam(false);
          });
        }
      });
    });
  } catch (err) {
    app.innerHTML = `<div class="alert alert-error">${escapeHtml(err.message)}</div>`;
  }
}

// =========================================================================
// 4. TEACHER ATTEMPTS & MANUAL ESSAY GRADING (#/exams/:id/attempts)
// =========================================================================
export async function renderExamAttemptsScreen(currentUser, examId) {
  cleanupExamListeners();
  const app = document.getElementById('app-root');
  if (currentUser.role === 'student') {
    app.innerHTML = `<div class="alert alert-error">403 Forbidden</div>`;
    return;
  }

  app.innerHTML = `<div class="empty-state">${t('loading')}</div>`;

  const loadAttempts = async () => {
    const data = await examFetch(`/api/exams/${examId}/attempts`);
    const { exam, items } = data;

    app.innerHTML = `
      <div style="margin-bottom:12px;">
        <a href="#/exams/${examId}" class="btn btn-ghost btn-sm">${escapeHtml(exam.title)}</a>
      </div>

      <div class="page-header">
        <div>
          <h1 class="page-title">Danh sách bài thi & Chấm điểm: ${escapeHtml(exam.title)}</h1>
          <p class="page-subtitle">Lớp: ${escapeHtml(exam.class_name)} · Thời lượng: ${exam.duration_minutes} phút</p>
        </div>
      </div>

      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>Học sinh</th>
              <th>Trạng thái</th>
              <th>Bắt đầu / Nộp bài</th>
              <th>Cảnh báo gian lận</th>
              <th>Điểm TN</th>
              <th>Điểm Tự luận</th>
              <th>Tổng điểm</th>
              <th>Thao tác</th>
            </tr>
          </thead>
          <tbody>
            ${
              items.length === 0
                ? `<tr><td colspan="8" style="text-align:center;padding:24px;">Lớp chưa có học sinh.</td></tr>`
                : items
                    .map((it) => {
                      let statusBadge = `<span class="badge badge-muted">Chưa thi</span>`;
                      if (it.status === 'in_progress') statusBadge = `<span class="badge badge-dark">Đang làm bài</span>`;
                      else if (it.status === 'submitted') statusBadge = `<span class="badge">Chờ chấm TL</span>`;
                      else if (it.status === 'graded') statusBadge = `<span class="badge badge-graded">Đã chấm hoàn tất</span>`;

                      return `
                        <tr>
                          <td>
                            ${escapeHtml(it.full_name)}<br/>
                            <code style="font-size:12px;color:var(--text-muted);">${escapeHtml(it.username)}</code>
                          </td>
                          <td>${statusBadge}</td>
                          <td>
                            ${it.started_at ? formatDateTime(it.started_at) : '—'}
                            ${it.submitted_at ? `<br/><span style="font-size:12px;color:var(--text-muted);">Nộp: ${formatDateTime(it.submitted_at)}</span>` : ''}
                          </td>
                          <td>
                            ${
                              it.attempt_id
                                ? `<span class="badge ${it.violation_count > 0 ? 'badge-late' : 'badge-muted'}">${it.violation_count} lần vi phạm</span>`
                                : '—'
                            }
                          </td>
                          <td>${it.attempt_id ? `${it.mcq_score}đ` : '—'}</td>
                          <td>${it.essay_score !== null && it.essay_score !== undefined ? `${it.essay_score}đ` : '—'}</td>
                          <td>${it.total_score !== null && it.total_score !== undefined ? `${it.total_score}đ` : '—'}</td>
                          <td>
                            ${
                              it.attempt_id
                                ? `<button type="button" class="btn btn-primary btn-sm btn-grade-attempt" data-attid="${it.attempt_id}">
                                    Xem & Chấm bài
                                   </button>`
                                : '—'
                            }
                          </td>
                        </tr>
                      `;
                    })
                    .join('')
            }
          </tbody>
        </table>
      </div>
    `;

    app.querySelectorAll('.btn-grade-attempt').forEach((btn) => {
      btn.addEventListener('click', () => {
        openAttemptGradingModal(Number(btn.dataset.attid), loadAttempts);
      });
    });
  };

  try {
    await loadAttempts();
  } catch (err) {
    app.innerHTML = `<div class="alert alert-error">${escapeHtml(err.message)}</div>`;
  }
}

async function openAttemptGradingModal(attemptId, onSaved) {
  const detail = await examFetch(`/api/exam-attempts/${attemptId}`);
  const { attempt, questions, antiCheatLogs } = detail;
  const mcqQuestions = questions.filter((q) => q.part_type === 'mcq');
  const essayQuestions = questions.filter((q) => q.part_type === 'essay');

  const eventLabelMap = {
    right_click: 'Bấm chuột phải (contextmenu)',
    tab_hidden: 'Thoát tab trình duyệt (visibilitychange)',
    window_blur: 'Rời cửa sổ làm bài (blur)'
  };

  openModal({
    title: `Bài kiểm tra: ${attempt.student_name} (${attempt.student_username})`,
    size: 'lg',
    bodyHtml: `
      <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:14px;">
        <div>
          Bắt đầu: ${formatDateTime(attempt.started_at)} · Nộp lúc: ${attempt.submitted_at ? formatDateTime(attempt.submitted_at) : 'Đang làm bài'}
        </div>
        <div>
          <span class="badge badge-graded">Điểm Trắc nghiệm: ${attempt.mcq_score}đ</span>
          <span class="badge ${attempt.violation_count > 0 ? 'badge-late' : ''}" style="margin-left:6px;">
            Vi phạm chống gian lận: ${attempt.violation_count} lần
          </span>
        </div>
      </div>

      <div style="margin-bottom:18px;padding:12px;background:var(--bg-canvas);border:1px solid var(--border-color);border-radius:var(--radius-sm);">
        <div class="form-label" style="margin-bottom:6px;">Nhật ký Giám sát Chống gian lận (${antiCheatLogs.length} sự kiện)</div>
        ${
          antiCheatLogs.length === 0
            ? `<div style="font-size:13px;color:var(--text-muted);">Không phát hiện hành vi bấm chuột phải hay thoát tab nào.</div>`
            : `<div style="max-height:130px;overflow-y:auto;font-size:12.5px;">
                ${antiCheatLogs
                  .map(
                    (lg, i) => `
                  <div style="padding:4px 0;border-bottom:1px solid var(--border-color);">
                    #${i + 1} [${formatDateTime(lg.created_at)}] — ${escapeHtml(eventLabelMap[lg.event_type] || lg.event_type)}: ${escapeHtml(lg.details)}
                  </div>
                `
                  )
                  .join('')}
              </div>`
        }
      </div>

      ${
        mcqQuestions.length > 0
          ? `
        <div style="margin-bottom:18px;">
          <div class="form-label">Tóm tắt Phần 1: Trắc nghiệm (${mcqQuestions.length} câu — Đã chấm tự động: ${attempt.mcq_score}đ)</div>
          <div style="display:flex;flex-wrap:wrap;gap:6px;">
            ${mcqQuestions
              .map(
                (q, idx) => `
              <span class="badge ${q.is_correct ? 'badge-graded' : 'badge-late'}">
                Câu ${idx + 1}: Chọn ${escapeHtml(q.selected_option || 'Trống')} (Đáp án: ${escapeHtml(q.correct_answer)})
              </span>
            `
              )
              .join('')}
          </div>
        </div>
      `
          : ''
      }

      <form id="grade-attempt-form">
        <div class="form-label" style="margin-bottom:10px;">Phần 2: Chấm điểm Tự luận / Code (${essayQuestions.length} câu)</div>
        ${
          essayQuestions.length === 0
            ? `<div class="empty-state" style="padding:18px;margin-bottom:14px;">Đề này không có câu hỏi tự luận.</div>`
            : essayQuestions
                .map(
                  (q, idx) => `
              <div class="essay-grade-item" data-qid="${q.id}" style="padding:14px;border:1px solid var(--border-color);border-radius:var(--radius-sm);margin-bottom:14px;background:var(--bg-canvas);">
                <div style="display:flex;justify-content:space-between;gap:8px;margin-bottom:8px;">
                  <span>Câu ${idx + 1} (Tối đa ${q.points} điểm): ${escapeHtml(q.question_text)}</span>
                  <span class="badge">${escapeHtml(ESSAY_LANG_LABELS[q.student_essay_lang || q.essay_lang] || q.essay_lang)}</span>
                </div>

                ${
                  q.essay_text
                    ? `<div class="md-code-block"><div class="code-lang-header">Bài làm Code / Văn bản (${escapeHtml(q.student_essay_lang || q.essay_lang)})</div><pre><code>${highlightCode(q.essay_text, q.student_essay_lang || q.essay_lang)}</code></pre></div>`
                    : `<div style="font-size:13px;color:var(--text-muted);margin-bottom:8px;">(Học sinh không nhập văn bản trực tiếp)</div>`
                }

                ${
                  q.file_original_name && q.answer_id
                    ? `<div style="margin-bottom:10px;">
                        <a href="/api/exam-answers/${q.answer_id}/download" class="btn btn-secondary btn-sm" download>
                          Tải file đính kèm: ${escapeHtml(q.file_original_name)} (${formatBytes(q.file_size_bytes)})
                        </a>
                       </div>`
                    : ''
                }

                <div style="display:grid;grid-template-columns:160px 1fr;gap:10px;align-items:start;margin-top:10px;">
                  <div>
                    <label class="form-label">Điểm (0 – ${q.points})</label>
                    <input type="number" step="0.25" min="0" max="${q.points}" class="form-input eg-points" value="${q.awarded_points !== null && q.awarded_points !== undefined ? q.awarded_points : q.points}" required />
                  </div>
                  <div>
                    <label class="form-label">Nhận xét câu ${idx + 1}</label>
                    <input type="text" class="form-input eg-comment" value="${escapeHtml(q.teacher_comment || '')}" placeholder="Nhận xét code / giải thuật / lý thuyết..." />
                  </div>
                </div>
              </div>
            `
                )
                .join('')
        }

        <div class="form-group">
          <label class="form-label" for="eg-overall-feedback">Nhận xét chung toàn bài kiểm tra</label>
          <textarea id="eg-overall-feedback" class="form-textarea" rows="2">${escapeHtml(attempt.teacher_feedback || '')}</textarea>
        </div>

        <div id="eg-err-box"></div>

        <div class="modal-footer">
          <button type="button" class="btn btn-ghost" id="eg-cancel">${t('btn_cancel')}</button>
          <button type="submit" class="btn btn-primary">Lưu điểm Tự luận & Tổng kết</button>
        </div>
      </form>
    `,
    onMount: (close) => {
      document.getElementById('eg-cancel')?.addEventListener('click', close);
      document.getElementById('grade-attempt-form')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const grades = [];
        document.querySelectorAll('.essay-grade-item').forEach((item) => {
          grades.push({
            question_id: Number(item.dataset.qid),
            awarded_points: Number(item.querySelector('.eg-points')?.value || 0),
            teacher_comment: item.querySelector('.eg-comment')?.value.trim() || ''
          });
        });

        try {
          const res = await examFetch(`/api/exam-attempts/${attemptId}/grade`, {
            method: 'PUT',
            body: {
              grades,
              teacher_feedback: document.getElementById('eg-overall-feedback')?.value.trim() || ''
            }
          });
          close();
          showToast(`Đã chấm xong! Tổng điểm: ${res.total_score} (TN: ${res.mcq_score} + TL: ${res.essay_score})`);
          if (onSaved) onSaved();
        } catch (err) {
          document.getElementById('eg-err-box').innerHTML = `<div class="alert alert-error">${escapeHtml(err.message)}</div>`;
        }
      });
    }
  });
}
