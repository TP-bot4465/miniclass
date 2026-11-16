import { getDb, seedInitialData } from '../src/db.mjs';
import { initExamsSchema } from '../src/exams-db.mjs';

const db = getDb();
initExamsSchema(db);
db.exec(`
  DELETE FROM exam_anticheat_logs;
  DELETE FROM exam_answers;
  DELETE FROM exam_attempts;
  DELETE FROM exam_questions;
  DELETE FROM exams;
`);
seedInitialData(db);
console.log('[Seed] Đã cập nhật dữ liệu thật: admin (Abc1234!@) và giáo viên Nguyễn Thanh Phong (nguyenthanhphong / 1234).');
