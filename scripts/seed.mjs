import { getDb, seedInitialData } from '../src/db.mjs';

const db = getDb();
const count = db.prepare('SELECT COUNT(*) AS cnt FROM users').get().cnt;
if (count === 0) {
  seedInitialData(db);
  console.log('[Seed] Initial data seeded successfully.');
} else {
  console.log(`[Seed] Database already contains ${count} user(s).`);
}
