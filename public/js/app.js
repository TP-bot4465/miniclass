import { VI } from '/i18n/vi.js';
import { EN } from '/i18n/en.js';
import { renderMarkdown, escapeHtml, highlightCode } from '/js/markdown.js';
import {
  renderExamsListScreen,
  renderExamEditorScreen,
  renderExamTakeOrViewScreen,
  renderExamAttemptsScreen,
  cleanupExamListeners
} from '/js/exams.js';

const DICT = { vi: VI, en: EN };

const state = {
  user: null,
  csrfToken: null,
  unreadNotifications: 0,
  lang: localStorage.getItem('miniclass_lang') || 'vi',
  mobileMenuOpen: false,
  settings: {
    allowed_submission_extensions: [
      'doc', 'docx', 'pdf', 'txt', 'md', 'py', 'ipynb', 'html', 'css',
      'js', 'java', 'c', 'cpp', 'zip', 'rar', 'xls', 'xlsx', 'ppt', 'pptx', 'png', 'jpg'
    ],
    max_submission_size_mb: 10,
    max_attachment_size_mb: 20,
    max_image_size_mb: 5,
    badge_color_mode: 'subtle'
  },
  autoSaveTimer: null
};

export function t(key) {
  const table = DICT[state.lang] || DICT.vi;
  return table[key] ?? DICT.vi[key] ?? key;
}

/**
 * Format timestamp in Asia/Ho_Chi_Minh (UTC+7) according to I18N-04:
 * VI: dd/MM/yyyy HH:mm
 * EN: MMM dd, yyyy hh:mm a
 */
export function formatDateTime(isoStr) {
  if (!isoStr) return '—';
  const d = new Date(isoStr);
  if (Number.isNaN(d.getTime())) return escapeHtml(isoStr);

  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Ho_Chi_Minh',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).formatToParts(d);
    const map = {};
    for (const p of parts) map[p.type] = p.value;
    const hh24 = Number(map.hour || 0) % 24;

    if (state.lang === 'vi') {
      return `${map.day}/${map.month}/${map.year} ${String(hh24).padStart(2, '0')}:${map.minute}`;
    } else {
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const mName = months[Number(map.month) - 1] || map.month;
      const ampm = hh24 >= 12 ? 'PM' : 'AM';
      const hh12 = hh24 % 12 || 12;
      return `${mName} ${map.day}, ${map.year} ${String(hh12).padStart(2, '0')}:${map.minute} ${ampm}`;
    }
  } catch {
    return d.toLocaleString();
  }
}

export function formatDateOnly(dateStr) {
  if (!dateStr) return '—';
  const clean = String(dateStr).slice(0, 10);
  const m = clean.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return formatDateTime(dateStr);
  const [, yyyy, mm, dd] = m;
  if (state.lang === 'vi') {
    return `${dd}/${mm}/${yyyy}`;
  }
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[Number(mm) - 1] || mm} ${dd}, ${yyyy}`;
}

export function formatBytes(bytes) {
  const b = Number(bytes || 0);
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(2)} MB`;
}

export function showToast(msg, isError = false) {
  const root = document.getElementById('toast-root');
  if (!root) return;
  const el = document.createElement('div');
  el.className = `toast ${isError ? 'toast-error' : ''}`;
  el.textContent = msg;
  root.appendChild(el);
  setTimeout(() => {
    el.remove();
  }, 4000);
}

/**
 * API Fetch helper
 */
