import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(__dirname, '..');

// Load .env if present
const envFile = path.join(ROOT_DIR, '.env');
if (fs.existsSync(envFile)) {
  const lines = fs.readFileSync(envFile, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!(key in process.env)) {
        process.env[key] = val;
      }
    }
  }
}

const DATA_DIR = path.resolve(ROOT_DIR, process.env.DATA_DIR || './data');
const UPLOAD_DIR = path.resolve(ROOT_DIR, process.env.UPLOAD_DIR || path.join(DATA_DIR, 'uploads'));
const BACKUP_DIR = path.resolve(ROOT_DIR, process.env.BACKUP_DIR || path.join(DATA_DIR, 'backups'));
const DB_PATH = path.resolve(ROOT_DIR, process.env.DB_PATH || path.join(DATA_DIR, 'miniclass.sqlite'));

export const CONFIG = {
  PORT: Number(process.env.PORT || 3000),
  HOST: process.env.HOST || '0.0.0.0',
  NODE_ENV: process.env.NODE_ENV || 'development',
  TZ: process.env.TZ || 'Asia/Ho_Chi_Minh',
  ROOT_DIR,
  PUBLIC_DIR: path.join(ROOT_DIR, 'public'),
  DATA_DIR,
  UPLOAD_DIR,
  IMAGES_DIR: path.join(UPLOAD_DIR, 'images'),
  ATTACHMENTS_DIR: path.join(UPLOAD_DIR, 'attachments'),
  SUBMISSIONS_DIR: path.join(UPLOAD_DIR, 'submissions'),
  BACKUP_DIR,
  DB_PATH,

  SESSION_SECRET: process.env.SESSION_SECRET || 'miniclass-secret-key-2026',
  SESSION_TTL_MS: Number(process.env.SESSION_TTL_DAYS || 7) * 24 * 60 * 60 * 1000,
  LOGIN_MAX_ATTEMPTS: Number(process.env.LOGIN_MAX_ATTEMPTS || 5),
  LOGIN_LOCKOUT_MS: Number(process.env.LOGIN_LOCKOUT_MINUTES || 15) * 60 * 1000,

  DEFAULT_MAX_SUBMISSION_SIZE_MB: Number(process.env.MAX_SUBMISSION_SIZE_MB || 10),
  DEFAULT_MAX_ATTACHMENT_SIZE_MB: Number(process.env.MAX_ATTACHMENT_SIZE_MB || 20),
  DEFAULT_MAX_IMAGE_SIZE_MB: Number(process.env.MAX_IMAGE_SIZE_MB || 5),
  MAX_ATTACHMENTS_PER_SESSION: Number(process.env.MAX_ATTACHMENTS_PER_SESSION || 10),

  DEFAULT_SUBMISSION_EXTENSIONS: (
    process.env.ALLOWED_SUBMISSION_EXTENSIONS ||
    'doc,docx,pdf,txt,md,py,ipynb,html,css,js,java,c,cpp,zip,rar,xls,xlsx,ppt,pptx,png,jpg'
  )
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),

  ALLOWED_IMAGE_EXTENSIONS: ['jpg', 'jpeg', 'png', 'gif', 'webp'],
  ALLOWED_ATTACHMENT_EXTENSIONS: [
    'pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'txt', 'md',
    'zip', 'rar', 'py', 'html', 'css', 'js', 'java', 'c', 'cpp', 'ipynb', 'csv', 'png', 'jpg', 'jpeg'
  ],

  SMTP: {
    enabled: process.env.SMTP_ENABLED === 'true',
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: Number(process.env.SMTP_PORT || 587),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || 'MiniClass <noreply@miniclass.local>'
  }
};

// Ensure directories exist outside public web root (NFR-08)
for (const dir of [
  CONFIG.DATA_DIR,
  CONFIG.UPLOAD_DIR,
  CONFIG.IMAGES_DIR,
  CONFIG.ATTACHMENTS_DIR,
  CONFIG.SUBMISSIONS_DIR,
  CONFIG.BACKUP_DIR
]) {
  fs.mkdirSync(dir, { recursive: true });
}
