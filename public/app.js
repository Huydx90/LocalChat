'use strict';

/* =========================================================================
 * Chat noi bo - app.js
 * - Auth (JWT trong localStorage)
 * - Ma hoa dau-cuoi AES-GCM: khoa duoc suy ra tu "mat khau phong chat"
 *   (passphrase) ma NGUOI DUNG tu nhap, KHONG BAO GIO gui len server.
 *   Server chi luu/chuyen tiep ciphertext.
 * - WebSocket de nhan tin nhan moi + thay doi trang thai tai khoan realtime.
 * ========================================================================= */

const state = {
  token: localStorage.getItem('chat_token') || null,
  user: null,
  roomKey: null,          // CryptoKey (AES-GCM) suy ra tu passphrase
  ws: null,
  wsReconnectTimer: null,
  userList: [],           // danh sach username da duyet (cho @tag)
  oldestId: null,
  selectedFile: null,
  unreadCount: 0,
  mentionQuery: null,     // vi tri dang go @xxx trong o nhap
  renderedIds: new Set(), // chong render trung khi vua optimistic-render vua nhan lai qua WS
  allowedReactions: ['👍', '❤️', '😂', '😮', '😢', '🙏'],
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
  showToast._timer = setTimeout(() => t.classList.add('hidden'), 1800);
}

/* ------------------------------- API helper ------------------------------ */
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
  if (res.status === 401) {
    logout(false);
    throw new Error('unauthorized');
  }
  if (!res.ok) {
    const err = new Error(data.message || data.error || 'request_failed');
    err.data = data;
    err.status = res.status;
    throw err;
  }
  return data;
}

/* ============================== E2E CRYPTO =============================== */
// Salt co dinh, KHONG bi mat (do khong mang tinh bao mat trong PBKDF2 - tinh
// bao mat den tu passphrase). Doi salt nay se lam mat kha nang giai ma tin cu.
const KDF_SALT = new TextEncoder().encode('noibo-chat-e2e-salt-v1');

function b64FromBuf(buf) {
  let binary = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
function bufFromB64(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function deriveRoomKey(passphrase) {
  const baseKey = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: KDF_SALT, iterations: 150000, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function encryptBytes(key, arrayBuffer) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, arrayBuffer);
  return { iv: b64FromBuf(iv), ciphertext: b64FromBuf(ct) };
}
async function decryptBytes(key, ivB64, ctB64) {
  const iv = new Uint8Array(bufFromB64(ivB64));
  const ct = bufFromB64(ctB64);
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct); // throws if sai passphrase
}
async function encryptText(key, text) {
  return encryptBytes(key, new TextEncoder().encode(text));
}
async function decryptText(key, ivB64, ctB64) {
  const buf = await decryptBytes(key, ivB64, ctB64);
  return new TextDecoder().decode(buf);
}

/* ================================= AUTH ================================= */
function persistToken(token) {
  state.token = token;
  localStorage.setItem('chat_token', token);
}

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
  const savedPass = sessionStorage.getItem('chat_passphrase');
  if (savedPass) {
    deriveRoomKey(savedPass).then((key) => { state.roomKey = key; enterChat(); });
  } else {
    showView('#view-passphrase');
  }
}

function logout(closeSocket = true) {
  state.token = null;
  state.user = null;
  state.roomKey = null;
  localStorage.removeItem('chat_token');
  sessionStorage.removeItem('chat_passphrase');
  if (closeSocket && state.ws) { try { state.ws.close(); } catch {} }
  showView('#view-auth');
}

/* -------- Login form -------- */
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

/* -------- Register form -------- */
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

$('#btn-passphrase-continue').addEventListener('click', async () => {
  const pass = $('#passphrase-input').value;
  if (!pass) return;
  sessionStorage.setItem('chat_passphrase', pass);
  state.roomKey = await deriveRoomKey(pass);
  $('#passphrase-input').value = '';
  enterChat();
});

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
      if (msg.message.sender !== state.user.username && !isChatFocused()) {
        bumpUnread();
      }
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
    if (evt.code === 4001 || evt.code === 4002) return; // unauthorized / bi xoa - khong tu reconnect
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

