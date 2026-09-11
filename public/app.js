'use strict';

/* =========================================================================
 * Chat noi bo - app.js
 * MO HINH MA HOA (STEP nay): server ma hoa/giai ma bang AES-256-GCM, KHONG
 * con la E2EE. Du lieu truyen tai duoc bao ve boi HTTPS/WSS (TLS). Client chi
 * gui plaintext qua ket noi da ma hoa TLS toi server; server luu ciphertext.
 * ========================================================================= */

const state = {
  token: localStorage.getItem('chat_token') || null,
  user: null,
  ws: null,
  wsReconnectTimer: null,
  userList: [],
  oldestId: null,
  selectedFile: null,      // File/Blob da san sang de upload (anh da nen / video da kiem tra)
  unreadCount: 0,
  renderedIds: new Set(),
  allowedReactions: ['👍', '❤️', '😂', '😮', '😢', '🙏'],
  limits: { maxImageBytes: 512000, maxVideoBytes: 10485760 }, // se duoc dong bo lai tu server
};

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

/* ---------------------------- View switching ---------------------------- */
function showView(id) {
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  $(id).classList.remove('hidden');
}
function showToast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => t.classList.add('hidden'), 2200);
}

/* ------------------------------- API helpers ------------------------------ */
async function api(path, opts = {}) {
  const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  if (state.token) headers['Authorization'] = 'Bearer ' + state.token;
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch {}
  if (res.status === 401) { logout(false); throw new Error('unauthorized'); }
  if (!res.ok) {
    const err = new Error(data.message || data.error || 'request_failed');
    err.data = data; err.status = res.status;
    throw err;
  }
  return data;
}

// Upload multipart (anh/video) - KHONG dung JSON/base64 de tranh phinh payload + RAM.
async function apiUpload(path, file) {
  const form = new FormData();
  form.append('file', file, file.name || 'upload');
  const headers = {};
  if (state.token) headers['Authorization'] = 'Bearer ' + state.token;
  const res = await fetch(path, { method: 'POST', headers, body: form });
  let data = {};
  try { data = await res.json(); } catch {}
  if (res.status === 401) { logout(false); throw new Error('unauthorized'); }
  if (!res.ok) {
    const err = new Error(data.message || data.error || 'upload_failed');
    err.data = data; err.status = res.status;
    throw err;
  }
  return data;
}

/* ================================= AUTH ================================= */
function persistToken(token) { state.token = token; localStorage.setItem('chat_token', token); }

async function bootstrap() {
  if (!state.token) { showView('#view-auth'); return; }
  try {
    const { user, token } = await api('/api/auth/me');
    persistToken(token);
    state.user = user;
    routeByStatus();
  } catch {
    showView('#view-auth');
  }
}

function routeByStatus() {
  if (state.user.role !== 'admin' && state.user.status !== 'approved') {
    $('#pending-username').textContent = state.user.username;
    showView('#view-pending');
    return;
  }
  enterChat();
}

function logout(closeSocket = true) {
  state.token = null;
  state.user = null;
  localStorage.removeItem('chat_token');
  if (closeSocket && state.ws) { try { state.ws.close(); } catch {} }
  showView('#view-auth');
}

$('#form-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#login-error').textContent = '';
  try {
    const data = await api('/api/auth/login', {
      method: 'POST',
      body: { username: $('#login-username').value.trim(), password: $('#login-password').value }
    });
    persistToken(data.token);
    state.user = data.user;
    routeByStatus();
  } catch (err) {
    $('#login-error').textContent = (err.data && err.data.message) || 'Đăng nhập thất bại.';
  }
});

