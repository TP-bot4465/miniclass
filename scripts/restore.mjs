import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { CONFIG } from '../src/config.mjs';

/**
 * Restore script (NFR-13):
 * Restores SQLite database and uploaded files from the latest (or specified) backup ZIP archive.
 */
function parseAndExtractZip(zipBuffer, targetRootDir) {
  let offset = 0;
  let extracted = 0;

  while (offset + 30 <= zipBuffer.length) {
    const sig = zipBuffer.readUInt32LE(offset);
    if (sig !== 0x04034b50) break; // End of local file headers

    const method = zipBuffer.readUInt16LE(offset + 8);
    const compressedSize = zipBuffer.readUInt32LE(offset + 18);
    const nameLen = zipBuffer.readUInt16LE(offset + 26);
    const extraLen = zipBuffer.readUInt16LE(offset + 28);

    const fileName = zipBuffer.subarray(offset + 30, offset + 30 + nameLen).toString('utf8');
    const dataStart = offset + 30 + nameLen + extraLen;
    const compressedData = zipBuffer.subarray(dataStart, dataStart + compressedSize);

    const rawData = method === 8 ? zlib.inflateRawSync(compressedData) : compressedData;
    const destPath = path.resolve(targetRootDir, fileName);
    if (destPath.startsWith(path.resolve(targetRootDir))) {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.writeFileSync(destPath, rawData);
      extracted++;
    }

    offset = dataStart + compressedSize;
  }

  return extracted;
}

const argFile = process.argv[2];
let backupPath = argFile ? path.resolve(argFile) : null;

if (!backupPath) {
  const manifestFile = path.join(CONFIG.BACKUP_DIR, 'latest-backup-manifest.json');
  if (fs.existsSync(manifestFile)) {
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    backupPath = path.join(CONFIG.BACKUP_DIR, manifest.backupFile);
  }
}

if (!backupPath || !fs.existsSync(backupPath)) {
  console.error('[Restore] Backup file not found. Run `npm run backup` first or pass backup zip path.');
  process.exit(1);
}

const buf = fs.readFileSync(backupPath);
const count = parseAndExtractZip(buf, CONFIG.DATA_DIR);
console.log(`[Restore] Successfully restored ${count} file(s) from ${backupPath} into ${CONFIG.DATA_DIR}`);
