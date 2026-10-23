import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';

const catalog = JSON.parse(readFileSync(new URL('./catalog.json', import.meta.url), 'utf8'));

// SQLite is bundled with Node 22.13+. No separate database server is needed.
export function openDatabase(filename, { seed = true } = {}) {
  if (filename !== ':memory:') mkdirSync(dirname(resolve(filename)), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version > 2) { db.close(); throw new Error('This database needs a newer project version.'); }
  if (version === 0) {
    db.exec(`
      BEGIN;
      CREATE TABLE books (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        author TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        color TEXT NOT NULL DEFAULT 'navy',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      CREATE TABLE reviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
        reviewer TEXT NOT NULL,
        rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
        content TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      CREATE INDEX idx_reviews_book_id ON reviews(book_id);
      PRAGMA user_version = 1;
      COMMIT;
    `);
  }
  // Upgrade existing databases without replacing books, IDs, or reviews.
  if (version < 2) {
    db.exec(`BEGIN;
      ALTER TABLE books ADD COLUMN read_url TEXT NOT NULL DEFAULT '';
      ALTER TABLE books ADD COLUMN cover_url TEXT NOT NULL DEFAULT '';
      CREATE TABLE catalog_imports (catalog_key TEXT PRIMARY KEY);
      PRAGMA user_version = 2;
      COMMIT;`);
  }
  // One import per database: deleted or edited books stay deleted or edited.
  if (seed && !db.prepare('SELECT 1 FROM catalog_imports WHERE catalog_key = ?').get('myanmar-books-10-v1')) {
    db.exec('BEGIN');
    try {
      const insert = db.prepare('INSERT INTO books (title, author, description, color, read_url, cover_url) VALUES (?, ?, ?, ?, ?, ?)');
      for (const book of catalog) insert.run(book.title, book.author, book.description, book.color, book.read_url, book.cover_url);
      db.prepare('INSERT INTO catalog_imports (catalog_key) VALUES (?)').run('myanmar-books-10-v1');
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); db.close(); throw error; }
  }
  return db;
}
