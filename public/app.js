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
  // "attachment": trang thai duy nhat cho 1 file dinh kem dang duoc xu ly/tai
  // len (anh/video/HEIC) - xem public/attachment-state.js. Thay the hoan toan
  // "selectedFile" cu (chi la 1 bien don, khong theo doi duoc giai doan/loi/
  // preview/tien do).
  attachment: AttachmentState.createAttachmentState(),
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

// Upload multipart (anh/video) qua XMLHttpRequest (KHONG dung fetch()) - fetch()
// khong co API dang tin cay/duoc ho tro rong rai de theo doi TIEN DO UPLOAD
// (xhr.upload.onprogress), trong khi UI moi CAN hien thi % that (khong bia so
// lieu - yeu cau §10: "Do NOT pretend fetch() upload progress is available if
// it is not"). Tra ve ca Promise KET QUA lan tham chieu "xhr" (qua onXhrCreated)
// de noi goi co the abort() giua chung (huy dinh kem trong luc dang tai len).
function uploadAttachmentWithProgress(path, file, replyToId, { onProgress, onXhrCreated } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', path);
    if (state.token) xhr.setRequestHeader('Authorization', 'Bearer ' + state.token);
    xhr.upload.onprogress = (evt) => {
      if (evt.lengthComputable && onProgress) onProgress(Math.round((evt.loaded / evt.total) * 100));
    };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* body rong/khong phai JSON */ }
      if (xhr.status === 401) { logout(false); reject(Object.assign(new Error('unauthorized'), { status: 401 })); return; }
      if (xhr.status < 200 || xhr.status >= 300) {
        const err = new Error(data.message || data.error || 'upload_failed');
        err.data = data; err.status = xhr.status;
        reject(err);
        return;
      }
      resolve(data);
    };
    xhr.onerror = () => reject(new Error('Không thể kết nối máy chủ'));
    xhr.onabort = () => reject(Object.assign(new Error('aborted'), { aborted: true }));
    const form = new FormData();
    form.append('file', file, file.name || 'upload');
    if (replyToId) form.append('replyToId', String(replyToId));
    if (onXhrCreated) onXhrCreated(xhr);
    xhr.send(form);
  });
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
  // Don dep dinh kem dang xu ly/tai len (neu co) - tranh giu blob URL/xhr cua
  // phien truoc song sang phien dang nhap moi (co the la user khac tren cung
  // 1 trinh duyet).
  if (typeof cancelAttachment === 'function') cancelAttachment();
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

/* ============================================================================
 * Attachment workflow (redesign) - xem public/attachment-state.js cho state
 * machine THUAN TUY (IDLE/ATTACHED/CONVERTING/READY_TO_UPLOAD/UPLOADING/
 * COMPLETED/FAILED/CANCELLED). File nay CHI lo phan "hieu ung phu" (DOM,
 * network, object URL, timer) - moi quyet dinh "chuyen doi nao hop le" nam o
 * attachment-state.js va da duoc unit-test rieng (test/attachment-state.test.js).
 *
 * 1 NGUON SU THAT DUY NHAT: "state.attachment". Moi thao tac bat dong bo
 * (convert HEIC, nen anh, tai len) PHAI kiem tra AttachmentState.isStaleAttachmentResult()
 * truoc khi cap nhat DOM/state, de 1 thao tac CU (thuoc attachment da bi thay
 * the/huy) khong bao gio ghi de len attachment MOI hon.
 * ========================================================================== */

const sendBtn = document.querySelector('.btn-send');
const attachmentCard = $('#attachment-card');
const attachmentPreviewImg = $('#attachment-preview-img');
const attachmentPlaceholder = $('#attachment-placeholder');
const attachmentPlaceholderLabel = $('#attachment-placeholder-label');
const attachmentOverlay = $('#attachment-overlay');
const attachmentSpinnerEl = $('#attachment-spinner');
const attachmentSpinnerArc = $('#attachment-spinner-arc');
const attachmentProgressText = $('#attachment-progress-text');
const attachmentFilenameEl = $('#attachment-filename');
const attachmentStatusEl = $('#attachment-status');
const SPINNER_CIRCUMFERENCE = 2 * Math.PI * 20; // r=20, xem SVG trong index.html

