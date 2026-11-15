import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from '../src/config.mjs';
import { getDb } from '../src/db.mjs';
import { createZipBuffer } from '../src/zip.mjs';

/**
 * Backup script (NFR-13):
 * Backs up the SQLite database (after WAL checkpoint) and all uploaded files into a timestamped ZIP archive.
 * Retains the 30 most recent backups and removes older ones.
 */
export function runBackup() {
  const db = getDb();
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  } catch {}

  const filesToPack = [];
  if (fs.existsSync(CONFIG.DB_PATH)) {
    filesToPack.push({
      name: 'miniclass.sqlite',
      data: fs.readFileSync(CONFIG.DB_PATH)
    });
  }

  const collectDir = (dirPath, prefix) => {
    if (!fs.existsSync(dirPath)) return;
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      const full = path.join(dirPath, entry.name);
      const rel = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        collectDir(full, rel);
      } else if (entry.isFile()) {
        filesToPack.push({
          name: rel,
          data: fs.readFileSync(full)
        });
      }
    }
  };

  collectDir(CONFIG.UPLOAD_DIR, 'uploads');

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupName = `miniclass-backup-${stamp}.zip`;
  const backupPath = path.join(CONFIG.BACKUP_DIR, backupName);

  fs.mkdirSync(CONFIG.BACKUP_DIR, { recursive: true });
  const zipBuf = createZipBuffer(filesToPack);
  fs.writeFileSync(backupPath, zipBuf);

  // Also save a JSON manifest for fast verification/restore
  const manifestPath = path.join(CONFIG.BACKUP_DIR, 'latest-backup-manifest.json');
  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        backupFile: backupName,
        createdAt: new Date().toISOString(),
        fileCount: filesToPack.length,
        sizeBytes: zipBuf.length
      },
      null,
      2
    )
  );

  // Retain 30 most recent backups (NFR-13)
  const allBackups = fs
    .readdirSync(CONFIG.BACKUP_DIR)
    .filter((f) => f.startsWith('miniclass-backup-') && f.endsWith('.zip'))
    .sort()
    .reverse();

  for (const oldFile of allBackups.slice(30)) {
    try {
      fs.unlinkSync(path.join(CONFIG.BACKUP_DIR, oldFile));
    } catch {}
  }

  console.log(`[Backup] Created ${backupPath} (${filesToPack.length} files, ${zipBuf.length} bytes).`);
  return backupPath;
}

runBackup();
