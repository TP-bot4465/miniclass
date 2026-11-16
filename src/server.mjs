import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from './config.mjs';
import { getDb } from './db.mjs';
import { initExamsSchema } from './exams-db.mjs';
import { handleApiRequest, sendJson } from './routes/api.mjs';
import { handleExamsApiRequest } from './routes/exams-api.mjs';
import { processEmailQueue, runDeadlineReminders } from './email.mjs';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon'
};

export function createAppServer() {
  // Initialize DB & seed if empty
  const db = getDb();
  initExamsSchema(db);

  const server = http.createServer(async (req, res) => {
    try {
      const host = req.headers.host || `localhost:${CONFIG.PORT}`;
      const urlObj = new URL(req.url || '/', `http://${host}`);
      const pathname = urlObj.pathname;

      // AC-01 & BR-01: No public registration page exists
      if (pathname === '/register' || pathname === '/signup' || pathname === '/register.html') {
        res.writeHead(404, {
          'Content-Type': 'text/plain; charset=utf-8',
          'X-Content-Type-Options': 'nosniff'
        });
        res.end('404 Not Found - Self-registration is disabled (BR-01 / AC-01).');
        return;
      }

      if (
        pathname.startsWith('/api/exams') ||
        pathname.startsWith('/api/exam-attempts') ||
        pathname.startsWith('/api/exam-answers')
      ) {
        await handleExamsApiRequest(req, res, urlObj);
        return;
      }

      if (pathname.startsWith('/api/')) {
        await handleApiRequest(req, res, urlObj);
        return;
      }

      // Serve static files from public/
      let relPath = pathname === '/' ? '/index.html' : pathname;
      const safePath = path.normalize(path.join(CONFIG.PUBLIC_DIR, relPath));
      if (!safePath.startsWith(CONFIG.PUBLIC_DIR)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('403 Forbidden');
        return;
      }

      if (fs.existsSync(safePath) && fs.statSync(safePath).isFile()) {
        const ext = path.extname(safePath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';
        res.writeHead(200, {
          'Content-Type': contentType,
          'X-Content-Type-Options': 'nosniff',
          'X-Frame-Options': 'SAMEORIGIN',
          'Cache-Control': 'no-cache'
        });
        fs.createReadStream(safePath).pipe(res);
        return;
      }

      // SPA fallback to index.html for unknown non-file routes (except /register)
      if (!path.extname(pathname)) {
        const indexHtml = path.join(CONFIG.PUBLIC_DIR, 'index.html');
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'X-Content-Type-Options': 'nosniff',
          'X-Frame-Options': 'SAMEORIGIN'
        });
        fs.createReadStream(indexHtml).pipe(res);
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
    } catch (err) {
      console.error('[Server Error]:', err);
      if (!res.headersSent) {
        sendJson(res, 500, {
          error: 'INTERNAL_SERVER_ERROR',
          message_vi: 'Đã xảy ra lỗi hệ thống. Vui lòng thử lại.',
          message_en: 'An internal server error occurred. Please try again.'
        });
      }
    }
  });

  return server;
}

// Run directly if executed as main module
const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(currentFile)) {
  const server = createAppServer();
  server.listen(CONFIG.PORT, CONFIG.HOST, () => {
    console.log(`============================================================`);
    console.log(`  MiniClass v1.0 Server running at http://localhost:${CONFIG.PORT}`);
    console.log(`  Timezone: ${CONFIG.TZ} | Database: ${CONFIG.DB_PATH}`);
    console.log(`============================================================`);
  });

  // Background jobs for async email queue & 24h deadline reminders (NOT-04, NOT-05)
  const queueTimer = setInterval(() => {
    processEmailQueue().catch(() => {});
  }, 30_000);
  queueTimer.unref();

  const reminderTimer = setInterval(() => {
    runDeadlineReminders();
  }, 10 * 60_000);
  reminderTimer.unref();

  // Keep Render Free Tier awake 24/7 automatically when RENDER_EXTERNAL_URL is set
  if (process.env.RENDER_EXTERNAL_URL && process.env.KEEP_ALIVE_24_7 !== 'false') {
    const pingUrl = `${process.env.RENDER_EXTERNAL_URL.replace(/\/$/, '')}/api/public/config`;
    const keepAliveTimer = setInterval(() => {
      fetch(pingUrl).catch(() => {});
    }, 12 * 60_000);
    keepAliveTimer.unref();
  }
}