// Sau lan HEIC dau tien that bai/timeout trong PHIEN NAY, khong thu heic2any
// nua cho cac file HEIC tiep theo (rot thang xuong server fallback ngay) -
// tranh cho nguoi dung vo ich + console log lap lai (yeu cau §8: "prevent the
// library from being... tried again when known broken"). Chi ton tai trong bo
// nho phien lam viec (khong luu qua reload trang).
let heicClientConversionKnownBroken = false;

function setAttachmentPhase(nextPhase, patch) {
  state.attachment = AttachmentState.transition(state.attachment, nextPhase, patch);
  renderAttachmentPreview();
  updateSendButtonForAttachment();
  return state.attachment;
}
function patchAttachment(patch) {
  state.attachment = AttachmentState.updateAttachment(state.attachment, patch);
  renderAttachmentPreview();
  return state.attachment;
}
function revokeAttachmentPreviewUrl() {
  if (state.attachment.previewUrl) {
    try { URL.revokeObjectURL(state.attachment.previewUrl); } catch { /* bo qua */ }
  }
}

// Nut "Gui" bi khoa TRONG LUC CONVERTING/UPLOADING (dinh nghia trong
// attachment-state.js) - tranh nguoi dung nhan Gui trong khi chua co file san
// sang, va tranh double-send (§9/§16).
function updateSendButtonForAttachment() {
  if (!sendBtn) return;
  const PHASES = AttachmentState.PHASES;
  const blocked = AttachmentState.isSendBlockedByAttachment(state.attachment.phase);
  sendBtn.disabled = blocked;
  sendBtn.textContent =
    state.attachment.phase === PHASES.UPLOADING ? 'Đang tải...' :
    state.attachment.phase === PHASES.CONVERTING ? 'Đang xử lý...' : 'Gửi';
}

function renderAttachmentPreview() {
  const att = state.attachment;
  const PHASES = AttachmentState.PHASES;
  if (att.phase === PHASES.IDLE || att.phase === PHASES.CANCELLED) {
    attachmentCard.classList.add('hidden');
    return;
  }
  attachmentCard.classList.remove('hidden');
  attachmentCard.classList.toggle('is-retryable', att.phase === PHASES.FAILED && !!att.file);

  if (att.previewUrl) {
    attachmentPreviewImg.src = att.previewUrl;
    attachmentPreviewImg.classList.remove('hidden');
    attachmentPreviewImg.classList.toggle('sharp', att.phase === PHASES.COMPLETED);
    attachmentPlaceholder.classList.add('hidden');
  } else {
    attachmentPreviewImg.classList.add('hidden');
    attachmentPlaceholder.classList.remove('hidden');
    attachmentPlaceholderLabel.textContent = att.kind === 'heic' ? 'HEIC' : att.kind === 'video' ? 'VIDEO' : '📎';
  }

  // Overlay (spinner vo dinh khi CONVERTING, tien do so khi UPLOADING) - xem
  // §10/§11: "khong bia % conversion gia - dung spinner vo dinh".
  if (att.phase === PHASES.CONVERTING) {
    attachmentOverlay.classList.remove('hidden');
    attachmentSpinnerEl.classList.add('indeterminate');
    attachmentProgressText.textContent = '';
  } else if (att.phase === PHASES.UPLOADING) {
    attachmentOverlay.classList.remove('hidden');
    attachmentSpinnerEl.classList.remove('indeterminate');
    const pct = Math.max(0, Math.min(100, att.progress == null ? 0 : att.progress));
    attachmentSpinnerArc.style.strokeDashoffset = String(SPINNER_CIRCUMFERENCE * (1 - pct / 100));
    attachmentProgressText.textContent = `${pct}%`;
  } else {
    attachmentOverlay.classList.add('hidden');
    attachmentSpinnerEl.classList.remove('indeterminate');
  }

  attachmentFilenameEl.textContent = att.meta.name || '';
  attachmentStatusEl.classList.toggle('is-error', att.phase === PHASES.FAILED);
  attachmentStatusEl.textContent =
    att.phase === PHASES.ATTACHED ? 'Đang chuẩn bị...' :
    att.phase === PHASES.CONVERTING ? (att.kind === 'heic' ? 'Đang chuyển đổi...' : 'Đang xử lý ảnh...') :
    att.phase === PHASES.READY_TO_UPLOAD ? 'Sẵn sàng gửi' :
    att.phase === PHASES.UPLOADING ? 'Đang tải lên...' :
    att.phase === PHASES.FAILED ? (att.error || 'Xử lý thất bại') + (att.file ? ' (nhấn để thử lại)' : '') :
    att.phase === PHASES.COMPLETED ? 'Hoàn tất' : '';
}

