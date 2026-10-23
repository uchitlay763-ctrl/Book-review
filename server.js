import express from 'express';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { openDatabase } from './db.js';

const root = fileURLToPath(new URL('.', import.meta.url));
class InputError extends Error {}
const colors = new Set(['navy', 'forest', 'burgundy', 'ochre']);
function field(value, label, max, { optional = false } = {}) {
  if (typeof value !== 'string' || value.trim().length > max || (!optional && !value.trim())) {
    throw new InputError(`${label} ${optional ? `must be text up to ${max} characters.` : `is required (up to ${max} characters).`}`);
  }
  return value.trim();
}
function bookInput(body) {
  const title = field(body?.title, 'Book title', 150);
  const author = field(body?.author, 'Author', 100);
  const description = field(body?.description ?? '', 'Description', 3000, { optional: true });
  if (!colors.has(body?.color)) throw new InputError('Choose one of the available cover colors.');
  const read_url = field(body?.read_url ?? '', 'Book link', 2000, { optional: true });
  if (read_url) {
    if (!/^\/books\/[a-z0-9-]+\.pdf$/.test(read_url)) {
      let link;
      try { link = new URL(read_url); } catch { throw new InputError('Enter a complete http:// or https:// book link, or /books/filename.pdf.'); }
      if (!['http:', 'https:'].includes(link.protocol) || link.username || link.password) throw new InputError('Only http:// or https:// book links without login details are allowed.');
    }
  }
  return { title, author, description, color: body.color, read_url };
}
function reviewInput(body) {
  const reviewer = field(body?.reviewer, 'Reviewer name', 80);
  const content = field(body?.content, 'Review', 4000);
  if (!Number.isInteger(body?.rating) || body.rating < 1 || body.rating > 5) {
    throw new InputError('Rating must be a whole number from 1 to 5.');
  }
  return { reviewer, content, rating: body.rating };
}
function id(value) {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new InputError('Invalid record ID.');
  return Number(value);
}

export function createApp({ databasePath = join(root, 'data', 'books.db'), seed = true } = {}) {
  const db = openDatabase(databasePath, { seed });
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
    if (['POST', 'PUT', 'DELETE'].includes(req.method)) {
      const origin = req.get('Origin');
      if (origin) {
        try { if (new URL(origin).host !== req.get('Host')) return res.status(403).json({ error: 'Cross-origin changes are not allowed.' }); }
        catch { return res.status(403).json({ error: 'Invalid request origin.' }); }
      }
      if (req.method !== 'DELETE' && !req.is('application/json')) return res.status(415).json({ error: 'Send JSON with Content-Type: application/json.' });
    }
    next();
  });
  app.use(express.json({ limit: '32kb' }));

  // Aggregate ratings are calculated from actual saved reviews.
  const summarySql = `SELECT b.*, COUNT(r.id) AS review_count,
    ROUND(AVG(r.rating), 1) AS average_rating
    FROM books b LEFT JOIN reviews r ON r.book_id = b.id`;
  const findBook = (bookId) => db.prepare(`${summarySql} WHERE b.id = ? GROUP BY b.id`).get(bookId);
  const missing = (res, label) => res.status(404).json({ error: `${label} not found.` });

  app.get('/api/books', (req, res) => {
    res.json(db.prepare(`${summarySql} GROUP BY b.id ORDER BY b.id DESC`).all());
  });
  app.get('/api/books/:id', (req, res) => {
    const bookId = id(req.params.id);
    const book = findBook(bookId);
    if (!book) return missing(res, 'Book');
    const reviews = db.prepare('SELECT * FROM reviews WHERE book_id = ? ORDER BY id DESC').all(bookId);
    res.json({ book, reviews });
  });
  app.post('/api/books', (req, res) => {
    const book = bookInput(req.body);
    const result = db.prepare('INSERT INTO books (title, author, description, color, read_url) VALUES (?, ?, ?, ?, ?)')
      .run(book.title, book.author, book.description, book.color, book.read_url);
    res.status(201).json(findBook(Number(result.lastInsertRowid)));
  });
  app.put('/api/books/:id', (req, res) => {
    const bookId = id(req.params.id), book = bookInput(req.body);
    const result = db.prepare('UPDATE books SET title = ?, author = ?, description = ?, color = ?, read_url = ? WHERE id = ?')
      .run(book.title, book.author, book.description, book.color, book.read_url, bookId);
    if (!result.changes) return missing(res, 'Book');
    res.json(findBook(bookId));
  });
  app.delete('/api/books/:id', (req, res) => {
    const bookId = id(req.params.id);
    const result = db.prepare('DELETE FROM books WHERE id = ?').run(bookId);
    if (!result.changes) return missing(res, 'Book');
    res.json({ deleted: bookId }); // Foreign key cascade removes related reviews atomically.
  });
  app.post('/api/books/:id/reviews', (req, res) => {
    const bookId = id(req.params.id), review = reviewInput(req.body);
    if (!findBook(bookId)) return missing(res, 'Book');
    const result = db.prepare('INSERT INTO reviews (book_id, reviewer, rating, content) VALUES (?, ?, ?, ?)')
      .run(bookId, review.reviewer, review.rating, review.content);
    res.status(201).json(db.prepare('SELECT * FROM reviews WHERE id = ?').get(Number(result.lastInsertRowid)));
  });
  app.put('/api/reviews/:id', (req, res) => {
    const reviewId = id(req.params.id), review = reviewInput(req.body);
    const result = db.prepare("UPDATE reviews SET reviewer = ?, rating = ?, content = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?")
      .run(review.reviewer, review.rating, review.content, reviewId);
    if (!result.changes) return missing(res, 'Review');
    res.json(db.prepare('SELECT * FROM reviews WHERE id = ?').get(reviewId));
  });
  app.delete('/api/reviews/:id', (req, res) => {
    const reviewId = id(req.params.id);
    const result = db.prepare('DELETE FROM reviews WHERE id = ?').run(reviewId);
    if (!result.changes) return missing(res, 'Review');
    res.json({ deleted: reviewId });
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'API endpoint not found.' }));
  app.use(express.static(join(root, 'public')));
  app.use((req, res) => res.status(404).send('Page not found. Open http://localhost:3000/'));
  app.use((error, req, res, next) => {
    if (error instanceof InputError) return res.status(400).json({ error: error.message });
    if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'Request body must contain valid JSON.' });
    if (error.type === 'entity.too.large') return res.status(413).json({ error: 'Request is too large.' });
    console.error(error);
    res.status(500).json({ error: 'Something went wrong while accessing the database. Please try again.' });
  });
  return { app, db };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { app, db } = createApp();
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
  const server = app.listen(port, '127.0.0.1', () => console.log(`ReadShelf is ready: http://localhost:${port}`));
  server.on('error', (error) => { console.error(error.code === 'EADDRINUSE' ? `Port ${port} is in use. Stop the other server or choose another PORT.` : error); db.close(); process.exitCode = 1; });
  const shutdown = () => server.close(() => { db.close(); process.exit(0); });
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