async function apiFetch(url, options = {}) {
  const headers = {
    ...(options.headers || {})
  };
  if (options.body && typeof options.body === 'object' && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(options.body);
  }
  if (state.csrfToken) {
    headers['X-CSRF-Token'] = state.csrfToken;
  }

  const res = await fetch(url, {
    ...options,
    headers
  });

  const contentType = res.headers.get('content-type') || '';
  let data = null;
  if (contentType.includes('application/json')) {
    data = await res.json();
  } else {
    data = { rawText: await res.text() };
  }

  if (!res.ok) {
    const msg =
      (state.lang === 'en' ? data?.message_en : data?.message_vi) ||
      data?.message_vi ||
      data?.error ||
      `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.data = data;
    throw err;
  }

  return data;
}

function readFileAsBase64(file, onProgress) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onprogress = (evt) => {
      if (evt.lengthComputable && onProgress) {
        onProgress(Math.round((evt.loaded / evt.total) * 70));
      }
    };
    reader.onload = () => {
      if (onProgress) onProgress(80);
      resolve(reader.result);
    };
    reader.onerror = () => reject(new Error('Không thể đọc file từ thiết bị.'));
    reader.readAsDataURL(file);
  });
}

function applyBadgeMode() {
  if (state.settings?.badge_color_mode === 'monochrome') {
    document.body.classList.add('monochrome-mode');
  } else {
    document.body.classList.remove('monochrome-mode');
  }
}

/**
 * Modal Helper (UI-06)
 */
export function openModal({ title, bodyHtml, size = '', onMount }) {
  const root = document.getElementById('modal-root');
  root.innerHTML = `
    <div class="modal-backdrop" id="active-modal-backdrop">
      <div class="modal-box ${size === 'lg' ? 'modal-lg' : ''}" role="dialog" aria-modal="true">
        <div class="modal-header">
          <h3 class="modal-title">${escapeHtml(title)}</h3>
          <button type="button" class="btn btn-ghost btn-sm" id="modal-close-x" aria-label="Close">${t('btn_close')}</button>
        </div>
        <div class="modal-body" id="modal-body-content">${bodyHtml}</div>
      </div>
    </div>
  `;
  const close = () => {
    root.innerHTML = '';
  };
  document.getElementById('modal-close-x')?.addEventListener('click', close);
  document.getElementById('active-modal-backdrop')?.addEventListener('click', (e) => {
    if (e.target.id === 'active-modal-backdrop') close();
  });
  if (onMount) onMount(close);
  return close;
}

export function closeModal() {
  const root = document.getElementById('modal-root');
  if (root) root.innerHTML = '';
}

/**
 * Render Navigation Bar (I18N-02, NOT-01, UI-04)
 */
function renderNavbar() {
  const navRoot = document.getElementById('navbar-root');
  if (!navRoot) return;

  const hash = window.location.hash || '#/';

  if (!state.user) {
    navRoot.innerHTML = `
      <nav class="navbar">
        <div class="navbar-inner">
          <a href="#/login" class="brand">${t('app_name')}</a>
          <div class="nav-actions">
            <div class="lang-switch" role="group" aria-label="Language Switcher">
              <button type="button" class="lang-btn ${state.lang === 'vi' ? 'active' : ''}" data-lang="vi">VI</button>
              <button type="button" class="lang-btn ${state.lang === 'en' ? 'active' : ''}" data-lang="en">EN</button>
            </div>
          </div>
        </div>
      </nav>
    `;
    bindLangButtons(navRoot);
    return;
  }

  const roleLabel =
    state.user.role === 'admin'
      ? t('role_admin')
      : state.user.role === 'teacher'
      ? t('role_teacher')
      : t('role_student');

  navRoot.innerHTML = `
    <nav class="navbar">
      <div class="navbar-inner">
        <div style="display:flex;align-items:center;gap:14px;">
          <button type="button" class="hamburger-btn" id="hamburger-toggle" aria-label="Menu">Menu</button>
          <a href="#/" class="brand">${t('app_name')}</a>
          <div class="nav-links ${state.mobileMenuOpen ? 'mobile-open' : ''}" id="nav-links-container">
            <a href="#/" class="nav-link ${hash === '#/' ? 'active' : ''}">${t('nav_dashboard')}</a>
            <a href="#/classes" class="nav-link ${hash.startsWith('#/classes') ? 'active' : ''}">${t('nav_classes')}</a>
            <a href="#/exams" class="nav-link ${hash.startsWith('#/exams') ? 'active' : ''}">${t('nav_exams')}</a>
            ${
              state.user.role === 'admin'
                ? `
              <a href="#/admin/users" class="nav-link ${hash.startsWith('#/admin/users') ? 'active' : ''}">${t('nav_users')}</a>
              <a href="#/admin/audit" class="nav-link ${hash.startsWith('#/admin/audit') ? 'active' : ''}">${t('nav_audit')}</a>
              <a href="#/admin/settings" class="nav-link ${hash.startsWith('#/admin/settings') ? 'active' : ''}">${t('nav_settings')}</a>
            `
                : ''
            }
            <a href="#/profile" class="nav-link ${hash.startsWith('#/profile') ? 'active' : ''}">${t('nav_profile')}</a>
          </div>
        </div>

        <div class="nav-actions">
          <div class="lang-switch" role="group" aria-label="Language Switcher">
            <button type="button" class="lang-btn ${state.lang === 'vi' ? 'active' : ''}" data-lang="vi">VI</button>
            <button type="button" class="lang-btn ${state.lang === 'en' ? 'active' : ''}" data-lang="en">EN</button>
          </div>

          <a href="#/notifications" class="bell-btn" title="${t('nav_notifications')}" aria-label="${t('nav_notifications')}">
            <span>${t('nav_notifications')}</span>
            ${state.unreadNotifications > 0 ? `<span class="bell-count">${state.unreadNotifications}</span>` : ''}
          </a>

          <a href="#/profile" class="badge" style="text-decoration:none;" title="${escapeHtml(state.user.full_name)}">
            ${escapeHtml(state.user.username)} (${escapeHtml(roleLabel)})
          </a>

          <button type="button" class="btn btn-ghost btn-sm" id="btn-logout">${t('nav_logout')}</button>
        </div>
      </div>
    </nav>
  `;

  bindLangButtons(navRoot);

  document.getElementById('hamburger-toggle')?.addEventListener('click', () => {
    state.mobileMenuOpen = !state.mobileMenuOpen;
    document.getElementById('nav-links-container')?.classList.toggle('mobile-open', state.mobileMenuOpen);
  });

  document.getElementById('btn-logout')?.addEventListener('click', async () => {
    try {
      await apiFetch('/api/auth/logout', { method: 'POST' });
    } catch {}
    state.user = null;
    state.csrfToken = null;
    window.location.hash = '#/login';
  });
}

function bindLangButtons(container) {
  container.querySelectorAll('.lang-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const newLang = btn.dataset.lang === 'en' ? 'en' : 'vi';
      if (newLang === state.lang) return;
      state.lang = newLang;
      localStorage.setItem('miniclass_lang', newLang);
      document.documentElement.lang = newLang;
      if (state.user) {
        try {
          await apiFetch('/api/auth/profile', {
            method: 'PUT',
            body: { language: newLang }
          });
          state.user.language = newLang;
        } catch {}
      }
      renderNavbar();
      route();
    });
  });
}

// =========================================================================
// S01: LOGIN SCREEN
// =========================================================================
function renderLoginScreen() {
  const app = document.getElementById('app-root');
  app.innerHTML = `
    <div class="auth-wrapper">
      <div class="card">
        <h1 class="page-title" style="margin-bottom:6px;">${t('login_title')}</h1>
        <p class="page-subtitle" style="margin-bottom:20px;">${t('login_subtitle')}</p>
        <div id="login-error-box"></div>
        <form id="login-form">
          <div class="form-group">
            <label class="form-label" for="login-username">${t('login_username')}</label>
            <input type="text" id="login-username" class="form-input" autocomplete="username" required />
          </div>
          <div class="form-group">
            <label class="form-label" for="login-password">${t('login_password')}</label>
            <input type="password" id="login-password" class="form-input" autocomplete="current-password" required />
          </div>
          <button type="submit" class="btn btn-primary" style="width:100%;margin-top:4px;" id="login-submit-btn">
            ${t('login_btn')}
          </button>
        </form>

        <div style="margin-top:20px;padding-top:14px;border-top:1px solid var(--border-color);">
          <div style="font-size:12.5px;color:var(--text-muted);">${t('login_demo_hint')}</div>
          <div class="demo-chip-list">
            <button type="button" class="demo-chip" data-u="admin" data-p="Admin1234">Admin (admin)</button>
            <button type="button" class="demo-chip" data-u="gv_minh" data-p="Teacher123">GV Nguyễn Văn Minh (gv_minh)</button>
            <button type="button" class="demo-chip" data-u="hs_an" data-p="Student123">HS Lê Hoàng An (hs_an)</button>
            <button type="button" class="demo-chip" data-u="hs_binh" data-p="Student123">HS Phạm Thanh Bình (hs_binh)</button>
            <button type="button" class="demo-chip" data-u="hs_khanh" data-p="TempPass123">HS Lần đầu (hs_khanh)</button>
          </div>
          <p style="font-size:12px;color:var(--text-muted);margin:12px 0 0;">
            ${t('login_no_register_note')}
          </p>
        </div>
      </div>
    </div>
  `;

  app.querySelectorAll('.demo-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      document.getElementById('login-username').value = chip.dataset.u;
      document.getElementById('login-password').value = chip.dataset.p;
    });
  });

  document.getElementById('login-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errBox = document.getElementById('login-error-box');
    errBox.innerHTML = '';
    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value;

    try {
      const res = await apiFetch('/api/auth/login', {
        method: 'POST',
        body: { username, password }
      });
      state.user = res.user;
      state.csrfToken = res.csrfToken;
      if (res.settings) {
        state.settings = res.settings;
        applyBadgeMode();
      }
      if (res.user.language) {
        state.lang = res.user.language;
        localStorage.setItem('miniclass_lang', state.lang);
      }
      renderNavbar();
      if (state.user.must_change_password) {
        window.location.hash = '#/change-password';
      } else {
        window.location.hash = '#/';
      }
    } catch (err) {
      errBox.innerHTML = `<div class="alert alert-error">${escapeHtml(err.message)}</div>`;
    }
  });
}

// =========================================================================
// S02: CHANGE PASSWORD SCREEN (AUTH-04, AUTH-05, AC-02)
// =========================================================================
function renderChangePasswordScreen() {
  const app = document.getElementById('app-root');
  const isForced = Boolean(state.user?.must_change_password);

  app.innerHTML = `
    <div class="auth-wrapper">
      <div class="card">
        <h1 class="page-title" style="margin-bottom:8px;">${t('pwd_change_title')}</h1>
        ${
          isForced
            ? `<div class="alert alert-error" style="margin-top:10px;">${t('pwd_force_banner')}</div>`
            : ''
        }
        <div id="pwd-msg-box"></div>
        <form id="pwd-form">
          <div class="form-group">
            <label class="form-label" for="pwd-old">${t('pwd_old')}</label>
            <input type="password" id="pwd-old" class="form-input" required />
          </div>
          <div class="form-group">
            <label class="form-label" for="pwd-new">${t('pwd_new')}</label>
            <input type="password" id="pwd-new" class="form-input" required minlength="8" />
          </div>
          <div class="form-group">
            <label class="form-label" for="pwd-confirm">${t('pwd_confirm')}</label>
            <input type="password" id="pwd-confirm" class="form-input" required minlength="8" />
          </div>
          <div style="display:flex;gap:10px;justify-content:flex-end;">
            ${!isForced ? `<a href="#/" class="btn btn-ghost">${t('btn_cancel')}</a>` : ''}
            <button type="submit" class="btn btn-primary">${t('pwd_submit')}</button>
          </div>
        </form>
      </div>
    </div>
  `;

  document.getElementById('pwd-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const msgBox = document.getElementById('pwd-msg-box');
    msgBox.innerHTML = '';
    const oldPassword = document.getElementById('pwd-old').value;
    const newPassword = document.getElementById('pwd-new').value;
    const confirmPassword = document.getElementById('pwd-confirm').value;

    if (newPassword !== confirmPassword) {
      msgBox.innerHTML = `<div class="alert alert-error">${t('pwd_mismatch')}</div>`;
      return;
    }

    try {
      const res = await apiFetch('/api/auth/change-password', {
        method: 'POST',
        body: { oldPassword, newPassword }
      });
      state.user.must_change_password = false;
      showToast(state.lang === 'en' ? res.message_en : res.message_vi);
      window.location.hash = '#/';
    } catch (err) {
      msgBox.innerHTML = `<div class="alert alert-error">${escapeHtml(err.message)}</div>`;
    }
  });
}

// =========================================================================
// S03: DASHBOARD SCREEN (Admin / Teacher / Student)
// =========================================================================
async function renderDashboardScreen() {
  const app = document.getElementById('app-root');
  app.innerHTML = `<div class="empty-state">${t('loading')}</div>`;

  try {
    const data = await apiFetch('/api/dashboard');

    if (data.role === 'admin') {
      const { roleCounts, classCounts, sessionCount, submissionCount, storageBytes } = data.stats;
      const sumRole = (r) => roleCounts.filter((x) => x.role === r).reduce((a, b) => a + b.cnt, 0);
      const totalUsers = roleCounts.reduce((a, b) => a + b.cnt, 0);
      const totalClasses = classCounts.reduce((a, b) => a + b.cnt, 0);

      app.innerHTML = `
        <div class="page-header">
          <div>
            <h1 class="page-title">${t('dash_admin_overview')}</h1>
            <p class="page-subtitle">${t('dash_welcome')}, ${escapeHtml(state.user.full_name)}</p>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <a href="#/admin/users" class="btn btn-primary">${t('nav_users')}</a>
            <a href="#/classes" class="btn btn-secondary">${t('nav_classes')}</a>
          </div>
        </div>

        <div class="stat-grid">
          <div class="stat-card">
            <div class="stat-label">${t('dash_total_users')}</div>
            <div class="stat-value">${totalUsers}</div>
            <div style="font-size:12.5px;color:var(--text-muted);margin-top:6px;">
              Admin: ${sumRole('admin')} · GV: ${sumRole('teacher')} · HS: ${sumRole('student')}
            </div>
          </div>
          <div class="stat-card">
            <div class="stat-label">${t('dash_total_classes')}</div>
            <div class="stat-value">${totalClasses}</div>
            <div style="font-size:12.5px;color:var(--text-muted);margin-top:6px;">
              ${t('dash_total_sessions')}: ${sessionCount}
            </div>
          </div>
          <div class="stat-card">
            <div class="stat-label">${t('dash_total_sessions')} / Bài nộp</div>
            <div class="stat-value">${sessionCount} / ${submissionCount}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">${t('dash_storage_used')}</div>
            <div class="stat-value">${formatBytes(storageBytes)}</div>
          </div>
        </div>

        <div class="card">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
            <h2 style="margin:0;font-size:17px;">${t('dash_recent_audit')}</h2>
            <a href="#/admin/audit" class="btn btn-ghost btn-sm">${t('nav_audit')}</a>
          </div>
          <div class="table-wrap">
            <table class="data-table">
              <thead>
                <tr>
                  <th>Thời gian</th>
                  <th>Người thực hiện</th>
                  <th>Hành động</th>
                  <th>Đối tượng</th>
                </tr>
              </thead>
              <tbody>
                ${(data.recentLogs || [])
                  .map(
                    (l) => `
                  <tr>
                    <td>${formatDateTime(l.created_at)}</td>
                    <td><strong>${escapeHtml(l.actor_username)}</strong></td>
                    <td><span class="badge">${escapeHtml(l.action)}</span></td>
                    <td>${escapeHtml(l.target_type)} #${escapeHtml(l.target_id || '')}</td>
                  </tr>
                `
                  )
                  .join('')}
              </tbody>
            </table>
          </div>
        </div>
      `;
      return;
    }

    if (data.role === 'teacher') {
      const classes = data.classes || [];
      app.innerHTML = `
        <div class="page-header">
          <div>
            <h1 class="page-title">${t('dash_my_classes')}</h1>
            <p class="page-subtitle">${t('dash_welcome')}, ${escapeHtml(state.user.full_name)}</p>
          </div>
          <a href="#/classes" class="btn btn-primary">${t('cls_create_btn')}</a>
        </div>
        ${
          classes.length === 0
            ? `<div class="empty-state">${t('dash_no_classes')}</div>`
            : `<div class="grid-cards">
                ${classes
                  .map(
                    (c) => `
                  <div class="class-card">
                    <div>
                      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
                        <h3 class="class-card-title"><a href="#/classes/${c.id}">${escapeHtml(c.name)}</a></h3>
                        <span class="badge ${c.status === 'archived' ? 'badge-muted' : ''}">
                          ${c.status === 'archived' ? t('status_archived') : t('status_active')}
                        </span>
                      </div>
                      <p class="class-card-desc">${escapeHtml(c.description || '—')}</p>
                    </div>
                    <div class="class-card-meta">
                      <span>${c.student_count} ${t('cls_students_count')} · ${c.session_count} ${t('cls_sessions_count')}</span>
                      ${
                        c.ungraded_count > 0
                          ? `<span class="badge badge-late">${c.ungraded_count} ${t('dash_ungraded_badge')}</span>`
                          : ''
                      }
                    </div>
                  </div>
                `
                  )
                  .join('')}
              </div>`
        }
      `;
      return;
    }

    // Student dashboard
    const classes = data.classes || [];
    const tasks = data.upcomingTasks || [];

    app.innerHTML = `
      <div class="page-header">
        <div>
          <h1 class="page-title">${t('dash_my_classes')}</h1>
          <p class="page-subtitle">${t('dash_welcome')}, ${escapeHtml(state.user.full_name)}</p>
        </div>
      </div>

      ${
        classes.length === 0
          ? `<div class="empty-state">${t('dash_no_classes')}</div>`
          : `<div class="grid-cards" style="margin-bottom:32px;">
              ${classes
                .map(
                  (c) => `
                <div class="class-card">
                  <div>
                    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
                      <h3 class="class-card-title"><a href="#/classes/${c.id}">${escapeHtml(c.name)}</a></h3>
                      ${c.status === 'archived' ? `<span class="badge badge-muted">${t('status_archived')}</span>` : ''}
                    </div>
                    <p class="class-card-desc">${escapeHtml(c.description || '—')}</p>
                  </div>
                  <div class="class-card-meta">
                    <span>GV: ${escapeHtml(c.teacher_name)}</span>
                    <span>${c.session_count} ${t('cls_sessions_count')}</span>
                  </div>
                </div>
              `
                )
                .join('')}
            </div>`
      }

      <h2 style="font-size:18px;margin-bottom:12px;">${t('dash_upcoming_tasks')}</h2>
      ${
        tasks.length === 0
          ? `<div class="empty-state">${t('dash_no_upcoming')}</div>`
          : `<div class="table-wrap">
              <table class="data-table">
                <thead>
                  <tr>
                    <th>${t('cls_name')}</th>
                    <th>${t('tab_sessions')}</th>
                    <th>Deadline</th>
                    <th>${t('grd_col_status')}</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  ${tasks
                    .map((tk) => {
                      let badgeHtml = `<span class="badge badge-muted">${t('sub_not_submitted')}</span>`;
                      if (tk.submission_id) {
                        if (tk.score !== null && tk.score !== undefined) {
                          badgeHtml = `<span class="badge badge-graded">${t('sub_graded')}: ${tk.score}/10</span>`;
                        } else if (tk.is_late) {
                          badgeHtml = `<span class="badge badge-late">${t('sub_late')}</span>`;
                        } else {
                          badgeHtml = `<span class="badge">${t('sub_submitted')}</span>`;
                        }
                      }
                      return `
                        <tr>
                          <td>${escapeHtml(tk.class_name)}</td>
                          <td><a href="#/classes/${tk.class_id}/sessions/${tk.session_id}"><strong>${escapeHtml(tk.title)}</strong></a></td>
                          <td>${tk.deadline ? formatDateTime(tk.deadline) : '—'}</td>
                          <td>${badgeHtml}</td>
                          <td>
                            <a href="#/classes/${tk.class_id}/sessions/${tk.session_id}" class="btn btn-secondary btn-sm">
                              ${tk.submission_id ? 'Xem bài' : t('sub_submit_btn')}
                            </a>
                          </td>
                        </tr>
                      `;
                    })
                    .join('')}
                </tbody>
              </table>
            </div>`
      }
    `;
  } catch (err) {
    app.innerHTML = `<div class="alert alert-error">${escapeHtml(err.message)}</div>`;
  }
}

// =========================================================================
// S04: ADMIN USER MANAGEMENT (USR-01..USR-08)
// =========================================================================
async function renderAdminUsersScreen() {
  const app = document.getElementById('app-root');
  if (state.user?.role !== 'admin') {
    app.innerHTML = `<div class="alert alert-error">403 Forbidden</div>`;
    return;
  }

  let roleFilter = '';
  let statusFilter = '';
  let qFilter = '';

  const loadAndRender = async () => {
    const params = new URLSearchParams();
    if (roleFilter) params.set('role', roleFilter);
    if (statusFilter) params.set('status', statusFilter);
    if (qFilter) params.set('q', qFilter);

    const data = await apiFetch(`/api/admin/users?${params.toString()}`);
    const users = data.users || [];

    const tbody = document.getElementById('users-tbody');
    if (!tbody) return;

    if (users.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:24px;">${t('empty_data')}</td></tr>`;
      return;
    }

    tbody.innerHTML = users
      .map((u) => {
        const roleLabel =
          u.role === 'admin' ? t('role_admin') : u.role === 'teacher' ? t('role_teacher') : t('role_student');
        const statusBadge =
          u.status === 'locked'
            ? `<span class="badge badge-late">${t('status_locked')}</span>`
            : `<span class="badge badge-graded">${t('status_active')}</span>`;

        return `
          <tr>
            <td><strong>${escapeHtml(u.full_name)}</strong></td>
            <td><code>${escapeHtml(u.username)}</code></td>
            <td>${escapeHtml(u.email)}</td>
            <td><span class="badge">${escapeHtml(roleLabel)}</span></td>
            <td>${statusBadge}</td>
            <td>
              <div style="display:flex;gap:6px;flex-wrap:nowrap;">
                <button type="button" class="btn btn-ghost btn-sm btn-edit-user" data-id="${u.id}">${t('usr_edit')}</button>
                <button type="button" class="btn btn-ghost btn-sm btn-reset-pwd" data-id="${u.id}" data-u="${escapeHtml(u.username)}">${t('usr_reset_pwd')}</button>
                ${
                  u.id !== state.user.id
                    ? `
                  <button type="button" class="btn btn-ghost btn-sm btn-toggle-lock" data-id="${u.id}" data-status="${u.status}" data-u="${escapeHtml(u.username)}">
                    ${u.status === 'locked' ? t('usr_unlock') : t('usr_lock')}
                  </button>
                  <button type="button" class="btn btn-danger btn-sm btn-delete-user" data-id="${u.id}" data-u="${escapeHtml(u.username)}">
                    ${t('usr_delete')}
                  </button>
                `
                    : ''
                }
              </div>
            </td>
          </tr>
        `;
      })
      .join('');

    // Edit user handler (USR-03)
    tbody.querySelectorAll('.btn-edit-user').forEach((btn) => {
      btn.addEventListener('click', () => {
        const u = users.find((x) => x.id === Number(btn.dataset.id));
        if (!u) return;
        openModal({
          title: `${t('usr_edit')}: ${u.username}`,
          bodyHtml: `
            <div id="edit-user-err"></div>
            <form id="edit-user-form">
              <div class="form-group">
                <label class="form-label">Username (Cố định - BR-02)</label>
                <input type="text" class="form-input" value="${escapeHtml(u.username)}" readonly disabled />
              </div>
              <div class="form-group">
                <label class="form-label">${t('usr_col_fullname')} *</label>
                <input type="text" id="eu-fullname" class="form-input" value="${escapeHtml(u.full_name)}" required />
              </div>
              <div class="form-group">
                <label class="form-label">${t('usr_col_email')} *</label>
                <input type="email" id="eu-email" class="form-input" value="${escapeHtml(u.email)}" required />
              </div>
              <div class="form-group">
                <label class="form-label">${t('usr_col_role')} *</label>
                <select id="eu-role" class="form-select">
                  <option value="student" ${u.role === 'student' ? 'selected' : ''}>${t('role_student')}</option>
                  <option value="teacher" ${u.role === 'teacher' ? 'selected' : ''}>${t('role_teacher')}</option>
                  <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>${t('role_admin')}</option>
                </select>
              </div>
              <div class="modal-footer">
                <button type="button" class="btn btn-ghost" id="eu-cancel">${t('btn_cancel')}</button>
                <button type="submit" class="btn btn-primary">${t('btn_save')}</button>
              </div>
            </form>
          `,
          onMount: (close) => {
            document.getElementById('eu-cancel')?.addEventListener('click', close);
            document.getElementById('edit-user-form')?.addEventListener('submit', async (e) => {
              e.preventDefault();
              try {
                await apiFetch(`/api/admin/users/${u.id}`, {
                  method: 'PUT',
                  body: {
                    full_name: document.getElementById('eu-fullname').value.trim(),
                    email: document.getElementById('eu-email').value.trim(),
                    role: document.getElementById('eu-role').value
                  }
                });
                close();
                showToast('Đã cập nhật thông tin tài khoản.');
                loadAndRender();
              } catch (err) {
                document.getElementById('edit-user-err').innerHTML = `<div class="alert alert-error">${escapeHtml(err.message)}</div>`;
              }
            });
          }
        });
      });
    });

    // Reset password handler (USR-05)
    tbody.querySelectorAll('.btn-reset-pwd').forEach((btn) => {
      btn.addEventListener('click', () => {
        const uid = Number(btn.dataset.id);
        const uname = btn.dataset.u;
        openModal({
          title: `${t('usr_reset_pwd')}: ${uname}`,
          bodyHtml: `
            <div id="rp-err"></div>
            <p style="font-size:13.5px;color:var(--text-muted);">
              Nhập mật khẩu tạm mới (≥ 8 ký tự, gồm chữ và số) hoặc để trống để hệ thống tự sinh ngẫu nhiên và hiển thị 1 lần.
            </p>
            <div class="form-group">
              <label class="form-label">${t('usr_temp_password')}</label>
              <input type="text" id="rp-input" class="form-input" placeholder="Để trống để sinh ngẫu nhiên..." />
            </div>
            <div id="rp-result-box"></div>
            <div class="modal-footer">
              <button type="button" class="btn btn-ghost" id="rp-close">${t('btn_close')}</button>
              <button type="button" class="btn btn-primary" id="rp-confirm">${t('btn_confirm')}</button>
            </div>
          `,
          onMount: (close) => {
            document.getElementById('rp-close')?.addEventListener('click', close);
            document.getElementById('rp-confirm')?.addEventListener('click', async () => {
              try {
                const customPwd = document.getElementById('rp-input').value.trim();
                const res = await apiFetch(`/api/admin/users/${uid}/reset-password`, {
                  method: 'POST',
                  body: { newPassword: customPwd || undefined }
                });
                document.getElementById('rp-result-box').innerHTML = `
                  <div class="alert alert-success">
                    Đã đặt lại mật khẩu cho <strong>${escapeHtml(uname)}</strong>.<br/>
                    Mật khẩu tạm (hiển thị 1 lần): <code style="font-size:16px;font-weight:700;">${escapeHtml(res.tempPassword)}</code>
                  </div>
                `;
                document.getElementById('rp-confirm').disabled = true;
              } catch (err) {
                document.getElementById('rp-err').innerHTML = `<div class="alert alert-error">${escapeHtml(err.message)}</div>`;
              }
            });
          }
        });
      });
    });

    // Lock / Unlock handler (USR-04)
    tbody.querySelectorAll('.btn-toggle-lock').forEach((btn) => {
      btn.addEventListener('click', () => {
        const uid = Number(btn.dataset.id);
        const curStatus = btn.dataset.status;
        const uname = btn.dataset.u;
        const nextStatus = curStatus === 'locked' ? 'active' : 'locked';
        openModal({
          title: `${nextStatus === 'locked' ? t('usr_lock') : t('usr_unlock')}: ${uname}`,
          bodyHtml: `
            <p>Bạn có chắc chắn muốn <strong>${nextStatus === 'locked' ? 'Khóa' : 'Mở khóa'}</strong> tài khoản <code>${escapeHtml(uname)}</code>?</p>
            <div class="modal-footer">
              <button type="button" class="btn btn-ghost" id="lk-cancel">${t('btn_cancel')}</button>
              <button type="button" class="btn btn-primary" id="lk-ok">${t('btn_confirm')}</button>
            </div>
          `,
          onMount: (close) => {
            document.getElementById('lk-cancel')?.addEventListener('click', close);
            document.getElementById('lk-ok')?.addEventListener('click', async () => {
              try {
                await apiFetch(`/api/admin/users/${uid}/status`, {
                  method: 'POST',
                  body: { status: nextStatus }
                });
                close();
                showToast('Đã cập nhật trạng thái tài khoản.');
                loadAndRender();
              } catch (err) {
                showToast(err.message, true);
              }
            });
          }
        });
      });
    });

    // Delete user handler with USR-06 suggest-lock fallback
    tbody.querySelectorAll('.btn-delete-user').forEach((btn) => {
      btn.addEventListener('click', () => {
        const uid = Number(btn.dataset.id);
        const uname = btn.dataset.u;
        openModal({
          title: `${t('usr_delete')}: ${uname}`,
          bodyHtml: `
            <div id="del-u-msg">
              <p>Bạn có chắc chắn muốn xóa tài khoản <code>${escapeHtml(uname)}</code>?</p>
            </div>
            <div class="modal-footer" id="del-u-footer">
              <button type="button" class="btn btn-ghost" id="du-cancel">${t('btn_cancel')}</button>
              <button type="button" class="btn btn-danger" id="du-confirm">${t('usr_delete')}</button>
            </div>
          `,
          onMount: (close) => {
            document.getElementById('du-cancel')?.addEventListener('click', close);
            document.getElementById('du-confirm')?.addEventListener('click', async () => {
              try {
                await apiFetch(`/api/admin/users/${uid}`, { method: 'DELETE' });
                close();
                showToast(`Đã xóa tài khoản ${uname}.`);
                loadAndRender();
              } catch (err) {
                // USR-06: Suggest locking if user has related data
                if (err.data?.suggestLock) {
                  document.getElementById('del-u-msg').innerHTML = `
                    <div class="alert alert-error">${escapeHtml(err.message)}</div>
                  `;
                  document.getElementById('del-u-footer').innerHTML = `
                    <button type="button" class="btn btn-ghost" id="du-cancel2">${t('btn_cancel')}</button>
                    <button type="button" class="btn btn-primary" id="du-lock-instead">Khóa tài khoản thay vì xóa</button>
                  `;
                  document.getElementById('du-cancel2')?.addEventListener('click', close);
                  document.getElementById('du-lock-instead')?.addEventListener('click', async () => {
                    await apiFetch(`/api/admin/users/${uid}/status`, {
                      method: 'POST',
                      body: { status: 'locked' }
                    });
                    close();
                    showToast(`Đã khóa tài khoản ${uname}.`);
                    loadAndRender();
                  });
                } else {
                  document.getElementById('del-u-msg').innerHTML = `<div class="alert alert-error">${escapeHtml(err.message)}</div>`;
                }
              }
            });
          }
        });
      });
    });
  };

  app.innerHTML = `
    <div class="page-header">
      <div>
        <h1 class="page-title">${t('usr_title')}</h1>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button type="button" class="btn btn-secondary" id="btn-open-csv">${t('usr_import_btn')}</button>
        <button type="button" class="btn btn-primary" id="btn-open-create-user">${t('usr_create_btn')}</button>
      </div>
    </div>

    <div class="filter-bar">
      <input type="text" id="usr-search" class="form-input" style="max-width:300px;" placeholder="${t('usr_search_placeholder')}" />
      <select id="usr-role-filter" class="form-select" style="max-width:180px;">
        <option value="">${t('usr_filter_all_roles')}</option>
        <option value="admin">${t('role_admin')}</option>
        <option value="teacher">${t('role_teacher')}</option>
        <option value="student">${t('role_student')}</option>
      </select>
      <select id="usr-status-filter" class="form-select" style="max-width:180px;">
        <option value="">${t('usr_filter_all_status')}</option>
        <option value="active">${t('status_active')}</option>
        <option value="locked">${t('status_locked')}</option>
      </select>
    </div>

    <div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr>
            <th>${t('usr_col_fullname')}</th>
            <th>${t('usr_col_username')}</th>
            <th>${t('usr_col_email')}</th>
            <th>${t('usr_col_role')}</th>
            <th>${t('usr_col_status')}</th>
            <th>${t('usr_col_actions')}</th>
          </tr>
        </thead>
        <tbody id="users-tbody">
          <tr><td colspan="6" style="text-align:center;padding:24px;">${t('loading')}</td></tr>
        </tbody>
      </table>
    </div>
  `;

  document.getElementById('usr-search')?.addEventListener('input', (e) => {
    qFilter = e.target.value.trim();
    loadAndRender();
  });
  document.getElementById('usr-role-filter')?.addEventListener('change', (e) => {
    roleFilter = e.target.value;
    loadAndRender();
  });
  document.getElementById('usr-status-filter')?.addEventListener('change', (e) => {
    statusFilter = e.target.value;
    loadAndRender();
  });

  // Create user modal (USR-01, USR-08)
  document.getElementById('btn-open-create-user')?.addEventListener('click', () => {
    openModal({
      title: t('usr_create_btn'),
      bodyHtml: `
        <div id="cu-err"></div>
        <form id="create-user-form">
          <div class="form-group">
            <label class="form-label">${t('usr_col_fullname')} *</label>
            <input type="text" id="cu-fullname" class="form-input" required placeholder="Nguyễn Văn A" />
          </div>
          <div class="form-group">
            <label class="form-label">${t('usr_col_username')} *</label>
            <input type="text" id="cu-username" class="form-input" required placeholder="hs_nguyenvana" />
          </div>
          <div class="form-group">
            <label class="form-label">${t('usr_col_email')} *</label>
            <input type="email" id="cu-email" class="form-input" required placeholder="vana@student.edu.vn" />
          </div>
          <div class="form-group">
            <label class="form-label">${t('usr_col_role')} *</label>
            <select id="cu-role" class="form-select">
              <option value="student">${t('role_student')}</option>
              <option value="teacher">${t('role_teacher')}</option>
              <option value="admin">${t('role_admin')}</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">${t('usr_temp_password')} * (≥ 8 ký tự, gồm chữ và số)</label>
            <input type="text" id="cu-pwd" class="form-input" value="TempPass123" required />
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-ghost" id="cu-cancel">${t('btn_cancel')}</button>
            <button type="submit" class="btn btn-primary">${t('btn_save')}</button>
          </div>
        </form>
      `,
      onMount: (close) => {
        document.getElementById('cu-cancel')?.addEventListener('click', close);
        document.getElementById('create-user-form')?.addEventListener('submit', async (e) => {
          e.preventDefault();
          try {
            const res = await apiFetch('/api/admin/users', {
              method: 'POST',
              body: {
                full_name: document.getElementById('cu-fullname').value.trim(),
                username: document.getElementById('cu-username').value.trim(),
                email: document.getElementById('cu-email').value.trim(),
                role: document.getElementById('cu-role').value,
                password: document.getElementById('cu-pwd').value.trim()
              }
            });
            close();
            showToast(`Đã tạo tài khoản ${res.user.username} (MK tạm: ${res.tempPassword})`);
            loadAndRender();
          } catch (err) {
            document.getElementById('cu-err').innerHTML = `<div class="alert alert-error">${escapeHtml(err.message)}</div>`;
          }
        });
      }
    });
  });

  // Bulk CSV Import Modal (USR-07)
  document.getElementById('btn-open-csv')?.addEventListener('click', () => {
    openModal({
      title: t('usr_csv_title'),
      size: 'lg',
      bodyHtml: `
        <p style="font-size:13.5px;color:var(--text-muted);margin-top:0;">${t('usr_csv_help')}</p>
        <div class="form-group">
          <input type="file" id="csv-file-input" accept=".csv,.txt,.tsv" class="form-input" />
        </div>
        <div class="form-group">
          <textarea id="csv-text-area" class="form-textarea" rows="6" placeholder="Họ tên,Username,Email,Mật khẩu tạm&#10;Trần Minh Đức,hs_duc,duc.tran@student.edu.vn,Student123&#10;Hoàng Thu Hà,hs_ha,ha.hoang@student.edu.vn,Student123"></textarea>
        </div>
        <div id="csv-report-box"></div>
        <div class="modal-footer">
          <button type="button" class="btn btn-ghost" id="csv-close">${t('btn_close')}</button>
          <button type="button" class="btn btn-primary" id="csv-run-btn">${t('usr_import_btn')}</button>
        </div>
      `,
      onMount: (close) => {
        document.getElementById('csv-close')?.addEventListener('click', close);
        document.getElementById('csv-file-input')?.addEventListener('change', (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          const reader = new FileReader();
          reader.onload = () => {
            document.getElementById('csv-text-area').value = reader.result || '';
          };
          reader.readAsText(file, 'utf8');
        });

        document.getElementById('csv-run-btn')?.addEventListener('click', async () => {
          const csvText = document.getElementById('csv-text-area').value;
          const reportBox = document.getElementById('csv-report-box');
          try {
            const res = await apiFetch('/api/admin/users/import-csv', {
              method: 'POST',
              body: { csvText }
            });
            reportBox.innerHTML = `
              <div class="alert ${res.errorCount > 0 ? 'alert-error' : 'alert-success'}">
                Đã tạo thành công: <strong>${res.createdCount}</strong> tài khoản · Lỗi: <strong>${res.errorCount}</strong> dòng.
              </div>
              <div class="table-wrap" style="max-height:220px;overflow-y:auto;">
                <table class="data-table">
                  <thead>
                    <tr><th>Dòng</th><th>Username</th><th>Kết quả</th></tr>
                  </thead>
                  <tbody>
                    ${res.results
                      .map(
                        (r) => `
                      <tr>
                        <td>#${r.row}</td>
                        <td><code>${escapeHtml(r.username)}</code></td>
                        <td>
                          ${
                            r.status === 'created'
                              ? `<span class="badge badge-graded">Thành công (MK: ${escapeHtml(r.tempPassword)})</span>`
                              : `<span class="badge badge-late">${escapeHtml(state.lang === 'en' ? r.error_en : r.error_vi)}</span>`
                          }
                        </td>
                      </tr>
                    `
                      )
                      .join('')}
                  </tbody>
                </table>
              </div>
            `;
            loadAndRender();
          } catch (err) {
            reportBox.innerHTML = `<div class="alert alert-error">${escapeHtml(err.message)}</div>`;
          }
        });
      }
    });
  });

  await loadAndRender();
}