async function loadMessages(initial) {
  try {
    const data = await api('/api/messages?limit=50');
    if (Array.isArray(data.allowedReactions) && data.allowedReactions.length) {
      state.allowedReactions = data.allowedReactions;
    }
    $('#messages').innerHTML = '';
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

function scrollToBottom() {
  const box = $('#messages');
  box.scrollTop = box.scrollHeight;
}

async function appendMessage(m, autoscroll) {
  if (m.id && state.renderedIds.has(m.id)) return; // da render roi (vd: vua optimistic-render luc gui)
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

  try {
    if (m.msg_type === 'text') {
      const text = await decryptText(state.roomKey, m.iv, m.ciphertext);
      plainTextForCopy = text;
      bubble.innerHTML = renderMentions(escapeHtml(text), m.mentions);
    } else {
      const buf = await decryptBytes(state.roomKey, m.iv, m.ciphertext);
      const blob = new Blob([buf], { type: m.mime_type || 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      if (m.msg_type === 'image') {
        const img = el('img'); img.src = url; img.loading = 'lazy';
        bubble.appendChild(img);
      } else {
        const vid = el('video'); vid.src = url; vid.controls = true;
        bubble.appendChild(vid);
      }
    }
  } catch (err) {
    bubble.innerHTML = '';
    bubble.appendChild(el('span', 'bubble-media-fail', '🔒 Không giải mã được (kiểm tra mật khẩu phòng chat)'));
  }

  const btnRow = el('div', 'bubble-btn-row');
  if (plainTextForCopy !== null) {
    const copyBtn = el('button', 'bubble-copy', '⧉');
    copyBtn.type = 'button';
    copyBtn.title = 'Copy';
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(plainTextForCopy).then(() => showToast('Đã copy'));
    });
    btnRow.appendChild(copyBtn);
  }
  const reactBtn = el('button', 'bubble-react-trigger', '😊');
  reactBtn.type = 'button';
  reactBtn.title = 'Thả cảm xúc';
  reactBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleReactionPicker(row, m.id); });
  btnRow.appendChild(reactBtn);
  bubble.appendChild(btnRow);

  row.appendChild(meta);
  row.appendChild(bubble);
  row.appendChild(buildReactionsBar(m.reactions || []));
  return row;
}

/* -------------------------------- Reactions ------------------------------- */
function buildReactionsBar(reactions) {
  const bar = el('div', 'reactions-bar');
  renderReactionsInto(bar, reactions);
  return bar;
}

function renderReactionsInto(bar, reactions) {
  bar.innerHTML = '';
  const counts = {}; // emoji -> { count, mine }
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
fileInput.addEventListener('change', () => {
  const f = fileInput.files[0];
  if (!f) return;
  if (!/^image\/|^video\//.test(f.type)) { showToast('Chỉ hỗ trợ ảnh hoặc video.'); fileInput.value = ''; return; }
  if (f.size > 15 * 1024 * 1024) { showToast('File tối đa 15MB.'); fileInput.value = ''; return; }
  state.selectedFile = f;
  $('#upload-preview-name').textContent = `📎 ${f.name} (${(f.size / 1024 / 1024).toFixed(1)}MB)`;
  $('#upload-preview').classList.remove('hidden');
});
$('#btn-cancel-upload').addEventListener('click', () => {
  state.selectedFile = null; fileInput.value = '';
  $('#upload-preview').classList.add('hidden');
});

$('#form-send').addEventListener('submit', async (e) => {
  e.preventDefault();
  const sendBtn = document.querySelector('.btn-send');
  try {
    if (state.selectedFile) {
      sendBtn.disabled = true; sendBtn.textContent = 'Đang gửi...';
      const f = state.selectedFile;
      const buf = await f.arrayBuffer();
      const { iv, ciphertext } = await encryptBytes(state.roomKey, buf);
      const msgType = f.type.startsWith('video/') ? 'video' : 'image';
      const res = await api('/api/messages', { method: 'POST', body: { msgType, ciphertext, iv, mimeType: f.type, mentions: [] } });
      // Ve ngay tin nhan vua gui, khong cho WebSocket "vong" lai moi hien -
      // neu socket cua minh dang reconnect thi minh se khong bi mat tin cua chinh minh.
      if (res && res.message) await appendMessage(res.message, true);
      state.selectedFile = null; fileInput.value = '';
      $('#upload-preview').classList.add('hidden');
    } else {
      const text = textInput.value.trim();
      if (!text) return;
      const mentions = extractMentions(text);
      const { iv, ciphertext } = await encryptText(state.roomKey, text);
      const res = await api('/api/messages', { method: 'POST', body: { msgType: 'text', ciphertext, iv, mentions } });
      if (res && res.message) await appendMessage(res.message, true);
      textInput.value = '';
    }
    hideMentionDropdown();
  } catch (err) {
    showToast('Gửi thất bại: ' + (err.message || ''));
  } finally {
    sendBtn.disabled = false; sendBtn.textContent = 'Gửi';
  }
});

function extractMentions(text) {
  const found = new Set();
  const re = /@([a-zA-Z0-9._-]{3,32})/g;
  let match;
  while ((match = re.exec(text))) {
    if (state.userList.includes(match[1]) || match[1] === state.user.username) found.add(match[1]);
  }
  return Array.from(found);
}

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
      approveBtn.addEventListener('click', async () => {
        await api(`/api/admin/users/${u.id}/approve`, { method: 'POST' });
        loadAdminUsers();
      });
      actions.appendChild(approveBtn);
    } else {
      const revokeBtn = el('button', 'btn-revoke', 'Thu hồi');
      revokeBtn.addEventListener('click', async () => {
        await api(`/api/admin/users/${u.id}/revoke`, { method: 'POST' });
        loadAdminUsers();
      });
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
