import { getDb, seedInitialData } from '../src/db.mjs';
import { initExamsSchema } from '../src/exams-db.mjs';

const db = getDb();
initExamsSchema(db);
seedInitialData(db);
console.log('[Seed] Đã đảm bảo tài khoản mặc định tồn tại (không xóa dữ liệu hiện có).');