// =========================================================================
// S05: CLASSES DIRECTORY (CLS-01..CLS-06)
// =========================================================================
async function renderClassesListScreen() {
  const app = document.getElementById('app-root');
  app.innerHTML = `<div class="empty-state">${t('loading')}</div>`;

  try {
    const data = await apiFetch('/api/classes');
    const classes = data.classes || [];
    const canCreate = state.user.role === 'admin' || state.user.role === 'teacher';

    app.innerHTML = `
      <div class="page-header">
        <div>
          <h1 class="page-title">${t('cls_title')}</h1>
        </div>
        ${canCreate ? `<button type="button" class="btn btn-primary" id="btn-create-class">${t('cls_create_btn')}</button>` : ''}
      </div>

      ${
        classes.length === 0
          ? `<div class="empty-state">${t('dash_no_classes')}</div>`
          : `<div class="grid-cards">
              ${classes
                .map(
                  (c) => `
                <div class="class-card">
                  <div>
                    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
                      <h3 class="class-card-title"><a href="#/classes/${c.id}">${escapeHtml(c.name)}</a></h3>
                      <span class="badge ${c.status === 'archived' ? 'badge-muted' : ''}">
                        ${c.status === 'archived' ? t('status_archived') : t('status_active')}
                      </span>
                    </div>
                    <p class="class-card-desc">${escapeHtml(c.description || '—')}</p>
                  </div>
                  <div class="class-card-meta">
                    <span>GV: <strong>${escapeHtml(c.teacher_name)}</strong></span>
                    <span>
                      ${c.student_count !== undefined ? `${c.student_count} ${t('cls_students_count')} · ` : ''}
                      ${c.session_count} ${t('cls_sessions_count')}
                    </span>
                  </div>
                </div>
              `
                )
                .join('')}
            </div>`
      }
    `;

    document.getElementById('btn-create-class')?.addEventListener('click', async () => {
      let teachers = [];
      if (state.user.role === 'admin') {
        const tData = await apiFetch('/api/teachers');
        teachers = tData.teachers || [];
      }

      openModal({
        title: t('cls_create_btn'),
        bodyHtml: `
          <div id="cc-err"></div>
          <form id="cc-form">
            <div class="form-group">
              <label class="form-label">${t('cls_name')} *</label>
              <input type="text" id="cc-name" class="form-input" required placeholder="VD: Lập trình Web căn bản" />
            </div>
            <div class="form-group">
              <label class="form-label">${t('cls_desc')}</label>
              <textarea id="cc-desc" class="form-textarea" rows="3"></textarea>
            </div>
            ${
              state.user.role === 'admin'
                ? `
              <div class="form-group">
                <label class="form-label">${t('cls_teacher')} *</label>
                <select id="cc-teacher" class="form-select" required>
                  <option value="">-- Chọn Giáo viên --</option>
                  ${teachers.map((tc) => `<option value="${tc.id}">${escapeHtml(tc.full_name)} (${escapeHtml(tc.username)})</option>`).join('')}
                </select>
              </div>
            `
                : ''
            }
            <div class="modal-footer">
              <button type="button" class="btn btn-ghost" id="cc-cancel">${t('btn_cancel')}</button>
              <button type="submit" class="btn btn-primary">${t('btn_save')}</button>
            </div>
          </form>
        `,
        onMount: (close) => {
          document.getElementById('cc-cancel')?.addEventListener('click', close);
          document.getElementById('cc-form')?.addEventListener('submit', async (e) => {
            e.preventDefault();
            try {
              const payload = {
                name: document.getElementById('cc-name').value.trim(),
                description: document.getElementById('cc-desc').value.trim()
              };
              if (state.user.role === 'admin') {
                payload.teacher_id = Number(document.getElementById('cc-teacher').value);
              }
              const res = await apiFetch('/api/classes', {
                method: 'POST',
                body: payload
              });
              close();
              showToast('Đã tạo lớp học mới.');
              window.location.hash = `#/classes/${res.classId}`;
            } catch (err) {
              document.getElementById('cc-err').innerHTML = `<div class="alert alert-error">${escapeHtml(err.message)}</div>`;
            }
          });
        }
      });
    });
  } catch (err) {
    app.innerHTML = `<div class="alert alert-error">${escapeHtml(err.message)}</div>`;
  }
}

