// Frontend: every saved change goes through the Express REST API.
const $ = (selector) => document.querySelector(selector);
const state = { books: [], selectedId: null, detail: null, editingBookId: null, editingReviewId: null, busy: false, deleteAction: null };
let notificationTimer;

// Use textContent for all book/review text, so user input is never executed as HTML.
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function button(text, className, action, label) {
  const node = element('button', className, text);
  node.type = 'button';
  if (label) node.setAttribute('aria-label', label);
  node.addEventListener('click', action);
  return node;
}
function errorBox(target, message = '') {
  const node = typeof target === 'string' ? $(target) : target;
  if (!node) return;
  node.textContent = message;
  node.hidden = !message;
}
function notify(message) {
  const node = $('#notification');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(notificationTimer);
  notificationTimer = setTimeout(() => { node.hidden = true; }, 3500);
}
function busy(value) {
  state.busy = value;
  document.querySelectorAll('button, input, textarea, select').forEach((control) => { control.disabled = value; });
}
async function api(path, method = 'GET', data) {
  let response;
  try {
    response = await fetch('/api' + path, {
      method,
      headers: data === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
  } catch { throw new Error('Cannot reach the server. Keep npm start running, then try again.'); }
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'The request could not be completed.');
  return result;
}
function ratingText(book) {
  return book.review_count ? `★ ${Number(book.average_rating).toFixed(1)} · ${book.review_count} review${book.review_count === 1 ? '' : 's'}` : 'No reviews yet';
}
function readingLink(book) {
  if (!book.read_url) return null;
  let url;
  try { url = new URL(book.read_url, location.origin); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
  const link = element('a', 'btn btn-primary read-book-link', 'စာအုပ်ဖတ်ရန် ↗');
  link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer';
  link.setAttribute('aria-label', book.title + ' — စာအုပ်ဖတ်ရန် (tab အသစ်)');
  return link;
}
function cover(book, small = false) {
  const node = element('div', `book-cover cover-${book.color}${small ? ' cover-small' : ''}`);
  node.setAttribute('aria-hidden', 'true');
  if (/^\/covers\/[a-z0-9-]+\.jpg$/.test(book.cover_url || '')) {
    node.classList.add('book-cover-image');
    const image = element('img'); image.src = book.cover_url; image.alt = ''; image.loading = 'lazy';
    node.append(image);
    return node;
  }
  node.append(element('span', 'cover-edition', 'READSHELF EDITION'));
  node.append(element('span', 'cover-title', book.title));
  node.append(element('span', 'cover-line'));
  node.append(element('span', 'cover-author', book.author));
  return node;
}
function renderBooks() {
  const grid = $('#book-grid');
  grid.replaceChildren();
  grid.setAttribute('aria-busy', 'false');
  $('#book-count').textContent = state.books.length;
  $('#review-count').textContent = state.books.reduce((sum, book) => sum + book.review_count, 0);
  if (!state.books.length) {
    const empty = element('div', 'empty-shelf');
    empty.append(element('h3', '', 'A new chapter starts here.'), element('p', '', 'Add your first book and write what you think.'));
    empty.append(button('+ Add your first book', 'btn btn-primary', () => openBookForm()));
    grid.append(empty);
    return;
  }
  for (const book of state.books) {
    const card = element('article', 'book-card');
    const coverButton = button('', 'cover-button', () => openDetails(book.id), `Read reviews of ${book.title}`);
    coverButton.append(cover(book));
    const content = element('div', 'book-card-content');
    content.append(element('p', 'book-author', book.author));
    const title = button(book.title, 'book-title', () => openDetails(book.id));
    content.append(title, element('p', 'rating-summary', ratingText(book)));
    const actions = element('div', 'card-actions');
    actions.append(button('Review ဖတ် / ရေး', 'btn btn-secondary', () => openDetails(book.id)));
    actions.append(button('Edit', 'text-button', () => openBookForm(book), `Edit ${book.title}`));
    content.append(actions);
    const read = readingLink(book);
    if (read) content.append(read);
    card.append(coverButton, content);
    grid.append(card);
  }
}
async function refreshBooks() {
  try { state.books = await api('/books'); renderBooks(); errorBox('#page-error'); }
  catch (error) {
    errorBox('#page-error', error.message);
    $('#book-grid').setAttribute('aria-busy', 'false');
    if (!state.books.length) {
      const retry = element('div', 'empty-shelf');
      retry.append(element('p', '', 'Your bookshelf could not be loaded.'), button('Try again', 'btn btn-secondary', refreshBooks));
      $('#book-grid').replaceChildren(retry);
    }
  }
}
function openBookForm(book = null) {
  if (state.busy) return;
  state.editingBookId = book?.id ?? null;
  $('#book-form-title').textContent = book ? 'Edit book' : 'Add a book';
  $('#book-title').value = book?.title ?? '';
  $('#book-author').value = book?.author ?? '';
  $('#book-description').value = book?.description ?? '';
  $('#book-link').value = book?.read_url ?? '';
  $('#book-color').value = book?.color ?? 'navy';
  errorBox('#book-form-error');
  $('#book-dialog').showModal();
  $('#book-title').focus();
}
async function loadDetails(bookId) {
  const result = await api('/books/' + bookId);
  if (state.selectedId !== bookId) return;
  state.detail = result;
  renderDetails();
}
async function openDetails(bookId) {
  if (state.busy) return;
  state.selectedId = bookId;
  state.editingReviewId = null;
  const loading = element('h2', 'detail-loading', 'Loading book…');
  loading.id = 'detail-title';
  $('#detail-content').replaceChildren(loading);
  if (!$('#detail-dialog').open) $('#detail-dialog').showModal();
  try { await loadDetails(bookId); }
  catch (error) {
    if (state.selectedId !== bookId) return;
    const message = element('p', 'form-error', error.message);
    $('#detail-content').append(message, button('Retry', 'btn btn-secondary', () => openDetails(bookId)));
  }
}
function renderDetails() {
  const { book, reviews } = state.detail;
  const content = $('#detail-content');
  content.replaceChildren();
  const heading = element('div', 'book-detail-heading');
  heading.append(cover(book, true));
  const info = element('div', 'book-detail-info');
  const title = element('h2', '', book.title); title.id = 'detail-title';
  info.append(title, element('p', 'book-author', 'by ' + book.author), element('p', 'rating-summary', ratingText(book)));
  if (book.description) info.append(element('p', 'book-description', book.description));
  const read = readingLink(book);
  if (read) info.append(read);
  const actions = element('div', 'detail-actions');
  actions.append(button('Edit book', 'text-button', () => openBookForm(book)));
  actions.append(button('Delete book', 'text-button danger-text', () => askDelete('Delete this book?', `“${book.title}” and all its reviews will be permanently deleted.`, async () => {
    await api('/books/' + book.id, 'DELETE');
    $('#confirm-dialog').close(); $('#detail-dialog').close();
    state.selectedId = null; state.detail = null;
    notify('Book deleted.');
    await refreshBooks();
  })));
  info.append(actions); heading.append(info); content.append(heading);
  const layout = element('div', 'review-layout');
  const list = element('section', 'review-list');
  list.append(element('h3', '', `Reader reviews (${reviews.length})`));
  if (!reviews.length) {
    const empty = element('div', 'empty-reviews');
    empty.append(element('p', '', 'Be the first to share your thoughts.'), element('span', '', 'A few honest words can help the next reader.'));
    list.append(empty);
  }
  for (const review of reviews) {
    const article = element('article', 'review-card');
    const top = element('div', 'review-top');
    top.append(element('strong', '', review.reviewer));
    const stars = element('span', 'review-stars', '★'.repeat(review.rating) + '☆'.repeat(5 - review.rating));
    stars.setAttribute('aria-label', `${review.rating} out of 5 stars`); top.append(stars);
    article.append(top, element('p', 'review-content', review.content));
    const bottom = element('div', 'review-bottom');
    const time = element('time', '', new Date(review.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }));
    time.dateTime = review.created_at;
    bottom.append(time);
    const controls = element('div', 'review-controls');
    controls.append(button('Edit', 'text-button', () => editReview(review)));
    controls.append(button('Delete', 'text-button danger-text', () => askDelete('Delete this review?', 'This review will be permanently deleted.', async () => {
      await api('/reviews/' + review.id, 'DELETE');
      $('#confirm-dialog').close(); state.editingReviewId = null;
      notify('Review deleted.');
      await refreshBooks();
      await refreshDetailsAfterSave();
    })));
    bottom.append(controls); article.append(bottom); list.append(article);
  }
  layout.append(list, reviewForm()); content.append(layout);
}
function reviewForm() {
  const panel = element('section', 'review-composer');
  const title = element('h3', '', 'Write a review'); title.id = 'review-form-title';
  panel.append(title, element('p', 'composer-intro', 'What stayed with you?'));
  const form = element('form'); form.id = 'review-form';
  const nameLabel = element('label', '', 'Your name'); nameLabel.htmlFor = 'reviewer';
  const name = element('input'); name.id = 'reviewer'; name.name = 'reviewer'; name.required = true; name.maxLength = 80; name.placeholder = 'Enter your name';
  const ratingLabel = element('label', '', 'Rating'); ratingLabel.htmlFor = 'rating';
  const rating = element('select'); rating.id = 'rating'; rating.name = 'rating';
  for (let i = 5; i >= 1; i--) { const option = element('option', '', `${'★'.repeat(i)} · ${i} / 5`); option.value = i; rating.append(option); }
  const contentLabel = element('label', '', 'Your review'); contentLabel.htmlFor = 'review-content';
  const content = element('textarea'); content.id = 'review-content'; content.name = 'content'; content.required = true; content.maxLength = 4000; content.rows = 5; content.placeholder = 'Share your thoughts about this book…';
  const error = element('p', 'form-error'); error.id = 'review-error'; error.setAttribute('role', 'alert'); error.hidden = true;
  const submit = element('button', 'btn btn-primary review-submit', 'Publish review'); submit.type = 'submit'; submit.id = 'review-submit';
  const cancel = button('Cancel editing', 'text-button cancel-review', () => resetReviewForm()); cancel.id = 'cancel-review'; cancel.hidden = true;
  form.append(nameLabel, name, ratingLabel, rating, contentLabel, content, error, submit, cancel);
  form.addEventListener('submit', saveReview);
  panel.append(form); return panel;
}
function editReview(review) {
  if (state.busy) return;
  state.editingReviewId = review.id;
  $('#review-form-title').textContent = 'Edit your review';
  $('#reviewer').value = review.reviewer;
  $('#rating').value = review.rating;
  $('#review-content').value = review.content;
  $('#review-submit').textContent = 'Save changes';
  $('#cancel-review').hidden = false;
  errorBox('#review-error');
  $('#reviewer').focus();
}
function resetReviewForm() {
  state.editingReviewId = null;
  $('#review-form').reset();
  $('#review-form-title').textContent = 'Write a review';
  $('#review-submit').textContent = 'Publish review';
  $('#cancel-review').hidden = true;
  errorBox('#review-error');
}
async function refreshDetailsAfterSave() {
  if (!state.selectedId || !$('#detail-dialog').open) return;
  try { await loadDetails(state.selectedId); }
  catch (error) { notify('Saved. Reload the book to refresh its reviews.'); errorBox('#page-error', error.message); }
}
async function saveReview(event) {
  event.preventDefault(); if (state.busy) return;
  const data = { reviewer: $('#reviewer').value, rating: Number($('#rating').value), content: $('#review-content').value };
  const editing = state.editingReviewId;
  errorBox('#review-error'); busy(true);
  try {
    await api(editing ? '/reviews/' + editing : '/books/' + state.selectedId + '/reviews', editing ? 'PUT' : 'POST', data);
    state.editingReviewId = null;
    resetReviewForm();
    notify(editing ? 'Review updated.' : 'Review published.');
    await refreshBooks(); await refreshDetailsAfterSave();
  } catch (error) { errorBox('#review-error', error.message); }
  finally { busy(false); }
}
function askDelete(title, message, action) {
  if (state.busy) return;
  $('#confirm-title').textContent = title; $('#confirm-message').textContent = message;
  errorBox('#confirm-error'); state.deleteAction = action; $('#confirm-dialog').showModal();
}
$('#confirm-delete').addEventListener('click', async () => {
  if (state.busy || !state.deleteAction) return;
  busy(true); errorBox('#confirm-error');
  try { await state.deleteAction(); state.deleteAction = null; }
  catch (error) { errorBox('#confirm-error', error.message); }
  finally { busy(false); }
});
$('#book-form').addEventListener('submit', async (event) => {
  event.preventDefault(); if (state.busy) return;
  const data = { title: $('#book-title').value, author: $('#book-author').value, description: $('#book-description').value, color: $('#book-color').value, read_url: $('#book-link').value };
  const editing = state.editingBookId;
  errorBox('#book-form-error'); busy(true);
  try {
    await api(editing ? '/books/' + editing : '/books', editing ? 'PUT' : 'POST', data);
    $('#book-dialog').close(); notify(editing ? 'Book updated.' : 'Book added to your shelf.');
    await refreshBooks(); await refreshDetailsAfterSave();
  } catch (error) { errorBox('#book-form-error', error.message); }
  finally { busy(false); }
});
$('#add-book').addEventListener('click', () => openBookForm());
document.querySelectorAll('[data-close]').forEach((node) => node.addEventListener('click', () => {
  if (!state.busy) document.getElementById(node.dataset.close).close();
}));
document.querySelectorAll('dialog').forEach((dialog) => dialog.addEventListener('cancel', (event) => { if (state.busy) event.preventDefault(); }));
$('#detail-dialog').addEventListener('close', () => { state.selectedId = null; state.editingReviewId = null; });
refreshBooks();