// Thu tao 1 preview LOCAL tu chinh file goc (truoc khi convert/nen) - anh
// thuong (JPEG/PNG/WebP/GIF) LUON doc duoc; HEIC thi TUY trinh duyet (Safari
// moi co the, hau het trinh duyet khac thi khong) - thu 1 cach "graceful",
// that bai thi im lang dung placeholder, KHONG bao loi/anh huong luong chinh
// (yeu cau §7).
function attachLocalPreviewIfPossible(attachmentId, file) {
  const objectUrl = URL.createObjectURL(file);
  const probe = new Image();
  probe.onload = () => {
    if (AttachmentState.isStaleAttachmentResult(state.attachment.id, attachmentId)) {
      URL.revokeObjectURL(objectUrl); // attachment da doi - khong con can nua
      return;
    }
    revokeAttachmentPreviewUrl();
    patchAttachment({ previewUrl: objectUrl });
  };
  probe.onerror = () => {
    URL.revokeObjectURL(objectUrl); // khong decode duoc (thuong la HEIC) - giu placeholder
  };
  probe.src = objectUrl;
}

function setReadyToUpload(attachmentId, file, opts) {
  if (AttachmentState.isStaleAttachmentResult(state.attachment.id, attachmentId)) return;
  setAttachmentPhase(AttachmentState.PHASES.READY_TO_UPLOAD, {
    file,
    meta: { name: file.name || state.attachment.meta.name, sizeBytes: file.size || 0 },
  });
  if (opts && opts.converterFailed) {
    showToast('Trình duyệt không tự chuyển đổi được HEIC, đang dùng máy chủ xử lý...');
  }
}
function failAttachment(attachmentId, message) {
  if (AttachmentState.isStaleAttachmentResult(state.attachment.id, attachmentId)) return;
  setAttachmentPhase(AttachmentState.PHASES.FAILED, { error: message });
  showToast(message);
}

// Huy attachment dang hoat dong (nguoi dung bam X, hoac attach file moi thay
// the file cu, hoac dang xu ly bi buoc dung giua chung). Abort XHR dang chay
// (neu co), giai phong object URL, dua state ve IDLE sach se.
function cancelAttachment() {
  const att = state.attachment;
  if (att.xhr) { try { att.xhr.abort(); } catch { /* bo qua */ } }
  revokeAttachmentPreviewUrl();
  state.attachment = AttachmentState.createAttachmentState();
  fileInput.value = '';
  renderAttachmentPreview();
  updateSendButtonForAttachment();
}

$('#btn-remove-attachment').addEventListener('click', () => cancelAttachment());
// Bam vao card khi dang FAILED -> thu lai VOI CHINH FILE GOC da luu (khong
// can nguoi dung chon lai file) - cach "retry" don gian, khong can nut rieng.
attachmentCard.addEventListener('click', (e) => {
  if (e.target.closest('#btn-remove-attachment')) return;
  const att = state.attachment;
  if (att.phase === AttachmentState.PHASES.FAILED && att.file) {
    startAttachmentProcessing(att.file);
  }
});