// =========================================================================
// S06, S07, S08: CLASS DETAIL SCREEN (Tabs: Sessions | Members | Gradebook)
// =========================================================================
async function renderClassDetailScreen(classId, activeTab = 'sessions') {
  const app = document.getElementById('app-root');
  app.innerHTML = `<div class="empty-state">${t('loading')}</div>`;

  try {
    const { class: cls } = await apiFetch(`/api/classes/${classId}`);
    const isManager = state.user.role === 'admin' || (state.user.role === 'teacher' && cls.teacher_id === state.user.id);

    app.innerHTML = `
      <div style="margin-bottom:12px;">
        <a href="#/classes" class="btn btn-ghost btn-sm">${t('cls_back_list')}</a>
      </div>

      <div class="page-header">
        <div>
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
            <h1 class="page-title">${escapeHtml(cls.name)}</h1>
            <span class="badge ${cls.status === 'archived' ? 'badge-muted' : ''}">
              ${cls.status === 'archived' ? t('status_archived') : t('status_active')}
            </span>
          </div>
          <p class="page-subtitle">
            ${escapeHtml(cls.description || '')}
            ${cls.description ? ' · ' : ''}GV: <strong>${escapeHtml(cls.teacher_name)}</strong>
          </p>
        </div>

        ${
          isManager
            ? `<div style="display:flex;gap:8px;flex-wrap:wrap;">
                <button type="button" class="btn btn-ghost btn-sm" id="btn-edit-class">${t('cls_edit')}</button>
                <button type="button" class="btn btn-ghost btn-sm" id="btn-toggle-archive">
                  ${cls.status === 'archived' ? t('cls_restore') : t('cls_archive')}
                </button>
                ${
                  state.user.role === 'admin'
                    ? `<button type="button" class="btn btn-danger btn-sm" id="btn-delete-class">${t('cls_delete')}</button>`
                    : ''
                }
              </div>`
            : ''
        }
      </div>

      ${cls.status === 'archived' ? `<div class="alert">${t('cls_archived_banner')}</div>` : ''}

      <div class="tabs-bar" role="tablist">
        <button type="button" class="tab-btn ${activeTab === 'sessions' ? 'active' : ''}" data-tab="sessions">
          ${t('tab_sessions')} (${cls.session_count})
        </button>
        ${
          isManager
            ? `<button type="button" class="tab-btn ${activeTab === 'members' ? 'active' : ''}" data-tab="members">
                ${t('tab_members')} (${cls.student_count})
              </button>`
            : ''
        }
        <button type="button" class="tab-btn ${activeTab === 'gradebook' ? 'active' : ''}" data-tab="gradebook">
          ${t('tab_gradebook')}
        </button>
      </div>

      <div id="class-tab-body"></div>
    `;

    app.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.tab;
        window.location.hash = `#/classes/${classId}?tab=${tab}`;
      });
    });

    // Edit class modal (CLS-03, CLS-06)
    document.getElementById('btn-edit-class')?.addEventListener('click', async () => {
      let teachers = [];
      if (state.user.role === 'admin') {
        const tData = await apiFetch('/api/teachers');
        teachers = tData.teachers || [];
      }
      openModal({
        title: t('cls_edit'),
        bodyHtml: `
          <div id="ec-err"></div>
          <form id="ec-form">
            <div class="form-group">
              <label class="form-label">${t('cls_name')} *</label>
              <input type="text" id="ec-name" class="form-input" value="${escapeHtml(cls.name)}" required />
            </div>
            <div class="form-group">
              <label class="form-label">${t('cls_desc')}</label>
              <textarea id="ec-desc" class="form-textarea" rows="3">${escapeHtml(cls.description || '')}</textarea>
            </div>
            ${
              state.user.role === 'admin'
                ? `
              <div class="form-group">
                <label class="form-label">${t('cls_teacher')}</label>
                <select id="ec-teacher" class="form-select">
                  ${teachers
                    .map(
                      (tc) =>
                        `<option value="${tc.id}" ${tc.id === cls.teacher_id ? 'selected' : ''}>${escapeHtml(tc.full_name)} (${escapeHtml(tc.username)})</option>`
                    )
                    .join('')}
                </select>
              </div>
            `
                : ''
            }
            <div class="modal-footer">
              <button type="button" class="btn btn-ghost" id="ec-cancel">${t('btn_cancel')}</button>
              <button type="submit" class="btn btn-primary">${t('btn_save')}</button>
            </div>
          </form>
        `,
        onMount: (close) => {
          document.getElementById('ec-cancel')?.addEventListener('click', close);
          document.getElementById('ec-form')?.addEventListener('submit', async (e) => {
            e.preventDefault();
            try {
              const body = {
                name: document.getElementById('ec-name').value.trim(),
                description: document.getElementById('ec-desc').value.trim()
              };
              if (state.user.role === 'admin') {
                body.teacher_id = Number(document.getElementById('ec-teacher').value);
              }
              await apiFetch(`/api/classes/${classId}`, { method: 'PUT', body });
              close();
              showToast('Đã cập nhật lớp học.');
              renderClassDetailScreen(classId, activeTab);
            } catch (err) {
              document.getElementById('ec-err').innerHTML = `<div class="alert alert-error">${escapeHtml(err.message)}</div>`;
            }
          });
        }
      });
    });

    // Archive / Restore class (CLS-04)
    document.getElementById('btn-toggle-archive')?.addEventListener('click', () => {
      const nextStatus = cls.status === 'archived' ? 'active' : 'archived';
      openModal({
        title: nextStatus === 'archived' ? t('cls_archive') : t('cls_restore'),
        bodyHtml: `
          <p>
            ${
              nextStatus === 'archived'
                ? 'Khi lưu trữ, lớp chuyển sang trạng thái chỉ đọc: Học sinh vẫn xem được bài giảng và điểm nhưng không thể nộp bài. Bạn có thể khôi phục bất kỳ lúc nào.'
                : 'Khôi phục lớp học về trạng thái hoạt động bình thường?'
            }
          </p>
          <div class="modal-footer">
            <button type="button" class="btn btn-ghost" id="ar-cancel">${t('btn_cancel')}</button>
            <button type="button" class="btn btn-primary" id="ar-ok">${t('btn_confirm')}</button>
          </div>
        `,
        onMount: (close) => {
          document.getElementById('ar-cancel')?.addEventListener('click', close);
          document.getElementById('ar-ok')?.addEventListener('click', async () => {
            await apiFetch(`/api/classes/${classId}`, { method: 'PUT', body: { status: nextStatus } });
            close();
            showToast('Đã cập nhật trạng thái lớp học.');
            renderClassDetailScreen(classId, activeTab);
          });
        }
      });
    });

    // Delete class (CLS-05: Admin only, requires typing exact class name)
    document.getElementById('btn-delete-class')?.addEventListener('click', () => {
      openModal({
        title: t('cls_delete'),
        bodyHtml: `
          <div id="dc-err"></div>
          <p>
            Hành động này sẽ xóa vĩnh viễn lớp <strong>${escapeHtml(cls.name)}</strong> cùng toàn bộ buổi học, bài nộp và file liên quan.
          </p>
          <div class="form-group">
            <label class="form-label">Gõ chính xác tên lớp (<code>${escapeHtml(cls.name)}</code>) để xác nhận:</label>
            <input type="text" id="dc-confirm-input" class="form-input" placeholder="${escapeHtml(cls.name)}" />
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-ghost" id="dc-cancel">${t('btn_cancel')}</button>
            <button type="button" class="btn btn-danger" id="dc-ok">${t('cls_delete')}</button>
          </div>
        `,
        onMount: (close) => {
          document.getElementById('dc-cancel')?.addEventListener('click', close);
          document.getElementById('dc-ok')?.addEventListener('click', async () => {
            try {
              const confirmName = document.getElementById('dc-confirm-input').value.trim();
              await apiFetch(`/api/classes/${classId}`, {
                method: 'DELETE',
                body: { confirmName }
              });
              close();
              showToast('Đã xóa lớp học.');
              window.location.hash = '#/classes';
            } catch (err) {
              document.getElementById('dc-err').innerHTML = `<div class="alert alert-error">${escapeHtml(err.message)}</div>`;
            }
          });
        }
      });
    });

    const tabContainer = document.getElementById('class-tab-body');
    if (activeTab === 'members' && isManager) {
      await renderClassMembersTab(classId, tabContainer);
    } else if (activeTab === 'gradebook') {
      await renderClassGradebookTab(classId, tabContainer);
    } else {
      await renderClassSessionsTab(classId, cls, isManager, tabContainer);
    }
  } catch (err) {
    app.innerHTML = `<div class="alert alert-error">${escapeHtml(err.message)}</div>`;
  }
}