$('#form-register').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#register-error').textContent = '';
  try {
    await api('/api/auth/register', {
      method: 'POST',
      body: { username: $('#reg-username').value.trim(), password: $('#reg-password').value }
    });
    showToast('Đăng ký thành công! Vui lòng đăng nhập sau khi được admin duyệt.');
    document.querySelector('.tab-btn[data-tab="login"]').click();
    $('#login-username').value = $('#reg-username').value.trim();
    $('#form-register').reset();
  } catch (err) {
    $('#register-error').textContent = (err.data && err.data.message) || 'Đăng ký thất bại.';
  }
});

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));
    $(`#form-${btn.dataset.tab}`).classList.remove('hidden');
  });
});

$('#btn-pending-refresh').addEventListener('click', bootstrap);
$('#btn-pending-logout').addEventListener('click', () => logout());
$('#btn-logout').addEventListener('click', () => logout());

/* ============================== CHAT ENTRY =============================== */
function enterChat() {
  $('#chat-username').textContent = '@' + state.user.username;
  $('#btn-admin').classList.toggle('hidden', state.user.role !== 'admin');
  showView('#view-chat');
  connectWebSocket();
  loadUserList();
  loadMessages(true);
}

/* ------------------------------ WebSocket -------------------------------- */
function connectWebSocket() {
  if (state.ws) { try { state.ws.close(); } catch {} }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(state.token)}`);
  state.ws = ws;

  ws.onmessage = async (evt) => {
    let msg;
    try { msg = JSON.parse(evt.data); } catch { return; }

    if (msg.type === 'new_message') {
      await appendMessage(msg.message, true);
      if (msg.message.sender !== state.user.username && !isChatFocused()) bumpUnread();
    } else if (msg.type === 'status_changed') {
      if (msg.status === 'approved') {
        showToast('Tài khoản của bạn đã được duyệt!');
        state.user.status = 'approved';
        routeByStatus();
      } else {
        showToast('Quyền truy cập của bạn đã bị thu hồi.');
        state.user.status = 'pending';
        routeByStatus();
      }
    } else if (msg.type === 'account_deleted') {
      showToast('Tài khoản của bạn đã bị xóa bởi admin.');
      logout(false);
    } else if (msg.type === 'user_registered') {
      if (!$('#view-admin').classList.contains('hidden')) loadAdminUsers();
      showToast(`Người dùng mới đăng ký: ${msg.username}`);
    } else if (msg.type === 'reaction_updated') {
      updateReactionsUI(msg.messageId, msg.reactions);
    }
  };

  ws.onclose = (evt) => {
    if (evt.code === 4001 || evt.code === 4002) return;
    clearTimeout(state.wsReconnectTimer);
    state.wsReconnectTimer = setTimeout(() => { if (state.token) connectWebSocket(); }, 3000);
  };
}

function isChatFocused() {
  return document.hasFocus() && !$('#view-chat').classList.contains('hidden') && isScrolledToBottom();
}
function isScrolledToBottom() {
  const box = $('#messages');
  return box.scrollHeight - box.scrollTop - box.clientHeight < 80;
}
function bumpUnread() {
  state.unreadCount++;
  const b = $('#badge-unread');
  b.textContent = state.unreadCount;
  b.classList.remove('hidden');
  document.title = `(${state.unreadCount}) Chat nội bộ`;
}
function clearUnread() {
  state.unreadCount = 0;
  $('#badge-unread').classList.add('hidden');
  document.title = 'Chat nội bộ';
}
$('#messages').addEventListener('scroll', () => { if (isScrolledToBottom()) clearUnread(); });
window.addEventListener('focus', () => { if (isScrolledToBottom()) clearUnread(); });

/* ------------------------------ User list -------------------------------- */
async function loadUserList() {
  try {
    const data = await api('/api/users');
    state.userList = data.users.filter(u => u !== state.user.username);
  } catch {}
}

/* ------------------------------- Messages -------------------------------- */
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function formatTime(iso) {
  const d = new Date(iso);
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())} ${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;
}
function renderMentions(escapedText, mentions) {
  if (!mentions || mentions.length === 0) return escapedText;
  let out = escapedText;
  mentions.forEach(name => {
    const safe = escapeHtml(name);
    out = out.split('@' + safe).join(`<span class="mention">@${safe}</span>`);
  });
  return out;
}

async function loadMessages() {
  try {
    const data = await api('/api/messages?limit=50');
    if (Array.isArray(data.allowedReactions) && data.allowedReactions.length) state.allowedReactions = data.allowedReactions;
    if (data.maxImageBytes) state.limits.maxImageBytes = data.maxImageBytes;
    if (data.maxVideoBytes) state.limits.maxVideoBytes = data.maxVideoBytes;
    $('#messages').innerHTML = '';
    state.renderedIds.clear();
    for (const m of data.messages) await appendMessage(m, false);
    if (data.messages.length > 0) state.oldestId = data.messages[0].id;
    $('#btn-load-more').classList.toggle('hidden', data.messages.length < 50);
    scrollToBottom();
  } catch (err) {
    console.error(err);
  }
}

$('#btn-load-more').addEventListener('click', async () => {
  if (!state.oldestId) return;
  const box = $('#messages');
  const prevHeight = box.scrollHeight;
  const data = await api(`/api/messages?limit=50&beforeId=${state.oldestId}`);
  if (data.messages.length === 0) { $('#btn-load-more').classList.add('hidden'); return; }
  const frag = document.createDocumentFragment();
  for (const m of data.messages) {
    if (m.id) state.renderedIds.add(m.id);
    frag.appendChild(await buildBubble(m));
  }
  box.insertBefore(frag, box.firstChild);
  state.oldestId = data.messages[0].id;
  box.scrollTop = box.scrollHeight - prevHeight;
});

function scrollToBottom() { const box = $('#messages'); box.scrollTop = box.scrollHeight; }

async function appendMessage(m, autoscroll) {
  if (m.id && state.renderedIds.has(m.id)) return;
  if (m.id) state.renderedIds.add(m.id);
  const box = $('#messages');
  const wasAtBottom = isScrolledToBottom();
  box.appendChild(await buildBubble(m));
  if (autoscroll && wasAtBottom) scrollToBottom();
  if (!autoscroll) scrollToBottom();
}

async function buildBubble(m) {
  const mine = m.sender === state.user.username;
  const row = el('div', `bubble-row ${mine ? 'mine' : 'theirs'}`);
  row.dataset.messageId = m.id;
  const meta = el('div', 'bubble-meta', `${mine ? 'Bạn' : m.sender} · ${formatTime(m.created_at)}`);
  const bubble = el('div', 'bubble');

  let plainTextForCopy = null;
  if (m.msg_type === 'text') {
    plainTextForCopy = m.text != null ? m.text : '';
    bubble.innerHTML = renderMentions(escapeHtml(plainTextForCopy), m.mentions);
  } else if (m.msg_type === 'image') {
    const img = el('img'); img.alt = 'Ảnh đính kèm'; img.loading = 'lazy';
    bubble.appendChild(img);
    loadMediaInto(img, m.id);
  } else if (m.msg_type === 'video') {
    const vid = el('video'); vid.controls = true;
    bubble.appendChild(vid);
    loadMediaInto(vid, m.id);
  }

  const btnRow = el('div', 'bubble-btn-row');
  if (plainTextForCopy !== null) {
    const copyBtn = el('button', 'bubble-copy', '⧉');
    copyBtn.type = 'button'; copyBtn.title = 'Copy';
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(plainTextForCopy).then(() => showToast('Đã copy'));
    });
    btnRow.appendChild(copyBtn);
  }
  const reactBtn = el('button', 'bubble-react-trigger', '😊');
  reactBtn.type = 'button'; reactBtn.title = 'Thả cảm xúc';
  reactBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleReactionPicker(row, m.id); });
  btnRow.appendChild(reactBtn);
  bubble.appendChild(btnRow);

  row.appendChild(meta);
  row.appendChild(bubble);
  row.appendChild(buildReactionsBar(m.reactions || []));
  return row;
}

// Tai noi dung anh/video qua endpoint rieng (server giai ma AES-256-GCM roi tra ve).
// Dung fetch + Authorization header (khong nhet token vao URL) roi tao blob URL.
async function loadMediaInto(mediaEl, messageId) {
  try {
    const res = await fetch(`/api/messages/${messageId}/media`, {
      headers: { Authorization: 'Bearer ' + state.token }
    });
    if (!res.ok) throw new Error('fetch_failed');
    const blob = await res.blob();
    mediaEl.src = URL.createObjectURL(blob);
  } catch (err) {
    const fail = el('span', 'bubble-media-fail', '⚠️ Không tải được file này.');
    mediaEl.replaceWith(fail);
  }
}

/* -------------------------------- Reactions ------------------------------- */
function buildReactionsBar(reactions) {
  const bar = el('div', 'reactions-bar');
  renderReactionsInto(bar, reactions);
  return bar;
}
function renderReactionsInto(bar, reactions) {
  bar.innerHTML = '';
  const counts = {};
  reactions.forEach(r => {
    if (!counts[r.emoji]) counts[r.emoji] = { count: 0, mine: false };
    counts[r.emoji].count++;
    if (r.username === state.user.username) counts[r.emoji].mine = true;
  });
  Object.entries(counts).forEach(([emoji, info]) => {
    const pill = el('button', `reaction-pill${info.mine ? ' mine' : ''}`, `${emoji} ${info.count}`);
    pill.type = 'button';
    pill.addEventListener('click', () => {
      const row = bar.closest('.bubble-row');
      sendReaction(row.dataset.messageId, emoji);
    });
    bar.appendChild(pill);
  });
}
function updateReactionsUI(messageId, reactions) {
  const row = document.querySelector(`.bubble-row[data-message-id="${messageId}"]`);
  if (!row) return;
  const bar = row.querySelector('.reactions-bar');
  if (bar) renderReactionsInto(bar, reactions);
}
let activePickerRow = null;
function toggleReactionPicker(row, messageId) {
  closeReactionPicker();
  if (activePickerRow === row) { activePickerRow = null; return; }
  const picker = el('div', 'reaction-picker');
  state.allowedReactions.forEach(emoji => {
    const opt = el('button', 'reaction-picker-opt', emoji);
    opt.type = 'button';
    opt.addEventListener('click', () => { sendReaction(messageId, emoji); closeReactionPicker(); });
    picker.appendChild(opt);
  });
  row.querySelector('.bubble').appendChild(picker);
  activePickerRow = row;
  setTimeout(() => document.addEventListener('click', closeReactionPickerOnce), 0);
}
function closeReactionPickerOnce() { closeReactionPicker(); }
function closeReactionPicker() {
  document.removeEventListener('click', closeReactionPickerOnce);
  document.querySelectorAll('.reaction-picker').forEach(p => p.remove());
  activePickerRow = null;
}
async function sendReaction(messageId, emoji) {
  try {
    const data = await api(`/api/messages/${messageId}/react`, { method: 'POST', body: { emoji } });
    updateReactionsUI(messageId, data.reactions);
  } catch (err) {
    showToast('Không thả được cảm xúc.');
  }
}

/* ------------------------------- Composer --------------------------------- */
const textInput = $('#text-input');
const fileInput = $('#file-input');

$('#btn-attach').addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', async () => {
  const f = fileInput.files[0];
  if (!f) return;

  if (/^image\//.test(f.type)) {
    if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(f.type)) {
      showToast('Định dạng ảnh không được hỗ trợ.'); fileInput.value = ''; return;
    }
    showToast('Ảnh đang được nén...');
    try {
      const compact = await prepareImageForUpload(f);
      state.selectedFile = compact;
      $('#upload-preview-name').textContent = `📎 ${compact.name} (${Math.ceil(compact.size / 1024)}KB)`;
      $('#upload-preview').classList.remove('hidden');
      showToast(`Ảnh đã được nén còn ${Math.ceil(compact.size / 1024)} KB`);
    } catch (err) {
      showToast(err.message || 'Ảnh quá lớn, không thể nén xuống dưới 500 KB.');
      fileInput.value = '';
    }
  } else if (/^video\//.test(f.type)) {
    if (!['video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska'].includes(f.type)) {
      showToast('Định dạng video không được hỗ trợ.'); fileInput.value = ''; return;
    }
    if (f.size > state.limits.maxVideoBytes) {
      showToast('Video phải có dung lượng không quá 10 MB.');
      fileInput.value = ''; return;
    }
    state.selectedFile = f;
    $('#upload-preview-name').textContent = `📎 ${f.name} (${(f.size / 1024 / 1024).toFixed(1)}MB)`;
    $('#upload-preview').classList.remove('hidden');
  } else {
    showToast('Chỉ hỗ trợ ảnh hoặc video.'); fileInput.value = '';
  }
});

$('#btn-cancel-upload').addEventListener('click', () => {
  state.selectedFile = null; fileInput.value = '';
  $('#upload-preview').classList.add('hidden');
});

/* ---- Nen anh phia client: resize + giam quality lap lai cho toi khi <=500KB ---- */
async function loadImageBitmap(file) {
  if (window.createImageBitmap) {
    try { return await createImageBitmap(file); } catch { /* fall through to <img> */ }
  }
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Không đọc được ảnh.'));
    img.src = URL.createObjectURL(file);
  });
}
function canvasToBlob(source, width, height, quality) {
  return new Promise((resolve, reject) => {
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(source, 0, 0, width, height);
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Không nén được ảnh.')), 'image/jpeg', quality);
  });
}
function blobToFile(blob, originalName) {
  const base = (originalName || 'image').replace(/\.[^./]+$/, '');
  return new File([blob], `${base}.jpg`, { type: 'image/jpeg' });
}

async function prepareImageForUpload(file) {
  const TARGET = state.limits.maxImageBytes;
  // Da du nho va dung dinh dang pho bien -> khong can nen lai, gui thang
  if (file.size <= TARGET && ['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
    return file;
  }
  const source = await loadImageBitmap(file);
  let width = source.width || source.naturalWidth;
  let height = source.height || source.naturalHeight;
  const MAX_DIMENSION = 1600;
  if (Math.max(width, height) > MAX_DIMENSION) {
    const scale = MAX_DIMENSION / Math.max(width, height);
    width = Math.round(width * scale);
    height = Math.round(height * scale);
  }

  const MAX_ATTEMPTS = 10;
  const MIN_DIMENSION = 240;
  let quality = 0.82;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const blob = await canvasToBlob(source, width, height, quality);
    if (blob.size <= TARGET) return blobToFile(blob, file.name);
    if (quality > 0.35) {
      quality -= 0.12; // giam quality truoc
    } else if (width > MIN_DIMENSION && height > MIN_DIMENSION) {
      width = Math.round(width * 0.82); // het co giam quality thi giam kich thuoc
      height = Math.round(height * 0.82);
      quality = 0.6;
    } else {
      break; // da cham gioi han toi thieu hop ly, dung lai
    }
  }
  throw new Error('Ảnh quá lớn, không thể nén xuống dưới 500 KB.');
}

$('#form-send').addEventListener('submit', async (e) => {
  e.preventDefault();
  const sendBtn = document.querySelector('.btn-send');
  try {
    sendBtn.disabled = true;
    if (state.selectedFile) {
      sendBtn.textContent = 'Đang gửi...';
      const res = await apiUpload('/api/messages/media', state.selectedFile);
      if (res && res.message) await appendMessage(res.message, true);
      state.selectedFile = null; fileInput.value = '';
      $('#upload-preview').classList.add('hidden');
    } else {
      const text = textInput.value.trim();
      if (!text) return;
      const res = await api('/api/messages', { method: 'POST', body: { text } });
      if (res && res.message) await appendMessage(res.message, true);
      textInput.value = '';
    }
    hideMentionDropdown();
  } catch (err) {
    showToast('Gửi thất bại: ' + ((err.data && err.data.message) || err.message || ''));
  } finally {
    sendBtn.disabled = false; sendBtn.textContent = 'Gửi';
  }
});

/* --------------------------- @mention autocomplete ------------------------ */
const mentionBox = $('#mention-dropdown');
function hideMentionDropdown() { mentionBox.classList.add('hidden'); mentionBox.innerHTML = ''; }

textInput.addEventListener('input', () => {
  const cursor = textInput.selectionStart;
  const upToCursor = textInput.value.slice(0, cursor);
  const atMatch = upToCursor.match(/@([a-zA-Z0-9._-]*)$/);
  if (!atMatch) { hideMentionDropdown(); return; }
  const query = atMatch[1].toLowerCase();
  const results = state.userList.filter(u => u.toLowerCase().startsWith(query)).slice(0, 6);
  if (results.length === 0) { hideMentionDropdown(); return; }
  mentionBox.innerHTML = '';
  results.forEach(name => {
    const item = el('div', 'mention-item', '@' + name);
    item.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const before = upToCursor.slice(0, atMatch.index);
      const after = textInput.value.slice(cursor);
      textInput.value = `${before}@${name} ${after}`;
      textInput.focus();
      hideMentionDropdown();
    });
    mentionBox.appendChild(item);
  });
  mentionBox.classList.remove('hidden');
});
textInput.addEventListener('blur', () => setTimeout(hideMentionDropdown, 150));

/* ================================= ADMIN ================================= */
$('#btn-admin').addEventListener('click', () => { showView('#view-admin'); loadAdminUsers(); });
$('#btn-admin-close').addEventListener('click', () => showView('#view-chat'));

async function loadAdminUsers() {
  const list = $('#admin-list');
  list.innerHTML = '<p class="hint">Đang tải...</p>';
  try {
    const data = await api('/api/admin/users');
    list.innerHTML = '';
    data.users.forEach(u => list.appendChild(buildAdminRow(u)));
  } catch {
    list.innerHTML = '<p class="hint">Không tải được danh sách.</p>';
  }
}
function buildAdminRow(u) {
  const row = el('div', 'admin-row');
  const info = el('div', 'info');
  info.appendChild(el('span', 'uname', u.username + (u.role === 'admin' ? ' (admin)' : '')));
  const pill = el('span', `status-pill status-${u.status}`, u.status === 'approved' ? 'Đã duyệt' : 'Chờ duyệt');
  info.appendChild(pill);
  info.appendChild(el('span', 'meta', new Date(u.created_at).toLocaleString('vi-VN')));
  row.appendChild(info);

  if (u.role !== 'admin') {
    const actions = el('div', 'actions');
    if (u.status === 'pending') {
      const approveBtn = el('button', 'btn-approve', 'Duyệt');
      approveBtn.addEventListener('click', async () => { await api(`/api/admin/users/${u.id}/approve`, { method: 'POST' }); loadAdminUsers(); });
      actions.appendChild(approveBtn);
    } else {
      const revokeBtn = el('button', 'btn-revoke', 'Thu hồi');
      revokeBtn.addEventListener('click', async () => { await api(`/api/admin/users/${u.id}/revoke`, { method: 'POST' }); loadAdminUsers(); });
      actions.appendChild(revokeBtn);
    }
    const delBtn = el('button', 'btn-delete', 'Xóa');
    delBtn.addEventListener('click', async () => {
      if (!confirm(`Xóa tài khoản "${u.username}"? Hành động này không thể hoàn tác.`)) return;
      await api(`/api/admin/users/${u.id}`, { method: 'DELETE' });
      loadAdminUsers();
    });
    actions.appendChild(delBtn);
    row.appendChild(actions);
  }
  return row;
}

/* ================================= START ================================== */
bootstrap();