// Diem vao DUY NHAT khi nguoi dung chon 1 file (tu <input type=file> hoac tu
// retry). Luon HUY attachment truoc do (neu co) va bat 1 attachmentId MOI,
// dam bao khong bao gio co 2 "attachment dang hoat dong" cung luc, va moi thao
// tac bat dong bo cua file CU tu nhan ra minh da "lac hau" (xem
// AttachmentState.isStaleAttachmentResult - yeu cau §15).
async function startAttachmentProcessing(file) {
  cancelAttachment();
  const id = AttachmentState.generateAttachmentId();
  state.attachment = AttachmentState.transition(AttachmentState.createAttachmentState(), AttachmentState.PHASES.ATTACHED, {
    id,
    file,
    kind: isHeicFile(file) ? 'heic' : /^video\//.test(file.type) ? 'video' : 'image',
    meta: { name: file.name || 'file', sizeBytes: file.size || 0 },
  });
  renderAttachmentPreview();
  updateSendButtonForAttachment();

  // ---- Video: khong co xu ly phia client, chi validate roi san sang gui. ----
  if (/^video\//.test(file.type)) {
    if (!['video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska'].includes(file.type)) {
      failAttachment(id, 'Định dạng video không được hỗ trợ.'); return;
    }
    if (file.size > state.limits.maxVideoBytes) {
      failAttachment(id, 'Video phải có dung lượng không quá 10 MB.'); return;
    }
    setReadyToUpload(id, file);
    return;
  }

  // ---- HEIC ----
  if (isHeicFile(file)) {
    attachLocalPreviewIfPossible(id, file);
    if (heicClientConversionKnownBroken) {
      setReadyToUpload(id, file, { converterFailed: true });
      return;
    }
    setAttachmentPhase(AttachmentState.PHASES.CONVERTING);
    try {
      const jpegFile = await convertHeicClientSide(file);
      if (AttachmentState.isStaleAttachmentResult(state.attachment.id, id)) return;
      const compact = await prepareImageForUpload(jpegFile);
      if (AttachmentState.isStaleAttachmentResult(state.attachment.id, id)) return;
      // Thay preview (co the dang la placeholder, vi trinh duyet khong tu doc
      // duoc HEIC goc) bang preview SAC NET cua ket qua JPEG da convert.
      revokeAttachmentPreviewUrl();
      const previewUrl = URL.createObjectURL(compact);
      patchAttachment({ previewUrl });
      setReadyToUpload(id, compact);
    } catch (err) {
      if (AttachmentState.isStaleAttachmentResult(state.attachment.id, id)) return;
      heicClientConversionKnownBroken = true;
      console.warn('Client khong convert duoc HEIC, chuyen sang server fallback:', err.message);
      setReadyToUpload(id, file, { converterFailed: true });
    }
    return;
  }

  // ---- Anh thuong (JPEG/PNG/WebP/GIF) ----
  if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type)) {
    failAttachment(id, 'Định dạng ảnh không được hỗ trợ.'); return;
  }
  attachLocalPreviewIfPossible(id, file);
  setAttachmentPhase(AttachmentState.PHASES.CONVERTING);
  try {
    const compact = await prepareImageForUpload(file);
    if (AttachmentState.isStaleAttachmentResult(state.attachment.id, id)) return;
    setReadyToUpload(id, compact);
  } catch (err) {
    if (AttachmentState.isStaleAttachmentResult(state.attachment.id, id)) return;
    failAttachment(id, err.message || 'Ảnh quá lớn, không thể nén xuống dưới 500 KB.');
  }
}

fileInput.addEventListener('change', () => {
  const f = fileInput.files[0];
  if (!f) return;
  startAttachmentProcessing(f);
});

/* ---- HEIC/HEIF -> JPEG (client-side, uu tien) - dung thu vien heic2any tai
   tu CDN trong index.html. Neu thu vien khong ton tai (chan mang) hoac giai
   ma that bai (file loi, browser khong ho tro decode HEIC), nem loi de noi
   goi (startAttachmentProcessing) rot xuong phuong an gui HEIC goc len server. ----
   PRODUCTION FIX (2026-09-14): tren 1 so trinh duyet/mang, heic2any tao 1 Web
   Worker roi ben trong worker do goi new Function() - neu bi Content-Security-
   Policy chan (khong co 'unsafe-eval'), loi CSP nay xay ra SAU trong 1 boi
   canh (worker internal) ma heic2any co the KHONG lang nghe ("worker.onerror")
   de bien no thanh 1 Promise bi reject dung cach - console hien "Uncaught
   EvalError" (KHONG co "(in promise)"), dau hieu day la loi khong di qua
   promise chain nao ca. Neu vay, "await window.heic2any(...)" co the treo VO
   HAN (khong bao gio resolve/reject). Thay vi mo rong CSP them "unsafe-eval"
   (lam yeu bao ve XSS toan trang chi vi 1 hanh vi noi bo dang ngo cua 1 thu
   vien ben thu 3), ta dat 1 GIOI HAN THOI GIAN CHO tuong minh (giong pattern
   da dung cho HEIC conversion PHIA SERVER - xem HEIC_CONVERT_TIMEOUT_MS trong
   server.js): neu heic2any khong tra ket qua trong khoang thoi gian hop ly,
   CHU DONG bo cuoc cho no va rot xuong server-side fallback, thay vi tin
   tuong tuyet doi rang Promise cua 1 thu vien ngoai LUON settle. Cach nay xu
   ly dung ca 2 kha nang (promise thuc su reject cham, HOAC treo vinh vien) ma
   khong can biet chinh xac nguyen nhan that bai la gi. */