// S06: Sessions Tab
async function renderClassSessionsTab(classId, cls, isManager, container) {
  const data = await apiFetch(`/api/classes/${classId}/sessions`);
  const sessions = data.sessions || [];

  container.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
      <h2 style="margin:0;font-size:18px;">${t('tab_sessions')}</h2>
      ${
        isManager
          ? `<a href="#/classes/${classId}/sessions/new" class="btn btn-primary btn-sm">${t('ses_create_btn')}</a>`
          : ''
      }
    </div>

    ${
      sessions.length === 0
        ? `<div class="empty-state">${t('ses_empty')}</div>`
        : `<div class="table-wrap">
            <table class="data-table">
              <thead>
                <tr>
                  <th>Ngày học</th>
                  <th>Tiêu đề buổi học</th>
                  <th>Deadline nộp bài</th>
                  <th>${isManager ? 'Bài nộp / Đã chấm' : t('grd_col_status')}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                ${sessions
                  .map((s) => {
                    let statusCol = '';
                    if (isManager) {
                      statusCol = s.requires_submission
                        ? `<a href="#/classes/${classId}/sessions/${s.id}/submissions" class="badge">
                            ${s.submission_count || 0}/${data.totalStudents || 0} đã nộp · ${s.graded_count || 0} đã chấm
                           </a>`
                        : `<span class="badge badge-muted">${t('sub_no_requirement')}</span>`;
                    } else {
                      if (!s.requires_submission) {
                        statusCol = `<span class="badge badge-muted">${t('sub_no_requirement')}</span>`;
                      } else if (!s.submission_id) {
                        statusCol = `<span class="badge badge-muted">${t('sub_not_submitted')}</span>`;
                      } else if (s.needs_regrade) {
                        statusCol = `<span class="badge">${t('sub_needs_regrade')}</span>`;
                      } else if (s.score !== null && s.score !== undefined) {
                        statusCol = `<span class="badge badge-graded">${t('sub_graded')}: ${s.score}/10</span>`;
                      } else if (s.is_late) {
                        statusCol = `<span class="badge badge-late">${t('sub_late')}</span>`;
                      } else {
                        statusCol = `<span class="badge">${t('sub_submitted')}</span>`;
                      }
                    }

                    return `
                      <tr>
                        <td style="white-space:nowrap;">${formatDateOnly(s.session_date)}</td>
                        <td>
                          <a href="#/classes/${classId}/sessions/${s.id}"><strong>${escapeHtml(s.title)}</strong></a>
                          ${s.status === 'draft' ? `<span class="badge badge-muted" style="margin-left:6px;">${t('status_draft')}</span>` : ''}
                        </td>
                        <td>${s.requires_submission ? (s.deadline ? formatDateTime(s.deadline) : 'Không giới hạn') : '—'}</td>
                        <td>${statusCol}</td>
                        <td style="text-align:right;">
                          <div style="display:inline-flex;gap:6px;">
                            <a href="#/classes/${classId}/sessions/${s.id}" class="btn btn-ghost btn-sm">Mở bài</a>
                            ${
                              isManager && s.requires_submission
                                ? `<a href="#/classes/${classId}/sessions/${s.id}/submissions" class="btn btn-secondary btn-sm">Chấm bài</a>`
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
          </div>`
    }
  `;
}

// S07: Members Tab (MEM-01..MEM-05)
async function renderClassMembersTab(classId, container) {
  const data = await apiFetch(`/api/classes/${classId}/members`);
  const members = data.members || [];
  const totalReq = data.total_required_sessions || 0;

  container.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
      <h2 style="margin:0;font-size:18px;">${t('tab_members')} (${members.length})</h2>
      <button type="button" class="btn btn-primary btn-sm" id="btn-add-members">${t('mem_add_btn')}</button>
    </div>

    ${
      members.length === 0
        ? `<div class="empty-state">${t('mem_empty')}</div>`
        : `<div class="table-wrap">
            <table class="data-table">
              <thead>
                <tr>
                  <th>${t('usr_col_fullname')}</th>
                  <th>${t('usr_col_username')}</th>
                  <th>${t('usr_col_email')}</th>
                  <th>${t('mem_col_progress')}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                ${members
                  .map(
                    (m) => `
                  <tr>
                    <td><strong>${escapeHtml(m.full_name)}</strong></td>
                    <td><code>${escapeHtml(m.username)}</code></td>
                    <td>${escapeHtml(m.email)}</td>
                    <td><span class="badge">${m.submitted_count} / ${totalReq} bài</span></td>
                    <td style="text-align:right;">
                      <button type="button" class="btn btn-danger btn-sm btn-remove-member" data-id="${m.id}" data-name="${escapeHtml(m.full_name)}">
                        ${t('mem_remove')}
                      </button>
                    </td>
                  </tr>
                `
                  )
                  .join('')}
              </tbody>
            </table>
          </div>`
    }
  `;

  container.querySelectorAll('.btn-remove-member').forEach((btn) => {
    btn.addEventListener('click', () => {
      const sid = Number(btn.dataset.id);
      const sname = btn.dataset.name;
      openModal({
        title: t('mem_remove'),
        bodyHtml: `
          <p>
            Xóa học sinh <strong>${escapeHtml(sname)}</strong> khỏi lớp?<br/>
            <span style="font-size:13px;color:var(--text-muted);">
              Lưu ý (MEM-03): Học sinh sẽ mất quyền truy cập lớp, nhưng bài nộp và điểm cũ vẫn được lưu giữ và hiển thị lại nếu học sinh được thêm vào lại.
            </span>
          </p>
          <div class="modal-footer">
            <button type="button" class="btn btn-ghost" id="rm-cancel">${t('btn_cancel')}</button>
            <button type="button" class="btn btn-danger" id="rm-ok">${t('mem_remove')}</button>
          </div>
        `,
        onMount: (close) => {
          document.getElementById('rm-cancel')?.addEventListener('click', close);
          document.getElementById('rm-ok')?.addEventListener('click', async () => {
            await apiFetch(`/api/classes/${classId}/members/${sid}`, { method: 'DELETE' });
            close();
            showToast('Đã xóa học sinh khỏi lớp.');
            renderClassMembersTab(classId, container);
          });
        }
      });
    });
  });

  // Add multiple students modal (MEM-01)
  document.getElementById('btn-add-members')?.addEventListener('click', async () => {
    const loadAvailable = async (q = '') => {
      const res = await apiFetch(`/api/classes/${classId}/available-students?q=${encodeURIComponent(q)}`);
      return res.students || [];
    };

    const initialStudents = await loadAvailable('');
    openModal({
      title: t('mem_add_btn'),
      bodyHtml: `
        <p style="font-size:13.5px;color:var(--text-muted);margin-top:0;">${t('mem_select_hint')}</p>
        <div class="form-group">
          <input type="text" id="av-search" class="form-input" placeholder="${t('mem_search_student')}" />
        </div>
        <div id="av-list" style="max-height:260px;overflow-y:auto;border:1px solid var(--border-color);border-radius:var(--radius-sm);padding:8px;"></div>
        <div class="modal-footer">
          <button type="button" class="btn btn-ghost" id="av-cancel">${t('btn_cancel')}</button>
          <button type="button" class="btn btn-primary" id="av-add">${t('btn_confirm')}</button>
        </div>
      `,
      onMount: (close) => {
        const selected = new Set();
        const renderList = (students) => {
          const listEl = document.getElementById('av-list');
          if (students.length === 0) {
            listEl.innerHTML = `<div style="padding:16px;text-align:center;color:var(--text-muted);">Không tìm thấy học sinh phù hợp.</div>`;
            return;
          }
          listEl.innerHTML = students
            .map(
              (s) => `
            <label style="display:flex;align-items:center;gap:10px;padding:7px 8px;border-bottom:1px solid var(--border-color);cursor:pointer;">
              <input type="checkbox" class="av-chk" value="${s.id}" ${selected.has(s.id) ? 'checked' : ''} />
              <span><strong>${escapeHtml(s.full_name)}</strong> (<code>${escapeHtml(s.username)}</code> · ${escapeHtml(s.email)})</span>
            </label>
          `
            )
            .join('');
          listEl.querySelectorAll('.av-chk').forEach((chk) => {
            chk.addEventListener('change', () => {
              const id = Number(chk.value);
              if (chk.checked) selected.add(id);
              else selected.delete(id);
            });
          });
        };

        renderList(initialStudents);

        document.getElementById('av-search')?.addEventListener('input', async (e) => {
          const list = await loadAvailable(e.target.value.trim());
          renderList(list);
        });

        document.getElementById('av-cancel')?.addEventListener('click', close);
        document.getElementById('av-add')?.addEventListener('click', async () => {
          if (selected.size === 0) {
            showToast('Vui lòng chọn ít nhất 1 học sinh.', true);
            return;
          }
          const res = await apiFetch(`/api/classes/${classId}/members`, {
            method: 'POST',
            body: { studentIds: Array.from(selected) }
          });
          close();
          showToast(`Đã thêm ${res.addedCount} học sinh vào lớp.`);
          renderClassDetailScreen(classId, 'members');
        });
      }
    });
  });
}

// S08: Gradebook Tab (GRD-08, GRD-09)
async function renderClassGradebookTab(classId, container) {
  const data = await apiFetch(`/api/classes/${classId}/gradebook`);

  if (data.mode === 'student') {
    const items = data.items || [];
    container.innerHTML = `
      <h2 style="font-size:18px;margin-bottom:16px;">${t('grd_personal_title')}</h2>
      ${
        items.length === 0
          ? `<div class="empty-state">${t('grd_empty_sessions')}</div>`
          : `<div class="table-wrap">
              <table class="data-table">
                <thead>
                  <tr>
                    <th>Buổi học</th>
                    <th>Ngày học</th>
                    <th>Thời gian nộp</th>
                    <th>Điểm số</th>
                    <th>Nhận xét của Giáo viên</th>
                  </tr>
                </thead>
                <tbody>
                  ${items
                    .map(
                      (it) => `
                    <tr>
                      <td><a href="#/classes/${classId}/sessions/${it.session_id}"><strong>${escapeHtml(it.title)}</strong></a></td>
                      <td>${formatDateOnly(it.session_date)}</td>
                      <td>
                        ${
                          it.submitted_at
                            ? `${formatDateTime(it.submitted_at)} ${it.is_late ? `<span class="badge badge-late">${t('sub_late')}</span>` : ''}`
                            : `<span class="badge badge-muted">${t('sub_not_submitted')}</span>`
                        }
                      </td>
                      <td>
                        ${
                          it.score !== null && it.score !== undefined
                            ? `<span class="badge badge-graded">${it.score} / 10</span>`
                            : '—'
                        }
                      </td>
                      <td>${escapeHtml(it.feedback || '—')}</td>
                    </tr>
                  `
                    )
                    .join('')}
                </tbody>
              </table>
            </div>`
      }
    `;
    return;
  }

  // Teacher / Admin matrix view
  const sessions = data.sessions || [];
  const rows = data.rows || [];

  container.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
      <h2 style="margin:0;font-size:18px;">${t('tab_gradebook')}</h2>
      <a href="/api/classes/${classId}/gradebook?format=csv" class="btn btn-secondary btn-sm" download>
        ${t('grd_export_csv')}
      </a>
    </div>

    ${
      sessions.length === 0
        ? `<div class="empty-state">${t('grd_empty_sessions')}</div>`
        : `<div class="table-wrap">
            <table class="data-table">
              <thead>
                <tr>
                  <th>${t('usr_col_fullname')}</th>
                  <th>Username</th>
                  ${sessions
                    .map(
                      (s) =>
                        `<th><a href="#/classes/${classId}/sessions/${s.id}/submissions">${escapeHtml(s.title)}</a><br/><span style="font-weight:400;font-size:11.5px;color:var(--text-muted);">${formatDateOnly(s.session_date)}</span></th>`
                    )
                    .join('')}
                  <th>${t('grd_average')}</th>
                </tr>
              </thead>
              <tbody>
                ${rows
                  .map(
                    (r) => `
                  <tr>
                    <td><strong>${escapeHtml(r.student.full_name)}</strong></td>
                    <td><code>${escapeHtml(r.student.username)}</code></td>
                    ${sessions
                      .map((s) => {
                        const c = r.cells[s.id];
                        if (!c) return `<td style="color:var(--text-muted);">—</td>`;
                        if (c.score !== null && c.score !== undefined) {
                          return `<td><span class="badge badge-graded">${c.score}</span> ${c.is_late ? `<span class="badge badge-late" title="Trễ hạn">Trễ</span>` : ''}</td>`;
                        }
                        return `<td><span class="badge ${c.is_late ? 'badge-late' : ''}">${c.is_late ? t('sub_late') : t('sub_submitted')}</span></td>`;
                      })
                      .join('')}
                    <td><strong>${r.average !== null ? r.average : '—'}</strong></td>
                  </tr>
                `
                  )
                  .join('')}
              </tbody>
            </table>
          </div>`
    }
  `;
}

// =========================================================================
// S09: CREATE / EDIT SESSION SCREEN (SES-01..SES-04, SES-07, UC-03)
// =========================================================================
async function renderSessionEditorScreen(classId, sessionId = null) {
  const app = document.getElementById('app-root');
  if (state.user?.role === 'student') {
    app.innerHTML = `<div class="alert alert-error">403 Forbidden</div>`;
    return;
  }

  let existingSession = null;
  let existingAttachments = [];
  if (sessionId) {
    const data = await apiFetch(`/api/sessions/${sessionId}`);
    existingSession = data.session;
    existingAttachments = data.attachments || [];
  }

  const draftKey = `miniclass_draft_${classId}_${sessionId || 'new'}`;
  const savedDraft = !sessionId ? localStorage.getItem(draftKey) : null;
  let initialDraft = null;
  if (savedDraft) {
    try {
      initialDraft = JSON.parse(savedDraft);
    } catch {}
  }

  const todayStr = new Date().toISOString().slice(0, 10);
  const titleVal = existingSession?.title || initialDraft?.title || '';
  const dateVal = existingSession?.session_date || initialDraft?.session_date || todayStr;
  const contentVal = existingSession?.content_md || initialDraft?.content_md || '';
  const reqSubVal = existingSession ? Boolean(existingSession.requires_submission) : Boolean(initialDraft?.requires_submission ?? true);
  const deadlineLocalVal = existingSession?.deadline
    ? new Date(new Date(existingSession.deadline).getTime() - new Date().getTimezoneOffset() * 60000)
        .toISOString()
        .slice(0, 16)
    : '';

  app.innerHTML = `
    <div style="margin-bottom:12px;">
      <a href="#/classes/${classId}" class="btn btn-ghost btn-sm">${t('btn_back')}</a>
    </div>

    <div class="page-header">
      <h1 class="page-title">${sessionId ? t('ses_edit_btn') : t('ses_create_btn')}</h1>
      <span id="autosave-indicator" style="font-size:12.5px;color:var(--text-muted);"></span>
    </div>

    <div id="ses-editor-err"></div>

    <div class="card">
      <div style="display:grid;grid-template-columns:2fr 1fr;gap:16px;">
        <div class="form-group">
          <label class="form-label" for="ses-title">${t('ses_title_label')}</label>
          <input type="text" id="ses-title" class="form-input" value="${escapeHtml(titleVal)}" required placeholder="VD: Buổi 01: Giới thiệu thuật toán..." />
        </div>
        <div class="form-group">
          <label class="form-label" for="ses-date">${t('ses_date_label')}</label>
          <input type="date" id="ses-date" class="form-input" value="${escapeHtml(dateVal)}" required />
        </div>
      </div>

      <div style="display:flex;align-items:center;gap:24px;flex-wrap:wrap;margin-bottom:16px;padding:12px;background:var(--bg-subtle);border-radius:var(--radius-sm);">
        <label style="display:flex;align-items:center;gap:8px;font-weight:600;cursor:pointer;">
          <input type="checkbox" id="ses-req-sub" ${reqSubVal ? 'checked' : ''} />
          <span>${t('ses_req_sub_label')}</span>
        </label>
        <div id="ses-deadline-wrap" style="display:${reqSubVal ? 'flex' : 'none'};align-items:center;gap:10px;flex-wrap:wrap;">
          <label class="form-label" for="ses-deadline" style="margin:0;">${t('ses_deadline_label')}:</label>
          <input type="datetime-local" id="ses-deadline" class="form-input" style="width:auto;" value="${escapeHtml(deadlineLocalVal)}" />
          <span id="ses-deadline-warn" style="font-size:12.5px;color:var(--status-error-text);display:none;">${t('ses_past_deadline_warn')}</span>
        </div>
      </div>

      <div class="form-group">
        <label class="form-label">${t('ses_content_label')}</label>
        <div class="md-editor-shell">
          <div class="md-toolbar">
            <div class="md-toolbar-btns">
              <button type="button" class="md-tool-btn" data-md="bold" title="Bold">B</button>
              <button type="button" class="md-tool-btn" data-md="italic" title="Italic">I</button>
              <button type="button" class="md-tool-btn" data-md="h2" title="Heading">H2</button>
              <button type="button" class="md-tool-btn" data-md="ul" title="List">List</button>
              <button type="button" class="md-tool-btn" data-md="link" title="Link">Link</button>
              <button type="button" class="md-tool-btn" data-md="table" title="Table">Table</button>
              <button type="button" class="md-tool-btn" data-md="code" title="Code Block">Code</button>
              <button type="button" class="md-tool-btn" id="btn-md-image">${t('ses_insert_image')}</button>
              <input type="file" id="md-image-input" accept=".jpg,.jpeg,.png,.gif,.webp" style="display:none;" />
            </div>

            <div class="md-mobile-tabs">
              <button type="button" class="md-tool-btn active" data-pane="write">${t('ses_tab_write')}</button>
              <button type="button" class="md-tool-btn" data-pane="preview">${t('ses_tab_preview')}</button>
            </div>
          </div>

          <div class="md-split-pane" id="md-split-pane" data-mobile-tab="write">
            <div class="md-pane-write">
              <textarea id="ses-md-input" class="md-textarea" placeholder="Nhập nội dung bài giảng bằng Markdown... Hỗ trợ kéo-thả hoặc dán (Ctrl+V) ảnh trực tiếp!">${escapeHtml(contentVal)}</textarea>
            </div>
            <div class="md-pane-preview lecture-reader" id="ses-md-preview"></div>
          </div>
        </div>
      </div>

      <div class="form-group">
        <label class="form-label">${t('ses_attachments_label')}</label>
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
          <input type="file" id="ses-att-input" multiple style="display:none;" />
          <button type="button" class="btn btn-ghost btn-sm" id="btn-Trigger-att">${t('ses_add_attachment')}</button>
        </div>
        <div id="ses-att-list" style="display:flex;flex-direction:column;gap:6px;"></div>
      </div>

      <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:20px;padding-top:16px;border-top:1px solid var(--border-color);">
        <a href="#/classes/${classId}" class="btn btn-ghost">${t('btn_cancel')}</a>
        <button type="button" class="btn btn-secondary" id="btn-save-draft">${t('ses_save_draft')}</button>
        <button type="button" class="btn btn-primary" id="btn-publish-ses">${t('ses_publish')}</button>
      </div>
    </div>
  `;

  const mdInput = document.getElementById('ses-md-input');
  const mdPreview = document.getElementById('ses-md-preview');
  const updatePreview = () => {
    mdPreview.innerHTML = renderMarkdown(mdInput.value);
  };
  updatePreview();
  mdInput.addEventListener('input', updatePreview);

  // Mobile tab switching (UI-04)
  app.querySelectorAll('.md-mobile-tabs .md-tool-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      app.querySelectorAll('.md-mobile-tabs .md-tool-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('md-split-pane').setAttribute('data-mobile-tab', btn.dataset.pane);
    });
  });

  // Require submission checkbox toggle & past deadline warning (UC-03)
  const reqChk = document.getElementById('ses-req-sub');
  const dlWrap = document.getElementById('ses-deadline-wrap');
  const dlInput = document.getElementById('ses-deadline');
  const dlWarn = document.getElementById('ses-deadline-warn');

  reqChk.addEventListener('change', () => {
    dlWrap.style.display = reqChk.checked ? 'flex' : 'none';
  });
  dlInput.addEventListener('change', () => {
    if (dlInput.value && new Date(dlInput.value) < new Date()) {
      dlWarn.style.display = 'inline';
    } else {
      dlWarn.style.display = 'none';
    }
  });

  // Markdown Toolbar insertion helpers (SES-02)
  const insertAtCursor = (prefix, suffix = '', sample = '') => {
    const start = mdInput.selectionStart || 0;
    const end = mdInput.selectionEnd || 0;
    const selected = mdInput.value.slice(start, end) || sample;
    const replacement = `${prefix}${selected}${suffix}`;
    mdInput.value = mdInput.value.slice(0, start) + replacement + mdInput.value.slice(end);
    mdInput.focus();
    updatePreview();
  };

  app.querySelectorAll('[data-md]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const cmd = btn.dataset.md;
      if (cmd === 'bold') insertAtCursor('**', '**', 'chữ đậm');
      else if (cmd === 'italic') insertAtCursor('*', '*', 'chữ nghiêng');
      else if (cmd === 'h2') insertAtCursor('\n## ', '\n', 'Tiêu đề mục');
      else if (cmd === 'ul') insertAtCursor('\n- ', '\n', 'Mục danh sách');
      else if (cmd === 'link') insertAtCursor('[', '](https://example.com)', 'Tên liên kết');
      else if (cmd === 'table')
        insertAtCursor(
          '\n| Cột 1 | Cột 2 |\n| :--- | :--- |\n| Giá trị 1 | Giá trị 2 |\n',
          '',
          ''
        );
      else if (cmd === 'code') insertAtCursor('\n```python\n', '\n```\n', 'print("Hello MiniClass")');
    });
  });

  // Image upload helper (button, paste, drag-drop) (SES-03)
  const uploadAndInsertImage = async (file) => {
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      showToast('Ảnh vượt quá giới hạn 5 MB (SES-03).', true);
      return;
    }
    try {
      const dataBase64 = await readFileAsBase64(file);
      const res = await apiFetch('/api/uploads/image', {
        method: 'POST',
        body: {
          classId,
          fileName: file.name,
          mimeType: file.type,
          dataBase64
        }
      });
      insertAtCursor(`\n${res.markdown}\n`, '', '');
      showToast('Đã tải ảnh lên và chèn vào bài giảng.');
    } catch (err) {
      showToast(err.message, true);
    }
  };

  document.getElementById('btn-md-image')?.addEventListener('click', () => {
    document.getElementById('md-image-input')?.click();
  });
  document.getElementById('md-image-input')?.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) uploadAndInsertImage(file);
  });

  mdInput.addEventListener('paste', (e) => {
    const items = e.clipboardData?.items || [];
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        uploadAndInsertImage(item.getAsFile());
        break;
      }
    }
  });

  mdInput.addEventListener('dragover', (e) => e.preventDefault());
  mdInput.addEventListener('drop', (e) => {
    const file = e.dataTransfer?.files?.[0];
    if (file && file.type.startsWith('image/')) {
      e.preventDefault();
      uploadAndInsertImage(file);
    }
  });

  // Pending attachments management (SES-04)
  const pendingFiles = [];
  const attListEl = document.getElementById('ses-att-list');

  const renderAttachmentsList = () => {
    const existingHtml = existingAttachments
      .map(
        (a) => `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:6px 10px;border:1px solid var(--border-color);border-radius:var(--radius-sm);">
        <span>${escapeHtml(a.original_name)} (${formatBytes(a.size_bytes)})</span>
        <button type="button" class="btn btn-danger btn-sm btn-del-existing-att" data-id="${a.id}">Xóa</button>
      </div>
    `
      )
      .join('');

    const pendingHtml = pendingFiles
      .map(
        (f, idx) => `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:6px 10px;border:1px dashed var(--text-main);border-radius:var(--radius-sm);">
        <span>[Mới] ${escapeHtml(f.name)} (${formatBytes(f.size)})</span>
        <button type="button" class="btn btn-ghost btn-sm btn-del-pending-att" data-idx="${idx}">Bỏ chọn</button>
      </div>
    `
      )
      .join('');

    attListEl.innerHTML = existingHtml + pendingHtml;

    attListEl.querySelectorAll('.btn-del-existing-att').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const aid = Number(btn.dataset.id);
        await apiFetch(`/api/attachments/${aid}`, { method: 'DELETE' });
        existingAttachments = existingAttachments.filter((x) => x.id !== aid);
        renderAttachmentsList();
      });
    });

    attListEl.querySelectorAll('.btn-del-pending-att').forEach((btn) => {
      btn.addEventListener('click', () => {
        pendingFiles.splice(Number(btn.dataset.idx), 1);
        renderAttachmentsList();
      });
    });
  };
  renderAttachmentsList();

  document.getElementById('btn-Trigger-att')?.addEventListener('click', () => {
    document.getElementById('ses-att-input')?.click();
  });
  document.getElementById('ses-att-input')?.addEventListener('change', (e) => {
    const files = Array.from(e.target.files || []);
    for (const f of files) {
      if (existingAttachments.length + pendingFiles.length >= 10) {
        showToast('Tối đa 10 file đính kèm cho mỗi buổi học (SES-04).', true);
        break;
      }
      if (f.size > 20 * 1024 * 1024) {
        showToast(`File "${f.name}" vượt quá giới hạn 20 MB.`, true);
        continue;
      }
      pendingFiles.push(f);
    }
    renderAttachmentsList();
  });

  // Auto-save draft every 30 seconds (UC-03)
  if (state.autoSaveTimer) clearInterval(state.autoSaveTimer);
  state.autoSaveTimer = setInterval(() => {
    const currentTitle = document.getElementById('ses-title')?.value || '';
    const currentMd = document.getElementById('ses-md-input')?.value || '';
    if (!currentTitle && !currentMd) return;
    localStorage.setItem(
      draftKey,
      JSON.stringify({
        title: currentTitle,
        session_date: document.getElementById('ses-date')?.value || todayStr,
        content_md: currentMd,
        requires_submission: document.getElementById('ses-req-sub')?.checked
      })
    );
    const ind = document.getElementById('autosave-indicator');
    if (ind) ind.textContent = `${t('ses_autosaved')} (${new Date().toLocaleTimeString()})`;
  }, 30_000);

  const saveSession = async (status) => {
    const errBox = document.getElementById('ses-editor-err');
    errBox.innerHTML = '';

    const title = document.getElementById('ses-title').value.trim();
    const session_date = document.getElementById('ses-date').value.trim();
    const content_md = document.getElementById('ses-md-input').value.trim();
    const requires_submission = document.getElementById('ses-req-sub').checked;
    const rawDl = document.getElementById('ses-deadline').value;
    const deadline = requires_submission && rawDl ? new Date(rawDl).toISOString() : null;

    try {
      let targetSessionId = sessionId;
      if (sessionId) {
        await apiFetch(`/api/sessions/${sessionId}`, {
          method: 'PUT',
          body: { title, session_date, content_md, requires_submission, deadline, status }
        });
      } else {
        const res = await apiFetch(`/api/classes/${classId}/sessions`, {
          method: 'POST',
          body: { title, session_date, content_md, requires_submission, deadline, status }
        });
        targetSessionId = res.sessionId;
      }

      // Upload pending attachments
      for (const file of pendingFiles) {
        const dataBase64 = await readFileAsBase64(file);
        await apiFetch(`/api/sessions/${targetSessionId}/attachments`, {
          method: 'POST',
          body: {
            fileName: file.name,
            mimeType: file.type,
            dataBase64
          }
        });
      }

      localStorage.removeItem(draftKey);
      if (state.autoSaveTimer) clearInterval(state.autoSaveTimer);
      showToast(status === 'draft' ? 'Đã lưu bản nháp buổi học.' : 'Đã công bố buổi học.');
      window.location.hash = `#/classes/${classId}/sessions/${targetSessionId}`;
    } catch (err) {
      errBox.innerHTML = `<div class="alert alert-error">${escapeHtml(err.message)}</div>`;
    }
  };

  document.getElementById('btn-save-draft')?.addEventListener('click', () => saveSession('draft'));
  document.getElementById('btn-publish-ses')?.addEventListener('click', () => saveSession('published'));
}

