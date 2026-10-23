import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createApp } from '../server.js';
import { DatabaseSync } from 'node:sqlite';

async function fixture(t, options = {}) {
  const instance = createApp({ databasePath: ':memory:', seed: false, ...options });
  const server = instance.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); instance.db.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, method = 'GET', body, headers = {}) => {
    const response = await fetch(origin + path, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  return { ...instance, request, origin };
}
const book = { title: 'စမ်းသပ်စာအုပ်', author: 'Aung', description: 'A local demonstration.', color: 'navy' };
const review = { reviewer: 'Reader', rating: 5, content: 'A thoughtful read.' };

test('book/review CRUD, aggregates, and cascading deletion', async (t) => {
  const { request, db } = await fixture(t);
  const created = await request('/api/books', 'POST', book);
  assert.equal(created.status, 201);
  const id = created.data.id;
  assert.equal(created.data.average_rating, null);
  assert.equal((await request('/api/books')).data[0].title, book.title);
  const first = await request(`/api/books/${id}/reviews`, 'POST', review);
  const second = await request(`/api/books/${id}/reviews`, 'POST', { ...review, reviewer: 'Second reader', rating: 3 });
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  let details = (await request(`/api/books/${id}`)).data;
  assert.equal(details.book.average_rating, 4);
  assert.equal(details.book.review_count, 2);
  assert.equal((await request(`/api/reviews/${first.data.id}`, 'PUT', { ...review, rating: 1, content: 'Updated review.' })).status, 200);
  assert.equal((await request(`/api/books/${id}`)).data.book.average_rating, 2);
  assert.equal((await request(`/api/books/${id}`, 'PUT', { ...book, title: 'Edited title' })).data.title, 'Edited title');
  assert.equal((await request(`/api/reviews/${second.data.id}`, 'DELETE')).status, 200);
  assert.equal((await request(`/api/books/${id}`)).data.book.review_count, 1);
  assert.equal((await request(`/api/books/${id}`, 'DELETE')).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM reviews').get().count, 0);
  assert.equal((await request(`/api/books/${id}`)).status, 404);
});

test('invalid data and malformed/missing IDs fail without modifying records', async (t) => {
  const { request, origin } = await fixture(t);
  assert.equal((await request('/api/books', 'POST', { ...book, title: ' ' })).status, 400);
  assert.equal((await request('/api/books', 'POST', { ...book, color: 'javascript:bad' })).status, 400);
  const id = (await request('/api/books', 'POST', book)).data.id;
  for (const rating of [0, 6, 2.5, '5', null]) assert.equal((await request(`/api/books/${id}/reviews`, 'POST', { ...review, rating })).status, 400);
  assert.equal((await request(`/api/books/${id}/reviews`, 'POST', { ...review, content: ' ' })).status, 400);
  assert.equal((await request('/api/books/not-a-number')).status, 400);
  assert.equal((await request('/api/books/999999')).status, 404);
  assert.equal((await request('/api/books/999999/reviews', 'POST', review)).status, 404);
  assert.equal((await request('/api/reviews/999999', 'PUT', review)).status, 404);
  const invalid = await fetch(origin + '/api/books', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' });
  assert.equal(invalid.status, 400);
  assert.equal((await request('/api/books')).data.length, 1);
});

test('parameterized SQL preserves input as data; cross-origin changes are rejected', async (t) => {
  const { request } = await fixture(t);
  const title = "'); DROP TABLE books; -- <img src=x onerror=alert(1)>";
  const created = await request('/api/books', 'POST', { ...book, title });
  assert.equal(created.status, 201);
  assert.equal((await request(`/api/books/${created.data.id}`)).data.book.title, title);
  assert.equal((await request('/api/books', 'POST', book, { Origin: 'https://another-site.example' })).status, 403);
  assert.equal((await request('/api/books')).data.length, 1);
});

test('SQLite records survive closing and reopening; deleted sample data is not reseeded', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'readshelf-'));
  try {
    const path = join(dir, 'test.db');
    let instance = createApp({ databasePath: path, seed: true });
    const sample = instance.db.prepare('SELECT id FROM books LIMIT 1').get().id;
    instance.db.prepare('DELETE FROM books WHERE id = ?').run(sample);
    instance.db.prepare('INSERT INTO books (title, author, color) VALUES (?, ?, ?)').run('Persistent book', 'Author', 'forest');
    instance.db.close();
    instance = createApp({ databasePath: path, seed: true });
    assert.equal(instance.db.prepare('SELECT COUNT(*) AS count FROM books').get().count, 10);
    assert(instance.db.prepare('SELECT id FROM books WHERE title = ?').get('Persistent book'));
    assert.equal(instance.db.prepare('SELECT id FROM books WHERE id = ?').get(sample), undefined);
    instance.db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('book links round-trip, can be edited or cleared, and reject executable URLs', async (t) => {
  const { request } = await fixture(t);
  const created = await request('/api/books', 'POST', { ...book, read_url: 'https://example.com/book.pdf' });
  assert.equal(created.status, 201);
  assert.equal(created.data.read_url, 'https://example.com/book.pdf');
  const path = `/api/books/${created.data.id}`;
  assert.equal((await request(path, 'PUT', { ...book, read_url: '/books/you-can-do-it.pdf' })).data.read_url, '/books/you-can-do-it.pdf');
  for (const read_url of ['javascript:alert(1)', 'data:text/html,hello', '//evil.example', '/books/../../server.js', 'https://user:password@example.com']) {
    assert.equal((await request(path, 'PUT', { ...book, read_url })).status, 400, read_url);
  }
  assert.equal((await request(path)).data.book.read_url, '/books/you-can-do-it.pdf');
  assert.equal((await request(path, 'PUT', { ...book, read_url: '' })).data.read_url, '');
});

test('all ten bundled PDFs support reading with byte ranges and cover URLs resolve', async (t) => {
  const { request, origin } = await fixture(t, { seed: true });
  const books = (await request('/api/books')).data;
  assert.equal(books.length, 10);
  for (const book of books) {
    const pdf = await fetch(origin + book.read_url, { headers: { Range: 'bytes=0-31' } });
    assert.equal(pdf.status, 206, book.title);
    assert.match(pdf.headers.get('content-type'), /application\/pdf/);
    assert.match(await pdf.text(), /^%PDF-/);
    if (book.cover_url) {
      const cover = await fetch(origin + book.cover_url);
      assert.equal(cover.status, 200);
      assert.match(cover.headers.get('content-type'), /image\/jpeg/);
      await cover.arrayBuffer();
    }
  }
});

test('version 1 database upgrades without losing existing books or reviews', () => {
  const dir = mkdtempSync(join(tmpdir(), 'readshelf-upgrade-'));
  try {
    const path = join(dir, 'old.db');
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT, author TEXT, description TEXT DEFAULT '', color TEXT DEFAULT 'navy', created_at TEXT DEFAULT '2026-01-01');
      CREATE TABLE reviews (id INTEGER PRIMARY KEY, book_id INTEGER REFERENCES books(id) ON DELETE CASCADE, reviewer TEXT, rating INTEGER, content TEXT, created_at TEXT DEFAULT '2026-01-01', updated_at TEXT DEFAULT '2026-01-01');
      INSERT INTO books (id,title,author) VALUES (55,'Existing book','Author');
      INSERT INTO reviews (id,book_id,reviewer,rating,content) VALUES (77,55,'Reader',4,'Keep this review');
      PRAGMA user_version = 1;`);
    old.close();
    let { db } = createApp({ databasePath: path });
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM books').get().count, 11);
    assert.equal(db.prepare('SELECT content FROM reviews WHERE id=77').get().content, 'Keep this review');
    assert.equal(db.prepare('SELECT title,read_url FROM books WHERE id=55').get().title, 'Existing book');
    db.close();
    ({ db } = createApp({ databasePath: path }));
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM books').get().count, 11);
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('local frontend and compiled CSS are served by the same server', async (t) => {
  const { origin } = await fixture(t);
  for (const path of ['/', '/app.js', '/styles.css', '/favicon.svg']) {
    const response = await fetch(origin + path);
    assert.equal(response.status, 200, path);
    assert((await response.text()).length > 10);
  }
});
