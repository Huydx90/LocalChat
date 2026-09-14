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
  allowedReactions: ['👍', '❤️', '😂', '😮', '😢', '😡', '🎉'], // gia tri mac dinh truoc khi sync tu server (xem loadMessages)
  limits: { maxImageBytes: 512000, maxVideoBytes: 10485760 }, // se duoc dong bo lai tu server
  replyTarget: null, // { id, sender, preview } - dang chuan bi tra loi tin nhan nao (null = khong reply)
  newestId: null,    // id tin nhan moi nhat da render - dung cho polling fallback (afterId)
  wsFailCount: 0,    // dem so lan WS that bai lien tiep - chi toast canh bao 1 lan, khong spam
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
async function apiUpload(path, file, replyToId) {
  const form = new FormData();
  form.append('file', file, file.name || 'upload');
  if (replyToId) form.append('replyToId', String(replyToId));
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
  stopPolling();
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
  startPolling();
  loadUserList();
  loadMessages(true);
}

/* ------------------------------ WebSocket -------------------------------- */
function connectWebSocket() {
  if (state.ws) { try { state.ws.close(); } catch {} }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(state.token)}`);
  state.ws = ws;

  ws.onopen = () => { state.wsFailCount = 0; };

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
    } else if (msg.type === 'message_deleted') {
      removeMessageFromDOM(msg.id);
    }
  };

  ws.onclose = (evt) => {
    if (evt.code === 4001 || evt.code === 4002 || evt.code === 4003) return;
    state.wsFailCount++;
    if (state.wsFailCount === 3) {
      showToast('Không kết nối được realtime (WebSocket) - đang dùng cập nhật định kỳ (~4s/lần). Mạng của bạn có thể đang chặn WebSocket.');
    }
    clearTimeout(state.wsReconnectTimer);
    state.wsReconnectTimer = setTimeout(() => { if (state.token) connectWebSocket(); }, 3000);
  };
}

/* --------------------------- Polling fallback (khi WS bị chặn) --------------------------- *
 * Mot so mang (vd mang cong ty) chan wss:// nhung van cho https:// di qua binh thuong.
 * Khi do WebSocket se lien tuc that bai (xem ws.onclose o tren). De tin nhan van cap nhat
 * gan-realtime trong truong hop nay, client tu hoi dinh ky qua REST API binh thuong
 * (GET /api/messages?afterId=...) - dung DUNG giao thuc HTTPS da chung minh la khong bi
 * chan (vi load tin nhan/gui tin nhan van hoat dong binh thuong qua HTTP).
 * Chi thuc su goi poll khi WS KHONG o trang thai OPEN, de tranh goi thua khi WS dang chay tot. */
let pollTimer = null;
const POLL_INTERVAL_MS = 4000;
function startPolling() {
  stopPolling();
  pollTimer = setInterval(async () => {
    if (!state.token || $('#view-chat').classList.contains('hidden')) return;
    if (state.ws && state.ws.readyState === WebSocket.OPEN) return; // WS dang chay tot, khong can poll
    try { await pollForNewMessages(); } catch { /* im lang, thu lai chu ky sau */ }
  }, POLL_INTERVAL_MS);
}
function stopPolling() { clearInterval(pollTimer); pollTimer = null; }

async function pollForNewMessages() {
  if (state.newestId == null) return;
  const data = await api(`/api/messages?afterId=${state.newestId}&limit=100`);
  for (const m of data.messages) {
    await appendMessage(m, true);
    if (m.sender !== state.user.username && !isChatFocused()) bumpUnread();
  }
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
    state.newestId = null;
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
  if (m.id && (state.newestId == null || m.id > state.newestId)) state.newestId = m.id;
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
  row.dataset.sender = m.sender; // dung khi nguoi khac bam "Tra loi" tin nay
  const meta = el('div', 'bubble-meta', `${mine ? 'Bạn' : m.sender} · ${formatTime(m.created_at)}`);
  const bubble = el('div', 'bubble');

  const quote = buildReplyQuoteBlock(m);
  if (quote) bubble.appendChild(quote);

  let plainTextForCopy = null;
  if (m.msg_type === 'text') {
    plainTextForCopy = m.text != null ? m.text : '';
    const textEl = el('span');
    textEl.innerHTML = renderMentions(escapeHtml(plainTextForCopy), m.mentions);
    bubble.appendChild(textEl);
    if (isEmojiOnlyMessage(plainTextForCopy)) bubble.classList.add('bubble-emoji-only');
    row.dataset.preview = plainTextForCopy.length > 140 ? plainTextForCopy.slice(0, 140) + '…' : plainTextForCopy;
  } else if (m.msg_type === 'image') {
    const img = el('img'); img.alt = 'Ảnh đính kèm'; img.loading = 'lazy';
    img.addEventListener('dblclick', (e) => { e.stopPropagation(); if (img.src) openMediaLightbox('image', img.src); });
    bubble.appendChild(img);
    loadMediaInto(img, m.id);
    row.dataset.preview = '📷 Hình ảnh';
  } else if (m.msg_type === 'video') {
    // Chi hien khung preview (khong controls) - double-click de mo lon giua man hinh.
    const wrap = el('div', 'video-preview-wrap');
    const vid = el('video'); vid.muted = true; vid.playsInline = true; vid.preload = 'metadata';
    const playIcon = el('div', 'video-play-icon', '▶');
    wrap.appendChild(vid); wrap.appendChild(playIcon);
    wrap.addEventListener('dblclick', (e) => { e.stopPropagation(); if (vid.src) openMediaLightbox('video', vid.src); });
    bubble.appendChild(wrap);
    loadMediaInto(vid, m.id);
    row.dataset.preview = '🎥 Video';
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
  attachBubbleContextMenu(bubble, m.id);
  return row;
}

// ---- Reply: khoi trich dan hien trong bubble (neu tin nay la mot reply) ----
function buildReplyQuoteBlock(m) {
  if (!m.reply_to_sender && !m.reply_to_preview) return null;
  const q = el('div', 'reply-quote');
  const senderLabel = m.reply_to_sender === state.user.username ? 'Bạn' : (m.reply_to_sender || 'Người dùng');
  q.appendChild(el('span', 'reply-quote-sender', senderLabel));
  q.appendChild(el('span', 'reply-quote-text', m.reply_to_preview || ''));
  if (m.reply_to_id) {
    q.classList.add('clickable');
    q.addEventListener('click', (e) => { e.stopPropagation(); scrollToMessage(m.reply_to_id); });
  }
  return q;
}
function scrollToMessage(messageId) {
  const row = document.querySelector(`.bubble-row[data-message-id="${messageId}"]`);
  if (!row) { showToast('Không tìm thấy tin nhắn gốc (có thể đã cũ hoặc bị xóa).'); return; }
  row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  row.classList.remove('flash-highlight');
  void row.offsetWidth; // force reflow de restart animation neu bam nhieu lan lien tiep
  row.classList.add('flash-highlight');
  setTimeout(() => row.classList.remove('flash-highlight'), 1200);
}

/* ---------------------- Submenu chuột phải / giữ (context menu) ---------------------- */
// Kich hoat qua: click chuot phai (contextmenu), GIU chuot trai (mousedown ~500ms),
// hoac cham giu tren cam ung (touchstart ~500ms) - dung 1 ham showContextMenu chung.
const contextMenu = $('#context-menu');
function hideContextMenu() {
  contextMenu.classList.add('hidden');
  contextMenu.innerHTML = '';
  document.removeEventListener('click', hideContextMenuOnce);
  window.removeEventListener('scroll', hideContextMenuOnce, true);
}
function hideContextMenuOnce() { hideContextMenu(); }
function showContextMenu(x, y, messageId) {
  hideContextMenu();
  const replyItem = el('button', 'context-menu-item', '↩️ Trả lời');
  replyItem.type = 'button';
  replyItem.addEventListener('click', () => { hideContextMenu(); startReply(messageId); });
  contextMenu.appendChild(replyItem);

  if (state.user && state.user.role === 'admin') {
    const delItem = el('button', 'context-menu-item danger', '🗑 Xóa');
    delItem.type = 'button';
    delItem.addEventListener('click', () => { hideContextMenu(); deleteMessage(messageId); });
    contextMenu.appendChild(delItem);
  }

  contextMenu.style.left = '-9999px'; contextMenu.style.top = '-9999px';
  contextMenu.classList.remove('hidden');
  const rect = contextMenu.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  const left = Math.max(8, Math.min(x, vw - rect.width - 8));
  const top = Math.max(8, Math.min(y, vh - rect.height - 8));
  contextMenu.style.left = left + 'px';
  contextMenu.style.top = top + 'px';
  setTimeout(() => {
    document.addEventListener('click', hideContextMenuOnce);
    window.addEventListener('scroll', hideContextMenuOnce, true);
  }, 0);
}
const LONG_PRESS_MS = 500;
function attachBubbleContextMenu(bubble, messageId) {
  bubble.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, messageId);
  });
  let pressTimer = null;
  let pressStart = null;
  const startPress = (x, y) => {
    pressStart = { x, y };
    pressTimer = setTimeout(() => showContextMenu(x, y, messageId), LONG_PRESS_MS);
  };
  const cancelPress = () => { clearTimeout(pressTimer); pressTimer = null; pressStart = null; };
  bubble.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return; // chi chuot trai - chuot phai da co contextmenu o tren
    startPress(e.clientX, e.clientY);
  });
  ['mouseup', 'mouseleave'].forEach(ev => bubble.addEventListener(ev, cancelPress));
  bubble.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    startPress(t.clientX, t.clientY);
  }, { passive: true });
  ['touchend', 'touchcancel'].forEach(ev => bubble.addEventListener(ev, cancelPress));
  bubble.addEventListener('touchmove', (e) => {
    if (!pressStart) return;
    const t = e.touches[0];
    if (Math.abs(t.clientX - pressStart.x) > 10 || Math.abs(t.clientY - pressStart.y) > 10) cancelPress();
  }, { passive: true });
}

/* -------------------------------- Reply UI -------------------------------- */
function startReply(messageId) {
  const row = document.querySelector(`.bubble-row[data-message-id="${messageId}"]`);
  if (!row) return;
  state.replyTarget = {
    id: Number(messageId),
    sender: row.dataset.sender || '',
    preview: row.dataset.preview || ''
  };
  renderReplyPreviewBar();
  textInput.focus();
}
function renderReplyPreviewBar() {
  const bar = $('#reply-preview');
  if (!state.replyTarget) { bar.classList.add('hidden'); return; }
  $('#reply-preview-sender').textContent = state.replyTarget.sender === state.user.username ? 'Bạn' : state.replyTarget.sender;
  $('#reply-preview-text').textContent = state.replyTarget.preview;
  bar.classList.remove('hidden');
}
$('#btn-cancel-reply').addEventListener('click', () => {
  state.replyTarget = null;
  renderReplyPreviewBar();
});

/* -------------------------------- Xóa tin nhắn (admin) --------------------------------- */
async function deleteMessage(messageId) {
  if (!confirm('Xóa tin nhắn này? Hành động này không thể hoàn tác.')) return;
  try {
    await api(`/api/messages/${messageId}`, { method: 'DELETE' });
    removeMessageFromDOM(messageId);
  } catch (err) {
    showToast('Không xóa được tin nhắn: ' + ((err.data && err.data.message) || err.message || ''));
  }
}
function removeMessageFromDOM(messageId) {
  const row = document.querySelector(`.bubble-row[data-message-id="${messageId}"]`);
  if (row) {
    // STEP 4 (performance): giai phong object URL (anh/video, tao boi
    // loadMediaInto() qua URL.createObjectURL()) TRUOC khi xoa khoi DOM -
    // neu khong, trinh duyet se giu tham chieu blob nay trong bo nho vo han
    // (memory leak) du DOM node da bi go bo. Ap dung cho MOI <img>/<video>
    // con trong hang tin nhan nay (kha nang co ca preview reply-quote sau nay).
    row.querySelectorAll('img[src^="blob:"], video[src^="blob:"]').forEach((mediaEl) => {
      try { URL.revokeObjectURL(mediaEl.src); } catch { /* bo qua - khong quan trong */ }
    });
    row.remove();
  }
  state.renderedIds.delete(Number(messageId));
}

/* -------------------------- Lightbox xem ảnh/video phóng to -------------------------- */
function openMediaLightbox(kind, src) {
  const content = $('#lightbox-content');
  content.innerHTML = '';
  if (kind === 'image') {
    const img = el('img'); img.src = src; img.alt = 'Ảnh phóng to';
    content.appendChild(img);
  } else {
    const vid = el('video'); vid.src = src; vid.controls = true; vid.autoplay = true; vid.playsInline = true;
    content.appendChild(vid);
  }
  $('#media-lightbox').classList.remove('hidden');
}
function closeMediaLightbox() {
  const content = $('#lightbox-content');
  content.querySelectorAll('video').forEach(v => { try { v.pause(); } catch {} });
  content.innerHTML = '';
  $('#media-lightbox').classList.add('hidden');
}
$('#btn-lightbox-close').addEventListener('click', closeMediaLightbox);
$('#media-lightbox').addEventListener('click', (e) => {
  if (e.target.id === 'media-lightbox') closeMediaLightbox();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#media-lightbox').classList.contains('hidden')) closeMediaLightbox();
});

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

/* -------------------------- Emotion (emoji picker) ------------------------ */
// STEP NEXT (Emotion): gui emoji nhu 1 text message BINH THUONG - di qua dung
// pipeline encrypt/retention/WebSocket hien co, khong tao bang/API rieng.
const EMOJI_CATEGORIES = [
  { name: 'Mặt cười', list: ['😀','😃','😄','😁','😆','😅','😂','🤣','😊','😇','🙂','🙃','😉','😌','😍','🥰','😘','😗','😙','😚','😋','😛','😝','😜','🤪','🤨','🧐','🤓','😎','🤩','🥳','😐','😑','😔','🙁','😢','😭','😡','🤬','😱','😨','😰','😥','🥺','🤔','🙄','😴','🤒','🤕'] },
  { name: 'Người', list: ['👋','🤚','🖐️','✋','👌','🤞','✌️','🤟','🤘','👍','👎','👊','✊','🙏','👏','🙌','💪','👶','🧑','👨','👩','🧓','👴','👵','🙋','🤷','🙆','🙅'] },
  { name: 'Động vật', list: ['🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷','🐸','🐵','🐔','🐧','🐦','🦆','🦉','🐺','🐗','🐴','🦄','🐝','🐛','🦋','🐌','🐢','🐍','🐙','🐳','🐬','🐠','🐟'] },
  { name: 'Đồ ăn', list: ['🍏','🍎','🍊','🍋','🍌','🍉','🍇','🍓','🍈','🍒','🍑','🥭','🍍','🥥','🥝','🍅','🍆','🥑','🥦','🌽','🍞','🥐','🍕','🍔','🍟','🌭','🍿','🍣','🍦','🍩','🍪','🎂','☕','🍺'] },
  { name: 'Hoạt động', list: ['⚽','🏀','🏈','⚾','🎾','🏐','🏉','🎱','🏓','🏸','🥊','🎮','🎲','🎯','🎳','🎸','🎤','🎧','🎨','🚴','🏃','🏆','🥇','🎉','🎊'] },
  { name: 'Đồ vật', list: ['⌚','📱','💻','⌨️','🖥️','🖨️','📷','📹','☎️','📺','⏰','💡','🔦','🔋','🔌','🧰','🔧','🔨','📦','✉️','📌','📎','✂️','🔑','🚗','✈️'] },
  { name: 'Biểu tượng', list: ['❤️','🧡','💛','💚','💙','💜','🖤','🤍','💔','💯','🔥','✨','⭐','✅','❌','⚠️','❓','❗','💤','💬','💭'] },
];

let emojiPickerOpen = false;
function buildEmojiPicker() {
  const box = $('#emoji-picker');
  box.innerHTML = '';
  const tabs = el('div', 'emoji-tabs');
  const grid = el('div', 'emoji-grid');
  function renderCategory(idx) {
    grid.innerHTML = '';
    EMOJI_CATEGORIES[idx].list.forEach(emoji => {
      const opt = el('button', 'emoji-opt', emoji);
      opt.type = 'button';
      opt.addEventListener('click', () => sendEmotionMessage(emoji));
      grid.appendChild(opt);
    });
    tabs.querySelectorAll('.emoji-tab').forEach((t, i) => t.classList.toggle('active', i === idx));
  }
  EMOJI_CATEGORIES.forEach((cat, idx) => {
    const tab = el('button', `emoji-tab${idx === 0 ? ' active' : ''}`, cat.list[0]);
    tab.type = 'button';
    tab.title = cat.name;
    tab.addEventListener('click', () => renderCategory(idx));
    tabs.appendChild(tab);
  });
  box.appendChild(tabs);
  box.appendChild(grid);
  renderCategory(0);
}
function openEmojiPicker() {
  if (emojiPickerOpen) return;
  buildEmojiPicker();
  $('#emoji-picker').classList.remove('hidden');
  emojiPickerOpen = true;
  setTimeout(() => document.addEventListener('click', closeEmojiPickerOnOutsideClick), 0);
}
function closeEmojiPicker() {
  $('#emoji-picker').classList.add('hidden');
  $('#emoji-picker').innerHTML = '';
  emojiPickerOpen = false;
  document.removeEventListener('click', closeEmojiPickerOnOutsideClick);
}
function closeEmojiPickerOnOutsideClick(e) {
  if (e.target.closest('#emoji-picker') || e.target.closest('#btn-emoji')) return;
  closeEmojiPicker();
}
$('#btn-emoji').addEventListener('click', (e) => {
  e.stopPropagation();
  if (emojiPickerOpen) closeEmojiPicker(); else openEmojiPicker();
});

// Gui 1 emoji NGAY LAP TUC nhu mot text message binh thuong (khong tao media,
// khong API rieng) - retention 48h/encryption/WebSocket hien co tu ap dung.
async function sendEmotionMessage(emoji) {
  closeEmojiPicker();
  try {
    const res = await api('/api/messages', { method: 'POST', body: { text: emoji } });
    if (res && res.message) await appendMessage(res.message, true);
  } catch (err) {
    showToast('Gửi cảm xúc thất bại.');
  }
}

// Nhan dien tin nhan CHI gom 1-3 emoji (khong co text khac) de render lon hon,
// giong spec: "Nếu message chỉ chứa 1–3 emoji và không có text -> render lớn hơn".
const EMOJI_CLUSTER_RE = /\p{Extended_Pictographic}/u;
function isEmojiOnlyMessage(text) {
  if (!text) return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    try {
      const seg = new Intl.Segmenter('vi', { granularity: 'grapheme' });
      const clusters = Array.from(seg.segment(trimmed), s => s.segment);
      if (clusters.length < 1 || clusters.length > 3) return false;
      return clusters.every(c => EMOJI_CLUSTER_RE.test(c));
    } catch { /* fall through */ }
  }
  return /^(?:\p{Extended_Pictographic}\uFE0F?\u200D?){1,3}$/u.test(trimmed);
}

// HEIC/HEIF: nhieu iPhone/OS gan mimetype rong hoac generic cho HEIC, nen kiem
// tra ca mimetype LAN extension.
const HEIC_MIMES = ['image/heic', 'image/heif'];
function isHeicFile(f) {
  return HEIC_MIMES.includes(f.type) || /\.(heic|heif)$/i.test(f.name || '');
}

fileInput.addEventListener('change', async () => {
  const f = fileInput.files[0];
  if (!f) return;

  if (isHeicFile(f)) {
    showToast('Đang chuyển đổi ảnh HEIC...');
    try {
      const jpegFile = await convertHeicClientSide(f);
      // Sau khi co JPEG, di qua dung pipeline nen/resize hien tai nhu anh thuong.
      const compact = await prepareImageForUpload(jpegFile);
      state.selectedFile = compact;
      $('#upload-preview-name').textContent = `📎 ${compact.name} (${Math.ceil(compact.size / 1024)}KB)`;
      $('#upload-preview').classList.remove('hidden');
      showToast(`Ảnh HEIC đã chuyển đổi, còn ${Math.ceil(compact.size / 1024)} KB`);
    } catch (err) {
      // Trinh duyet khong tu convert duoc HEIC (thieu heic2any hoac giai ma that
      // bai) -> gui thang file HEIC goc len, de server tu convert (fallback).
      console.warn('Client khong convert duoc HEIC, chuyen sang server fallback:', err.message);
      showToast('Trình duyệt không tự chuyển đổi được HEIC, đang gửi để máy chủ xử lý...');
      state.selectedFile = f;
      $('#upload-preview-name').textContent = `📎 ${f.name} (${Math.ceil(f.size / 1024)}KB, HEIC)`;
      $('#upload-preview').classList.remove('hidden');
    }
    return;
  }

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

/* ---- HEIC/HEIF -> JPEG (client-side, uu tien) - dung thu vien heic2any tai
   tu CDN trong index.html. Neu thu vien khong ton tai (chan mang) hoac giai
   ma that bai (file loi, browser khong ho tro decode HEIC), nem loi de noi
   goi (fileInput handler) rot xuong phuong an gui HEIC goc len server. ---- */
async function convertHeicClientSide(file) {
  if (typeof window.heic2any !== 'function') {
    throw new Error('heic2any_unavailable');
  }
  const result = await window.heic2any({ blob: file, toType: 'image/jpeg', quality: 0.85 });
  // heic2any co the tra ve 1 Blob hoac mang Blob (anh HEIC nhieu frame/live photo) -
  // ta chi can frame dau tien cho chat.
  const blob = Array.isArray(result) ? result[0] : result;
  return blobToFile(blob, file.name);
}

/* ---- Nen anh phia client: resize + giam quality lap lai cho toi khi <=500KB ---- */
async function loadImageBitmap(file) {
  if (window.createImageBitmap) {
    try { return await createImageBitmap(file); } catch { /* fall through to <img> */ }
  }
  return new Promise((resolve, reject) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);
    // STEP 4 (performance): anh <img> nay chi dung TAM THOI de doc kich thuoc
    // (khong gan vao DOM, khong hien thi) - giai phong object URL ngay sau khi
    // load xong/loi, tranh giu blob trong bo nho lau hon can thiet.
    img.onload = () => { URL.revokeObjectURL(objectUrl); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(objectUrl); reject(new Error('Không đọc được ảnh.')); };
    img.src = objectUrl;
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
  const replyToId = state.replyTarget ? state.replyTarget.id : null;
  try {
    sendBtn.disabled = true;
    if (state.selectedFile) {
      sendBtn.textContent = 'Đang gửi...';
      const res = await apiUpload('/api/messages/media', state.selectedFile, replyToId);
      if (res && res.message) await appendMessage(res.message, true);
      state.selectedFile = null; fileInput.value = '';
      $('#upload-preview').classList.add('hidden');
    } else {
      const text = textInput.value.trim();
      if (!text) return;
      const res = await api('/api/messages', { method: 'POST', body: { text, replyToId } });
      if (res && res.message) await appendMessage(res.message, true);
      textInput.value = '';
    }
    state.replyTarget = null;
    renderReplyPreviewBar();
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