// =========================================================================
// S10: SESSION DETAIL & STUDENT SUBMISSION (SES-05..SES-08, SUB-01..SUB-10, UC-05)
// =========================================================================
async function renderSessionDetailScreen(classId, sessionId) {
  const app = document.getElementById('app-root');
  app.innerHTML = `<div class="empty-state">${t('loading')}</div>`;

  try {
    const data = await apiFetch(`/api/sessions/${sessionId}`);
    const { session, class: cls, attachments, mySubmission, submissionCount } = data;
    const isManager = state.user.role === 'admin' || (state.user.role === 'teacher' && cls.teacher_id === state.user.id);

    app.innerHTML = `
      <div style="margin-bottom:12px;">
        <a href="#/classes/${classId}" class="btn btn-ghost btn-sm">${escapeHtml(cls.name)}</a>
      </div>

      <div class="page-header">
        <div>
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
            <h1 class="page-title">${escapeHtml(session.title)}</h1>
            ${session.status === 'draft' ? `<span class="badge badge-muted">${t('status_draft')}</span>` : ''}
          </div>
          <p class="page-subtitle">
            Ngày học: ${formatDateOnly(session.session_date)}
            ${
              session.requires_submission
                ? ` · Deadline: ${session.deadline ? formatDateTime(session.deadline) : 'Không giới hạn'}`
                : ` · ${t('sub_no_requirement')}`
            }
          </p>
        </div>

        ${
          isManager
            ? `<div style="display:flex;gap:8px;flex-wrap:wrap;">
                ${
                  session.requires_submission
                    ? `<a href="#/classes/${classId}/sessions/${sessionId}/submissions" class="btn btn-primary btn-sm">
                        ${t('ses_view_submissions')} (${submissionCount})
                       </a>`
                    : ''
                }
                <a href="#/classes/${classId}/sessions/${sessionId}/edit" class="btn btn-secondary btn-sm">${t('ses_edit_btn')}</a>
                <button type="button" class="btn btn-danger btn-sm" id="btn-delete-ses">${t('ses_delete_btn')}</button>
              </div>`
            : ''
        }
      </div>

      <div class="card">
        <article class="lecture-reader" id="session-lecture-content">
          ${renderMarkdown(session.content_md)}
        </article>

        ${
          attachments.length > 0
            ? `
          <div style="margin-top:28px;padding-top:16px;border-top:1px solid var(--border-color);">
            <h3 style="font-size:15px;margin:0 0 10px;">Tài liệu đính kèm (${attachments.length})</h3>
            <div style="display:flex;flex-wrap:wrap;gap:8px;">
              ${attachments
                .map(
                  (a) => `
                <a href="/api/attachments/${a.id}/download" class="btn btn-ghost btn-sm" download>
                  ${escapeHtml(a.original_name)} (${formatBytes(a.size_bytes)})
                </a>
              `
                )
                .join('')}
            </div>
          </div>
        `
            : ''
        }
      </div>

      <div id="student-submission-section"></div>
    `;

    // Delete session with warning on exact number of submissions (SES-08)
    document.getElementById('btn-delete-ses')?.addEventListener('click', () => {
      openModal({
        title: t('ses_delete_btn'),
        bodyHtml: `
          <div class="alert alert-error">
            Cảnh báo (SES-08): Xóa buổi học <strong>${escapeHtml(session.title)}</strong> sẽ xóa vĩnh viễn <strong>${submissionCount} bài nộp</strong> của học sinh cùng các tài liệu đính kèm!
          </div>
          <p>Bạn có chắc chắn muốn xóa buổi học này?</p>
          <div class="modal-footer">
            <button type="button" class="btn btn-ghost" id="ds-cancel">${t('btn_cancel')}</button>
            <button type="button" class="btn btn-danger" id="ds-ok">${t('ses_delete_btn')}</button>
          </div>
        `,
        onMount: (close) => {
          document.getElementById('ds-cancel')?.addEventListener('click', close);
          document.getElementById('ds-ok')?.addEventListener('click', async () => {
            await apiFetch(`/api/sessions/${sessionId}`, { method: 'DELETE' });
            close();
            showToast('Đã xóa buổi học.');
            window.location.hash = `#/classes/${classId}`;
          });
        }
      });
    });

    // Student submission box (SUB-01..SUB-10, UC-05)
    if (state.user.role === 'student' && session.requires_submission) {
      renderStudentSubmissionBox(cls, session, mySubmission);
    }
  } catch (err) {
    app.innerHTML = `<div class="alert alert-error">${escapeHtml(err.message)}</div>`;
  }
}

function renderStudentSubmissionBox(cls, session, mySubmission) {
  const container = document.getElementById('student-submission-section');
  if (!container) return;

  const isGraded = mySubmission && (mySubmission.score !== null || mySubmission.graded_at !== null);
  const isLockedByGrade = isGraded && !mySubmission.allow_resubmit;
  const isClassArchived = cls.status === 'archived';
  const canUpload = !isLockedByGrade && !isClassArchived;

  const allowedExts = state.settings?.allowed_submission_extensions || [];
  const maxMB = state.settings?.max_submission_size_mb || 10;

  let statusBadgeHtml = `<span class="badge badge-muted">${t('sub_not_submitted')}</span>`;
  if (mySubmission) {
    if (mySubmission.needs_regrade) {
      statusBadgeHtml = `<span class="badge">${t('sub_needs_regrade')}</span>`;
    } else if (isGraded) {
      statusBadgeHtml = `<span class="badge badge-graded">${t('sub_graded')}</span>`;
    } else if (mySubmission.is_late) {
      statusBadgeHtml = `<span class="badge badge-late">${t('sub_late')}</span>`;
    } else {
      statusBadgeHtml = `<span class="badge">${t('sub_submitted')}</span>`;
    }
  }

  container.innerHTML = `
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;flex-wrap:wrap;gap:8px;">
        <h2 style="margin:0;font-size:18px;">${t('sub_box_title')}</h2>
        <div>${statusBadgeHtml}</div>
      </div>

      ${
        mySubmission
          ? `
        <div style="padding:14px;background:var(--bg-subtle);border:1px solid var(--border-color);border-radius:var(--radius-sm);margin-bottom:16px;">
          <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;">
            <div>
              <div><strong>${t('sub_current_file')}:</strong> <code>${escapeHtml(mySubmission.original_name)}</code> (${formatBytes(mySubmission.size_bytes)})</div>
              <div style="font-size:13px;color:var(--text-muted);margin-top:4px;">
                ${t('sub_submitted_at')}: ${formatDateTime(mySubmission.submitted_at)}
                ${mySubmission.is_late ? ` · <span class="badge badge-late">${t('sub_late')}</span>` : ''}
              </div>
              ${mySubmission.note ? `<div style="font-size:13.5px;margin-top:6px;"><em>Ghi chú: "${escapeHtml(mySubmission.note)}"</em></div>` : ''}
            </div>
            <a href="/api/submissions/${mySubmission.id}/download" class="btn btn-secondary btn-sm" download>
              ${t('sub_download_mine')}
            </a>
          </div>

          ${
            isGraded
              ? `
            <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border-color);">
              <div style="font-size:15px;">
                ${t('sub_score_label')}: <span class="badge badge-graded" style="font-size:14px;">${mySubmission.score !== null ? `${mySubmission.score} / 10` : 'Đã nhận xét'}</span>
                ${mySubmission.needs_regrade ? `<span class="badge" style="margin-left:6px;">${t('sub_needs_regrade')}</span>` : ''}
              </div>
              ${
                mySubmission.feedback
                  ? `<div style="margin-top:8px;">${t('sub_teacher_feedback')}:<br/><div style="white-space:pre-wrap;margin-top:4px;">${escapeHtml(mySubmission.feedback)}</div></div>`
                  : ''
              }
            </div>
          `
              : ''
          }
        </div>
      `
          : ''
      }

      ${isLockedByGrade ? `<div class="alert">${t('sub_locked_graded_msg')}</div>` : ''}
      ${isClassArchived ? `<div class="alert">${t('cls_archived_banner')}</div>` : ''}

      ${
        canUpload
          ? `
        <div id="sub-upload-err"></div>
        <div class="dropzone" id="sub-dropzone">
          <div style="margin-bottom:4px;">${t('sub_drop_hint')}</div>
          <div style="font-size:12.5px;color:var(--text-muted);">
            Tối đa 1 file ≤ ${maxMB} MB · Định dạng: ${allowedExts.join(', ')}
          </div>
          <div id="sub-selected-file" style="margin-top:10px;"></div>
          <input type="file" id="sub-file-input" style="display:none;" />
        </div>

        <div id="sub-progress-container" style="display:none;">
          <div class="progress-bar-wrap"><div class="progress-bar-fill" id="sub-progress-fill"></div></div>
        </div>

        <div class="form-group" style="margin-top:12px;">
          <label class="form-label" for="sub-note">${t('sub_note_label')}</label>
          <textarea id="sub-note" class="form-textarea" rows="2" maxlength="500" placeholder="Ghi chú kèm bài nộp...">${escapeHtml(mySubmission?.note || '')}</textarea>
        </div>

        <button type="button" class="btn btn-primary" id="btn-do-submit">
          ${mySubmission ? t('sub_resubmit_btn') : t('sub_submit_btn')}
        </button>
      `
          : ''
      }
    </div>
  `;

  if (!canUpload) return;

  let chosenFile = null;
  const dropzone = document.getElementById('sub-dropzone');
  const fileInput = document.getElementById('sub-file-input');
  const selectedLabel = document.getElementById('sub-selected-file');
  const errBox = document.getElementById('sub-upload-err');

  // SUB-03: Client-side validation before upload
  const validateAndSelectFile = (file) => {
    errBox.innerHTML = '';
    if (!file) return;
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if (!allowedExts.includes(ext)) {
      chosenFile = null;
      selectedLabel.textContent = '';
      errBox.innerHTML = `<div class="alert alert-error">Định dạng file ".${escapeHtml(ext)}" không được phép nộp. Chỉ hỗ trợ: ${escapeHtml(allowedExts.join(', '))} (SUB-02).</div>`;
      return;
    }
    if (file.size > maxMB * 1024 * 1024) {
      chosenFile = null;
      selectedLabel.textContent = '';
      errBox.innerHTML = `<div class="alert alert-error">Dung lượng file (${formatBytes(file.size)}) vượt quá giới hạn tối đa ${maxMB} MB (SUB-01).</div>`;
      return;
    }
    chosenFile = file;
    selectedLabel.textContent = `Đã chọn: ${file.name} (${formatBytes(file.size)})`;
  };

  dropzone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => validateAndSelectFile(e.target.files?.[0]));
  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    if (e.dataTransfer?.files?.length > 1) {
      errBox.innerHTML = `<div class="alert alert-error">Chỉ được nộp 1 file cho mỗi lần nộp (SUB-01).</div>`;
      return;
    }
    validateAndSelectFile(e.dataTransfer?.files?.[0]);
  });

  const executeUpload = async () => {
    const progWrap = document.getElementById('sub-progress-container');
    const progFill = document.getElementById('sub-progress-fill');
    const submitBtn = document.getElementById('btn-do-submit');
    try {
      submitBtn.disabled = true;
      progWrap.style.display = 'block';
      progFill.style.width = '15%';

      const dataBase64 = await readFileAsBase64(chosenFile, (pct) => {
        progFill.style.width = `${pct}%`;
      });

      progFill.style.width = '90%';
      await apiFetch(`/api/sessions/${session.id}/submit`, {
        method: 'POST',
        body: {
          fileName: chosenFile.name,
          mimeType: chosenFile.type,
          note: document.getElementById('sub-note').value.trim(),
          dataBase64
        }
      });
      progFill.style.width = '100%';
      showToast('Nộp bài thành công!');
      renderSessionDetailScreen(cls.id, session.id);
    } catch (err) {
      submitBtn.disabled = false;
      progWrap.style.display = 'none';
      errBox.innerHTML = `<div class="alert alert-error">${escapeHtml(err.message)}</div>`;
    }
  };

  document.getElementById('btn-do-submit')?.addEventListener('click', () => {
    if (!chosenFile) {
      errBox.innerHTML = `<div class="alert alert-error">Vui lòng chọn 1 file bài tập trước khi bấm Nộp bài.</div>`;
      return;
    }
    // UC-05 Alternate Flow 2a: Confirm replacing existing submission
    if (mySubmission) {
      openModal({
        title: t('sub_resubmit_btn'),
        bodyHtml: `
          <p>${t('sub_replace_confirm')}</p>
          <div class="modal-footer">
            <button type="button" class="btn btn-ghost" id="rep-cancel">${t('btn_cancel')}</button>
            <button type="button" class="btn btn-primary" id="rep-ok">${t('btn_confirm')}</button>
          </div>
        `,
        onMount: (close) => {
          document.getElementById('rep-cancel')?.addEventListener('click', close);
          document.getElementById('rep-ok')?.addEventListener('click', () => {
            close();
            executeUpload();
          });
        }
      });
    } else {
      executeUpload();
    }
  });
}