const HEIC_CLIENT_CONVERT_TIMEOUT_MS = 20000; // 20s - du cho anh HEIC thuong,
// khong qua dai de nguoi dung phai cho lau truoc khi thay fallback server.
async function convertHeicClientSide(file) {
  if (typeof window.heic2any !== 'function') {
    throw new Error('heic2any_unavailable');
  }
  const conversion = window.heic2any({ blob: file, toType: 'image/jpeg', quality: 0.85 });
  // Neu "conversion" sau nay (SAU KHI ta da bo cuoc cho no vi timeout) tu no
  // roi vao trang thai rejected, gan 1 .catch() no o day de trinh duyet KHONG
  // in ra canh bao "Unhandled promise rejection" vo ich trong console - hoan
  // toan khong anh huong ket qua/luong xu ly chinh (da quyet dinh xong qua
  // Promise.race ben duoi).
  if (conversion && typeof conversion.catch === 'function') conversion.catch(() => {});
  const result = await Promise.race([
    conversion,
    new Promise((_, reject) => setTimeout(() => reject(new Error('heic2any_timeout')), HEIC_CLIENT_CONVERT_TIMEOUT_MS)),
  ]);
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
  const replyToId = state.replyTarget ? state.replyTarget.id : null;
  const PHASES = AttachmentState.PHASES;

  // ---- Co dinh kem san sang gui (anh/video/HEIC da qua xu ly client) ----
  if (state.attachment.phase === PHASES.READY_TO_UPLOAD) {
    const attachmentId = state.attachment.id;
    const fileToUpload = state.attachment.file;
    setAttachmentPhase(PHASES.UPLOADING, { progress: 0 }); // -> disable Send ngay (chong double-send, §16)
    try {
      const data = await uploadAttachmentWithProgress('/api/messages/media', fileToUpload, replyToId, {
        onProgress: (pct) => {
          if (AttachmentState.isStaleAttachmentResult(state.attachment.id, attachmentId)) return;
          patchAttachment({ progress: pct });
        },
        onXhrCreated: (xhr) => {
          // Neu attachment da bi thay doi GIUA LUC tao xhr va luc callback nay
          // chay (hiem, nhung ve ly thuyet co the) - huy luon xhr "mo côi" nay.
          if (AttachmentState.isStaleAttachmentResult(state.attachment.id, attachmentId)) { try { xhr.abort(); } catch { /* bo qua */ } return; }
          state.attachment = AttachmentState.updateAttachment(state.attachment, { xhr });
        },
      });
      if (AttachmentState.isStaleAttachmentResult(state.attachment.id, attachmentId)) return; // da bi huy/thay the giua chung
      if (data && data.message) await appendMessage(data.message, true);
      // Hoan tat: COMPLETED (net anh trong khoanh khac ngan) roi ve IDLE (an card).
      revokeAttachmentPreviewUrl();
      setAttachmentPhase(PHASES.COMPLETED);
      setAttachmentPhase(PHASES.IDLE);
      fileInput.value = '';
      state.replyTarget = null;
      renderReplyPreviewBar();
      hideMentionDropdown();
    } catch (err) {
      if (err && err.aborted) return; // nguoi dung tu huy qua cancelAttachment() - da xu ly xong, khong bao loi them
      if (AttachmentState.isStaleAttachmentResult(state.attachment.id, attachmentId)) return;
      failAttachment(attachmentId, 'Tải ảnh lên thất bại: ' + ((err.data && err.data.message) || err.message || ''));
    }
    return;
  }

  // ---- Khong co dinh kem (hoac dinh kem chua san sang - nut Gui da bi khoa
  // trong truong hop do nen thuc te khong toi duoc nhanh nay) -> gui text. ----
  const text = textInput.value.trim();
  if (!text) return;
  try {
    sendBtn.disabled = true;
    const res = await api('/api/messages', { method: 'POST', body: { text, replyToId } });
    if (res && res.message) await appendMessage(res.message, true);
    textInput.value = '';
    state.replyTarget = null;
    renderReplyPreviewBar();
    hideMentionDropdown();
  } catch (err) {
    showToast('Gửi thất bại: ' + ((err.data && err.data.message) || err.message || ''));
  } finally {
    sendBtn.disabled = false;
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