// =========================================================================
// S11 & S12: SESSION SUBMISSIONS LIST & GRADING MODAL (GRD-01..GRD-07)
// =========================================================================
async function renderSessionSubmissionsScreen(classId, sessionId) {
  const app = document.getElementById('app-root');
  app.innerHTML = `<div class="empty-state">${t('loading')}</div>`;

  let statusFilter = '';

  const loadList = async () => {
    const params = statusFilter ? `?status=${encodeURIComponent(statusFilter)}` : '';
    const data = await apiFetch(`/api/sessions/${sessionId}/submissions${params}`);
    const { session, class: cls, items } = data;

    app.innerHTML = `
      <div style="margin-bottom:12px;">
        <a href="#/classes/${classId}/sessions/${sessionId}" class="btn btn-ghost btn-sm">${escapeHtml(session.title)}</a>
      </div>

      <div class="page-header">
        <div>
          <h1 class="page-title">${t('grd_list_title')}: ${escapeHtml(session.title)}</h1>
          <p class="page-subtitle">
            Lớp: ${escapeHtml(cls.name)} · Deadline: ${session.deadline ? formatDateTime(session.deadline) : 'Không giới hạn'}
          </p>
        </div>
        <a href="/api/sessions/${sessionId}/submissions-zip" class="btn btn-secondary btn-sm" download>
          ${t('grd_download_zip')}
        </a>
      </div>

      <div class="filter-bar">
        <select id="grd-status-filter" class="form-select" style="max-width:240px;">
          <option value="" ${statusFilter === '' ? 'selected' : ''}>${t('grd_filter_all')}</option>
          <option value="on_time" ${statusFilter === 'on_time' ? 'selected' : ''}>${t('sub_on_time')}</option>
          <option value="late" ${statusFilter === 'late' ? 'selected' : ''}>${t('sub_late')}</option>
          <option value="graded" ${statusFilter === 'graded' ? 'selected' : ''}>${t('sub_graded')}</option>
          <option value="needs_regrade" ${statusFilter === 'needs_regrade' ? 'selected' : ''}>${t('sub_needs_regrade')}</option>
          <option value="not_submitted" ${statusFilter === 'not_submitted' ? 'selected' : ''}>${t('sub_not_submitted')}</option>
        </select>
      </div>

      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>${t('grd_col_student')}</th>
              <th>${t('grd_col_submitted_at')}</th>
              <th>${t('grd_col_file')}</th>
              <th>${t('grd_col_status')}</th>
              <th>${t('grd_col_score')}</th>
              <th>${t('grd_col_action')}</th>
            </tr>
          </thead>
          <tbody>
            ${
              items.length === 0
                ? `<tr><td colspan="6" style="text-align:center;padding:24px;">${t('empty_data')}</td></tr>`
                : items
                    .map((it) => {
                      let badge = `<span class="badge badge-muted">${t('sub_not_submitted')}</span>`;
                      if (it.computed_status === 'graded') badge = `<span class="badge badge-graded">${t('sub_graded')}</span>`;
                      else if (it.computed_status === 'needs_regrade') badge = `<span class="badge">${t('sub_needs_regrade')}</span>`;
                      else if (it.computed_status === 'late') badge = `<span class="badge badge-late">${t('sub_late')}</span>`;
                      else if (it.computed_status === 'on_time') badge = `<span class="badge">${t('sub_on_time')}</span>`;

                      return `
                        <tr>
                          <td>
                            <strong>${escapeHtml(it.full_name)}</strong><br/>
                            <code style="font-size:12px;color:var(--text-muted);">${escapeHtml(it.username)}</code>
                          </td>
                          <td>${it.submitted_at ? formatDateTime(it.submitted_at) : '—'}</td>
                          <td>
                            ${
                              it.submission_id
                                ? `<a href="/api/submissions/${it.submission_id}/download" download>${escapeHtml(it.original_name)}</a>`
                                : '—'
                            }
                          </td>
                          <td>
                            ${badge}
                            ${it.is_late && it.computed_status === 'graded' ? `<span class="badge badge-late">${t('sub_late')}</span>` : ''}
                          </td>
                          <td><strong>${it.score !== null && it.score !== undefined ? `${it.score} / 10` : '—'}</strong></td>
                          <td>
                            ${
                              it.submission_id
                                ? `<button type="button" class="btn btn-primary btn-sm btn-open-grade" data-subid="${it.submission_id}">
                                    ${t('grd_btn_grade')}
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

    document.getElementById('grd-status-filter')?.addEventListener('change', (e) => {
      statusFilter = e.target.value;
      loadList();
    });

    app.querySelectorAll('.btn-open-grade').forEach((btn) => {
      btn.addEventListener('click', () => {
        const subId = Number(btn.dataset.subid);
        const item = items.find((x) => x.submission_id === subId);
        if (item) openGradingModal(item, loadList);
      });
    });
  };

  try {
    await loadList();
  } catch (err) {
    app.innerHTML = `<div class="alert alert-error">${escapeHtml(err.message)}</div>`;
  }
}

// S12: Grading & Safe Preview Modal (GRD-04, GRD-05, GRD-06, SUB-07, AC-11, AC-12, AC-15)
async function openGradingModal(item, onSaved) {
  let previewHtml = `<div class="empty-state">${t('loading')}</div>`;
  try {
    const prev = await apiFetch(`/api/submissions/${item.submission_id}/preview`);
    if (prev.previewType === 'code') {
      previewHtml = `
        <div class="md-code-block" style="max-height:300px;overflow-y:auto;">
          <div class="code-lang-header">${escapeHtml(prev.originalName)} (${escapeHtml(prev.language)}) — Xem văn bản an toàn (Không thực thi mã)</div>
          <pre><code>${highlightCode(prev.content, prev.language)}</code></pre>
        </div>
      `;
    } else if (prev.previewType === 'image') {
      previewHtml = `<div style="text-align:center;"><img src="${escapeHtml(prev.rawUrl)}" alt="${escapeHtml(prev.originalName)}" class="md-image" style="max-height:320px;" /></div>`;
    } else if (prev.previewType === 'pdf') {
      previewHtml = `<iframe src="${escapeHtml(prev.rawUrl)}" style="width:100%;height:340px;border:1px solid var(--border-color);"></iframe>`;
    } else {
      previewHtml = `<div class="empty-state" style="padding:18px;">Định dạng này không hỗ trợ xem trước trực tiếp. Vui lòng tải file về máy để kiểm tra.</div>`;
    }
  } catch {
    previewHtml = `<div class="empty-state" style="padding:18px;">Không thể tải bản xem trước.</div>`;
  }

  openModal({
    title: `${t('grd_modal_title')}: ${item.full_name} (${item.username})`,
    size: 'lg',
    bodyHtml: `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap;gap:8px;">
        <div>
          <strong>File:</strong> <code>${escapeHtml(item.original_name)}</code> (${formatBytes(item.size_bytes)})
          · Nộp lúc: ${formatDateTime(item.submitted_at)}
          ${item.is_late ? `<span class="badge badge-late">${t('sub_late')}</span>` : ''}
        </div>
        <a href="/api/submissions/${item.submission_id}/download" class="btn btn-secondary btn-sm" download>
          ${t('grd_download_file')}
        </a>
      </div>

      ${item.note ? `<div class="alert" style="margin-bottom:12px;">Ghi chú của HS: ${escapeHtml(item.note)}</div>` : ''}

      <div style="margin-bottom:16px;">
        <div class="form-label">${t('grd_preview_title')}</div>
        ${previewHtml}
      </div>

      <div id="grd-err-box"></div>

      <form id="grd-form">
        <div class="form-group">
          <label class="form-label" for="grd-score">${t('grd_score_input')}</label>
          <input type="text" id="grd-score" class="form-input" style="max-width:200px;" value="${item.score !== null && item.score !== undefined ? item.score : ''}" placeholder="VD: 8.5" />
        </div>
        <div class="form-group">
          <label class="form-label" for="grd-feedback">${t('grd_feedback_input')}</label>
          <textarea id="grd-feedback" class="form-textarea" rows="3" maxlength="2000" placeholder="Nhận xét bài làm của học sinh...">${escapeHtml(item.feedback || '')}</textarea>
        </div>

        <div class="modal-footer" style="justify-content:space-between;">
          <div>
            ${
              item.score !== null || item.graded_at
                ? `<button type="button" class="btn btn-secondary btn-sm" id="btn-allow-resubmit">
                    ${t('grd_allow_resubmit_btn')}
                   </button>`
                : ''
            }
          </div>
          <div style="display:flex;gap:8px;">
            <button type="button" class="btn btn-ghost" id="grd-cancel">${t('btn_cancel')}</button>
            <button type="submit" class="btn btn-primary">${t('grd_save_btn')}</button>
          </div>
        </div>
      </form>
    `,
    onMount: (close) => {
      document.getElementById('grd-cancel')?.addEventListener('click', close);

      document.getElementById('btn-allow-resubmit')?.addEventListener('click', async () => {
        try {
          await apiFetch(`/api/submissions/${item.submission_id}/allow-resubmit`, { method: 'POST' });
          close();
          showToast('Đã mở quyền nộp lại cho học sinh.');
          if (onSaved) onSaved();
        } catch (err) {
          document.getElementById('grd-err-box').innerHTML = `<div class="alert alert-error">${escapeHtml(err.message)}</div>`;
        }
      });

      document.getElementById('grd-form')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const errBox = document.getElementById('grd-err-box');
        errBox.innerHTML = '';
        try {
          await apiFetch(`/api/submissions/${item.submission_id}/grade`, {
            method: 'PUT',
            body: {
              score: document.getElementById('grd-score').value.trim(),
              feedback: document.getElementById('grd-feedback').value.trim()
            }
          });
          close();
          showToast('Đã lưu điểm và nhận xét.');
          if (onSaved) onSaved();
        } catch (err) {
          errBox.innerHTML = `<div class="alert alert-error">${escapeHtml(err.message)}</div>`;
        }
      });
    }
  });
}

// =========================================================================
// S13: NOTIFICATIONS SCREEN (NOT-01..NOT-05)
// =========================================================================
async function renderNotificationsScreen() {
  const app = document.getElementById('app-root');
  app.innerHTML = `<div class="empty-state">${t('loading')}</div>`;

  try {
    const data = await apiFetch('/api/notifications');
    const list = data.notifications || [];
    state.unreadNotifications = data.unreadCount || 0;
    renderNavbar();

    app.innerHTML = `
      <div class="page-header">
        <h1 class="page-title">${t('not_title')}</h1>
        ${
          list.length > 0
            ? `<button type="button" class="btn btn-secondary btn-sm" id="btn-read-all">${t('not_mark_all_read')}</button>`
            : ''
        }
      </div>

      ${
        list.length === 0
          ? `<div class="empty-state">${t('not_empty')}</div>`
          : `<div style="display:flex;flex-direction:column;gap:10px;">
              ${list
                .map((n) => {
                  const title = state.lang === 'en' ? n.title_en : n.title_vi;
                  const body = state.lang === 'en' ? n.body_en : n.body_vi;
                  return `
                    <div class="card notif-item" data-id="${n.id}" data-link="${escapeHtml(n.link_url)}" style="margin:0;cursor:pointer;border-left:${n.is_read ? '1px solid var(--border-color)' : '3px solid var(--accent-blue)'};">
                      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;">
                        <div>
                          <div style="font-weight:500;margin-bottom:4px;">
                            ${escapeHtml(title)}
                            ${!n.is_read ? `<span class="badge badge-dark" style="margin-left:6px;">${t('not_unread')}</span>` : ''}
                          </div>
                          <div style="font-size:14px;color:var(--text-muted);">${escapeHtml(body)}</div>
                        </div>
                        <div style="font-size:12px;color:var(--text-muted);white-space:nowrap;">${formatDateTime(n.created_at)}</div>
                      </div>
                    </div>
                  `;
                })
                .join('')}
            </div>`
      }
    `;

    document.getElementById('btn-read-all')?.addEventListener('click', async () => {
      await apiFetch('/api/notifications/read-all', { method: 'POST' });
      state.unreadNotifications = 0;
      renderNotificationsScreen();
    });

    app.querySelectorAll('.notif-item').forEach((el) => {
      el.addEventListener('click', async () => {
        const nid = Number(el.dataset.id);
        const link = el.dataset.link || '#/';
        try {
          await apiFetch(`/api/notifications/${nid}/read`, { method: 'POST' });
          state.unreadNotifications = Math.max(0, state.unreadNotifications - 1);
          renderNavbar();
        } catch {}
        window.location.hash = link;
      });
    });
  } catch (err) {
    app.innerHTML = `<div class="alert alert-error">${escapeHtml(err.message)}</div>`;
  }
}

// =========================================================================
// S14: PERSONAL PROFILE & EMAIL PREFERENCES (AUTH-07, NOT-03, I18N-02)
// =========================================================================
function renderProfileScreen() {
  const app = document.getElementById('app-root');
  const u = state.user;
  const prefs = u.email_prefs || {};

  app.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">${t('prof_title')}</h1>
    </div>

    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:20px;">
      <div class="card">
        <div id="prof-msg"></div>
        <form id="prof-form">
          <div class="form-group">
            <label class="form-label">Username (Chỉ Admin quản lý - AUTH-07)</label>
            <input type="text" class="form-input" value="${escapeHtml(u.username)}" readonly disabled />
          </div>
          <div class="form-group">
            <label class="form-label">Email (Chỉ Admin sửa - AUTH-07)</label>
            <input type="email" class="form-input" value="${escapeHtml(u.email)}" readonly disabled />
          </div>
          <div class="form-group">
            <label class="form-label" for="prof-name">${t('prof_fullname')}</label>
            <input type="text" id="prof-name" class="form-input" value="${escapeHtml(u.full_name)}" required />
          </div>
          <div class="form-group">
            <label class="form-label" for="prof-lang">${t('prof_language')}</label>
            <select id="prof-lang" class="form-select">
              <option value="vi" ${state.lang === 'vi' ? 'selected' : ''}>Tiếng Việt (VI)</option>
              <option value="en" ${state.lang === 'en' ? 'selected' : ''}>English (EN)</option>
            </select>
          </div>

          <div class="form-group" style="margin-top:20px;">
            <label class="form-label">${t('prof_email_prefs')} (NOT-03)</label>
            <div style="display:flex;flex-direction:column;gap:8px;padding:10px;background:var(--bg-subtle);border-radius:var(--radius-sm);">
              <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
                <input type="checkbox" id="ep-class_added" ${prefs.class_added !== false ? 'checked' : ''} />
                <span>${t('prof_pref_class_added')}</span>
              </label>
              <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
                <input type="checkbox" id="ep-session_published" ${prefs.session_published !== false ? 'checked' : ''} />
                <span>${t('prof_pref_session_published')}</span>
              </label>
              <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
                <input type="checkbox" id="ep-submission_new" ${prefs.submission_new !== false ? 'checked' : ''} />
                <span>${t('prof_pref_submission_new')}</span>
              </label>
              <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
                <input type="checkbox" id="ep-graded" ${prefs.graded !== false ? 'checked' : ''} />
                <span>${t('prof_pref_graded')}</span>
              </label>
              <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
                <input type="checkbox" id="ep-resubmit_allowed" ${prefs.resubmit_allowed !== false ? 'checked' : ''} />
                <span>${t('prof_pref_resubmit_allowed')}</span>
              </label>
              <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
                <input type="checkbox" id="ep-deadline_reminder" ${prefs.deadline_reminder !== false ? 'checked' : ''} />
                <span>${t('prof_pref_deadline_reminder')}</span>
              </label>
            </div>
          </div>

          <button type="submit" class="btn btn-primary">${t('prof_save_btn')}</button>
        </form>
      </div>

      <div class="card">
        <h2 style="margin-top:0;font-size:18px;">${t('prof_change_pwd_section')}</h2>
        <p style="font-size:13.5px;color:var(--text-muted);">
          Đổi mật khẩu định kỳ để bảo vệ tài khoản của bạn.
        </p>
        <a href="#/change-password" class="btn btn-secondary">${t('pwd_change_title')}</a>
      </div>
    </div>
  `;

  document.getElementById('prof-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const msgEl = document.getElementById('prof-msg');
    try {
      const full_name = document.getElementById('prof-name').value.trim();
      const language = document.getElementById('prof-lang').value;
      const email_prefs = {
        class_added: document.getElementById('ep-class_added').checked,
        session_published: document.getElementById('ep-session_published').checked,
        submission_new: document.getElementById('ep-submission_new').checked,
        graded: document.getElementById('ep-graded').checked,
        resubmit_allowed: document.getElementById('ep-resubmit_allowed').checked,
        deadline_reminder: document.getElementById('ep-deadline_reminder').checked
      };

      const res = await apiFetch('/api/auth/profile', {
        method: 'PUT',
        body: { full_name, language, email_prefs }
      });

      state.user = res.user;
      state.lang = res.user.language;
      localStorage.setItem('miniclass_lang', state.lang);
      renderNavbar();
      renderProfileScreen();
      showToast('Đã lưu thông tin hồ sơ cá nhân.');
    } catch (err) {
      msgEl.innerHTML = `<div class="alert alert-error">${escapeHtml(err.message)}</div>`;
    }
  });
}

// =========================================================================
// S15: ADMIN AUDIT LOGS & DYNAMIC SETTINGS (ADM-02, ADM-03)
// =========================================================================
async function renderAdminAuditScreen() {
  const app = document.getElementById('app-root');
  if (state.user?.role !== 'admin') {
    app.innerHTML = `<div class="alert alert-error">403 Forbidden</div>`;
    return;
  }

  let actor = '';
  let action = '';
  let fromDate = '';
  let toDate = '';

  const loadLogs = async () => {
    const params = new URLSearchParams();
    if (actor) params.set('actor', actor);
    if (action) params.set('action', action);
    if (fromDate) params.set('from', fromDate);
    if (toDate) params.set('to', toDate);

    const data = await apiFetch(`/api/admin/audit-logs?${params.toString()}`);
    const logs = data.logs || [];
    const tbody = document.getElementById('audit-tbody');
    if (!tbody) return;

    if (logs.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:24px;">${t('empty_data')}</td></tr>`;
      return;
    }

    tbody.innerHTML = logs
      .map(
        (l) => `
      <tr>
        <td style="white-space:nowrap;">${formatDateTime(l.created_at)}</td>
        <td><strong>${escapeHtml(l.actor_username)}</strong></td>
        <td><span class="badge">${escapeHtml(l.action)}</span></td>
        <td>${escapeHtml(l.target_type)} #${escapeHtml(l.target_id || '')}</td>
        <td><code style="font-size:12px;">${escapeHtml(l.details_json)}</code></td>
      </tr>
    `
      )
      .join('');
  };

  app.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">${t('adm_audit_title')}</h1>
    </div>

    <div class="filter-bar">
      <input type="text" id="aud-actor" class="form-input" style="max-width:220px;" placeholder="${t('adm_filter_actor')}" />
      <select id="aud-action" class="form-select" style="max-width:220px;">
        <option value="">${t('adm_filter_action')}</option>
        <option value="USER_CREATE">USER_CREATE</option>
        <option value="USER_LOCK">USER_LOCK</option>
        <option value="USER_UNLOCK">USER_UNLOCK</option>
        <option value="USER_RESET_PASSWORD">USER_RESET_PASSWORD</option>
        <option value="USER_DELETE">USER_DELETE</option>
        <option value="CLASS_CREATE">CLASS_CREATE</option>
        <option value="CLASS_UPDATE">CLASS_UPDATE</option>
        <option value="CLASS_DELETE">CLASS_DELETE</option>
        <option value="SESSION_DELETE">SESSION_DELETE</option>
        <option value="GRADE_CREATE">GRADE_CREATE</option>
        <option value="GRADE_UPDATE">GRADE_UPDATE</option>
        <option value="SYSTEM_CONFIG_UPDATE">SYSTEM_CONFIG_UPDATE</option>
      </select>
      <input type="date" id="aud-from" class="form-input" style="max-width:160px;" />
      <input type="date" id="aud-to" class="form-input" style="max-width:160px;" />
    </div>

    <div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr>
            <th>Thời gian</th>
            <th>Người thực hiện</th>
            <th>Hành động</th>
            <th>Đối tượng</th>
            <th>Chi tiết</th>
          </tr>
        </thead>
        <tbody id="audit-tbody">
          <tr><td colspan="5" style="text-align:center;padding:24px;">${t('loading')}</td></tr>
        </tbody>
      </table>
    </div>
  `;

  document.getElementById('aud-actor')?.addEventListener('input', (e) => {
    actor = e.target.value.trim();
    loadLogs();
  });
  document.getElementById('aud-action')?.addEventListener('change', (e) => {
    action = e.target.value;
    loadLogs();
  });
  document.getElementById('aud-from')?.addEventListener('change', (e) => {
    fromDate = e.target.value;
    loadLogs();
  });
  document.getElementById('aud-to')?.addEventListener('change', (e) => {
    toDate = e.target.value;
    loadLogs();
  });

  await loadLogs();
}

async function renderAdminSettingsScreen() {
  const app = document.getElementById('app-root');
  if (state.user?.role !== 'admin') {
    app.innerHTML = `<div class="alert alert-error">403 Forbidden</div>`;
    return;
  }

  const data = await apiFetch('/api/admin/settings');
  const s = data.settings;
  const emailQueue = data.emailQueue || [];

  app.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">${t('adm_settings_title')}</h1>
      <button type="button" class="btn btn-secondary btn-sm" id="btn-run-jobs">${t('adm_run_jobs')}</button>
    </div>

    <div class="card">
      <div id="cfg-msg"></div>
      <form id="cfg-form">
        <div class="form-group">
          <label class="form-label" for="cfg-exts">${t('adm_allowed_exts')}</label>
          <input type="text" id="cfg-exts" class="form-input" value="${escapeHtml((s.allowed_submission_extensions || []).join(', '))}" required />
        </div>
        <div class="form-group">
          <label class="form-label" for="cfg-size">${t('adm_max_sub_size')}</label>
          <input type="number" id="cfg-size" class="form-input" style="max-width:180px;" min="1" max="100" value="${Number(s.max_submission_size_mb || 10)}" required />
        </div>
        <div class="form-group">
          <label class="form-label" for="cfg-badge">${t('adm_badge_mode')}</label>
          <select id="cfg-badge" class="form-select" style="max-width:420px;">
            <option value="subtle" ${s.badge_color_mode !== 'monochrome' ? 'selected' : ''}>${t('adm_badge_subtle')}</option>
            <option value="monochrome" ${s.badge_color_mode === 'monochrome' ? 'selected' : ''}>${t('adm_badge_mono')}</option>
          </select>
        </div>
        <button type="submit" class="btn btn-primary">${t('btn_save')}</button>
      </form>
    </div>

    <div class="card">
      <h2 style="margin-top:0;font-size:18px;">${t('adm_email_outbox')} (${emailQueue.length})</h2>
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>Thời gian</th>
              <th>Người nhận</th>
              <th>Sự kiện</th>
              <th>Tiêu đề Email</th>
              <th>Trạng thái</th>
            </tr>
          </thead>
          <tbody>
            ${
              emailQueue.length === 0
                ? `<tr><td colspan="5" style="text-align:center;padding:20px;">${t('empty_data')}</td></tr>`
                : emailQueue
                    .map(
                      (eq) => `
                  <tr>
                    <td>${formatDateTime(eq.created_at)}</td>
                    <td>${escapeHtml(eq.to_email)}</td>
                    <td><code>${escapeHtml(eq.event_type)}</code></td>
                    <td>${escapeHtml(eq.subject)}</td>
                    <td><span class="badge badge-graded">${escapeHtml(eq.status)}</span></td>
                  </tr>
                `
                    )
                    .join('')
            }
          </tbody>
        </table>
      </div>
    </div>
  `;

  document.getElementById('cfg-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const res = await apiFetch('/api/admin/settings', {
        method: 'PUT',
        body: {
          allowed_submission_extensions: document.getElementById('cfg-exts').value,
          max_submission_size_mb: Number(document.getElementById('cfg-size').value),
          badge_color_mode: document.getElementById('cfg-badge').value
        }
      });
      state.settings = res.settings;
      applyBadgeMode();
      showToast('Đã cập nhật cấu hình hệ thống.');
    } catch (err) {
      document.getElementById('cfg-msg').innerHTML = `<div class="alert alert-error">${escapeHtml(err.message)}</div>`;
    }
  });

  document.getElementById('btn-run-jobs')?.addEventListener('click', async () => {
    const res = await apiFetch('/api/admin/jobs/run', { method: 'POST' });
    showToast(`Đã chạy tác vụ: Nhắc hạn ${res.reminded} HS, Tổng hợp email ${res.digested} GV.`);
    renderAdminSettingsScreen();
  });
}

// =========================================================================
// CLIENT ROUTER
// =========================================================================
async function route() {
  if (state.autoSaveTimer) {
    clearInterval(state.autoSaveTimer);
    state.autoSaveTimer = null;
  }
  cleanupExamListeners();
  state.mobileMenuOpen = false;
  closeModal();

  const rawHash = window.location.hash || '#/';
  const [pathPart, queryPart] = rawHash.slice(1).split('?');
  const params = new URLSearchParams(queryPart || '');

  // AC-01: Block #/register or #/signup in client router too
  if (pathPart === '/register' || pathPart === '/signup') {
    const app = document.getElementById('app-root');
    app.innerHTML = `<div class="alert alert-error">404 Not Found — Hệ thống không có trang tự đăng ký tài khoản (AC-01 / BR-01).</div>`;
    return;
  }

  if (!state.user) {
    if (pathPart !== '/login') {
      window.location.hash = '#/login';
      return;
    }
    renderNavbar();
    renderLoginScreen();
    return;
  }

  // AUTH-05 & AC-02: Force password change on first login
  if (state.user.must_change_password && pathPart !== '/change-password') {
    window.location.hash = '#/change-password';
    return;
  }

  renderNavbar();

  if (pathPart === '/login') {
    window.location.hash = '#/';
    return;
  }

  if (pathPart === '/change-password') {
    renderChangePasswordScreen();
    return;
  }

  if (pathPart === '/' || pathPart === '') {
    await renderDashboardScreen();
    return;
  }

  if (pathPart === '/admin/users') {
    await renderAdminUsersScreen();
    return;
  }

  if (pathPart === '/admin/audit') {
    await renderAdminAuditScreen();
    return;
  }

  if (pathPart === '/admin/settings') {
    await renderAdminSettingsScreen();
    return;
  }

  if (pathPart === '/classes') {
    await renderClassesListScreen();
    return;
  }

  if (pathPart === '/exams') {
    await renderExamsListScreen(state.user);
    return;
  }

  if (pathPart === '/exams/new') {
    await renderExamEditorScreen(state.user, null);
    return;
  }

  const examEditMatch = pathPart.match(/^\/exams\/(\d+)\/edit$/);
  if (examEditMatch) {
    await renderExamEditorScreen(state.user, Number(examEditMatch[1]));
    return;
  }

  const examAttemptsMatch = pathPart.match(/^\/exams\/(\d+)\/attempts$/);
  if (examAttemptsMatch) {
    await renderExamAttemptsScreen(state.user, Number(examAttemptsMatch[1]));
    return;
  }

  const examDetailMatch = pathPart.match(/^\/exams\/(\d+)$/);
  if (examDetailMatch) {
    await renderExamTakeOrViewScreen(state.user, Number(examDetailMatch[1]));
    return;
  }

  const clsDetailMatch = pathPart.match(/^\/classes\/(\d+)$/);
  if (clsDetailMatch) {
    await renderClassDetailScreen(Number(clsDetailMatch[1]), params.get('tab') || 'sessions');
    return;
  }

  const sesNewMatch = pathPart.match(/^\/classes\/(\d+)\/sessions\/new$/);
  if (sesNewMatch) {
    await renderSessionEditorScreen(Number(sesNewMatch[1]), null);
    return;
  }

  const sesEditMatch = pathPart.match(/^\/classes\/(\d+)\/sessions\/(\d+)\/edit$/);
  if (sesEditMatch) {
    await renderSessionEditorScreen(Number(sesEditMatch[1]), Number(sesEditMatch[2]));
    return;
  }

  const sesDetailMatch = pathPart.match(/^\/classes\/(\d+)\/sessions\/(\d+)$/);
  if (sesDetailMatch) {
    await renderSessionDetailScreen(Number(sesDetailMatch[1]), Number(sesDetailMatch[2]));
    return;
  }

  const sesSubsMatch = pathPart.match(/^\/classes\/(\d+)\/sessions\/(\d+)\/submissions$/);
  if (sesSubsMatch) {
    await renderSessionSubmissionsScreen(Number(sesSubsMatch[1]), Number(sesSubsMatch[2]));
    return;
  }

  if (pathPart === '/notifications') {
    await renderNotificationsScreen();
    return;
  }

  if (pathPart === '/profile') {
    renderProfileScreen();
    return;
  }

  const app = document.getElementById('app-root');
  app.innerHTML = `<div class="empty-state">404 — Trang không tồn tại. <a href="#/">Quay về Trang chủ</a></div>`;
}

// =========================================================================
// INITIALIZATION
// =========================================================================
async function initApp() {
  try {
    const me = await apiFetch('/api/auth/me');
    state.user = me.user;
    state.csrfToken = me.csrfToken;
    state.unreadNotifications = me.unreadNotifications || 0;
    if (me.settings) {
      state.settings = me.settings;
      applyBadgeMode();
    }
    if (me.user?.language) {
      state.lang = me.user.language;
      localStorage.setItem('miniclass_lang', state.lang);
    }
  } catch {
    state.user = null;
    try {
      const pub = await apiFetch('/api/public/config');
      if (pub.badge_color_mode) {
        state.settings.badge_color_mode = pub.badge_color_mode;
        applyBadgeMode();
      }
    } catch {}
  }

  document.documentElement.lang = state.lang;
  window.addEventListener('hashchange', route);
  await route();
}

initApp();
