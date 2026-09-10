// ===================================================================
// Chat noi bo cong ty - server.js
// Express (REST) + ws (realtime) + PostgreSQL (Render.com Postgres)
// Noi dung tin nhan/anh/video duoc client ma hoa dau-cuoi (AES-GCM)
// TRUOC khi gui len - server CHI luu va chuyen tiep ciphertext, khong
// bao gio nhin thay noi dung goc.
// ===================================================================

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const app = express();
app.set('trust proxy', true); // chay sau reverse proxy cua Render.com
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

const PORT = process.env.PORT || 3000;

// ===== Cau hinh bao mat / seed admin (doc tu bien moi truong, co gia tri mac dinh
// theo dung yeu cau nghiep vu, nhung NEN override qua Environment tren Render) =====
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
    console.warn('⚠️  Chua dat JWT_SECRET trong bien moi truong - dang dung khoa tam cho dev. ' +
        'Hay dat JWT_SECRET tren Render (tab Environment) truoc khi dua vao san xuat.');
}
const EFFECTIVE_JWT_SECRET = JWT_SECRET || 'dev-only-insecure-secret-change-me';

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'do.huy';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '14503246';

const MESSAGE_RETENTION_DAYS = 2;
const MESSAGE_PAGE_SIZE = 50;
const MAX_PAYLOAD_MB = 20; // gioi han payload (anh/video da ma hoa + base64)

// ===== Ket noi PostgreSQL (chi doc tu DATABASE_URL, khong hard-code) =====
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
    console.error('❌ Thieu bien moi truong DATABASE_URL. Vao Render → Web Service → Environment de them ' +
        '(lay tu Render Postgres instance, muc "Internal Database URL").');
    process.exit(1);
}
const isExternalUrl = /\.render\.com/.test(connectionString);
const pool = new Pool({
    connectionString,
    ssl: isExternalUrl ? { rejectUnauthorized: false } : false
});
pool.on('error', (err) => {
    console.error('Loi khong mong doi tu PostgreSQL pool:', err);
});

// ===== Khoi tao bang =====
async function initDatabase() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'user',       -- 'admin' | 'user'
            status TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'approved'
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS messages (
            id SERIAL PRIMARY KEY,
            sender TEXT NOT NULL,
            msg_type TEXT NOT NULL DEFAULT 'text',   -- 'text' | 'image' | 'video'
            ciphertext TEXT NOT NULL,                -- base64 AES-GCM ciphertext (server khong doc duoc)
            iv TEXT NOT NULL,                        -- base64 IV dung de giai ma phia client
            mime_type TEXT,
            mentions TEXT[] NOT NULL DEFAULT '{}',   -- metadata @tag - client tu bung ra truoc khi ma hoa
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages (created_at)`);

    // Seed tai khoan admin duy nhat neu chua ton tai
    const existing = await pool.query('SELECT id FROM users WHERE username = $1', [ADMIN_USERNAME]);
    if (existing.rows.length === 0) {
        const hash = await bcrypt.hash(ADMIN_PASSWORD, 10);
        await pool.query(
            `INSERT INTO users (username, password_hash, role, status) VALUES ($1, $2, 'admin', 'approved')`,
            [ADMIN_USERNAME, hash]
        );
        console.log(`✅ Da tao tai khoan admin mac dinh: ${ADMIN_USERNAME}`);
    }
    console.log('✅ Da ket noi PostgreSQL va kiem tra xong cau truc bang.');
}

// ===== Don dep tin nhan cu hon MESSAGE_RETENTION_DAYS =====
async function cleanupOldMessages() {
    try {
        const res = await pool.query(
            `DELETE FROM messages WHERE created_at < now() - interval '${MESSAGE_RETENTION_DAYS} days' RETURNING id`
        );
        if (res.rowCount > 0) {
            console.log(`🧹 Da xoa ${res.rowCount} tin nhan qua han ${MESSAGE_RETENTION_DAYS} ngay.`);
        }
    } catch (err) {
        console.error('Loi khi don dep tin nhan cu:', err);
    }
}

// ===================================================================
// Middleware
// ===================================================================
app.use(express.json({ limit: `${MAX_PAYLOAD_MB}mb` }));
app.use(express.static(path.join(__dirname, 'public')));

function signToken(user) {
    return jwt.sign(
        { id: user.id, username: user.username, role: user.role, status: user.status },
        EFFECTIVE_JWT_SECRET,
        { expiresIn: '30d' }
    );
}

function authRequired(req, res, next) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'unauthorized' });
    try {
        req.user = jwt.verify(token, EFFECTIVE_JWT_SECRET);
        next();
    } catch (err) {
        return res.status(401).json({ error: 'invalid_token' });
    }
}

function approvedRequired(req, res, next) {
    if (req.user.role !== 'admin' && req.user.status !== 'approved') {
        return res.status(403).json({ error: 'not_approved' });
    }
    next();
}

function adminRequired(req, res, next) {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
    next();
}

// ===================================================================
// Auth routes
// ===================================================================
const USERNAME_RE = /^[a-zA-Z0-9._-]{3,32}$/;

app.post('/api/auth/register', async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password || !USERNAME_RE.test(username) || password.length < 6) {
        return res.status(400).json({
            error: 'invalid_input',
            message: 'Ten dang nhap 3-32 ky tu (chu, so, ., _, -) va mat khau toi thieu 6 ky tu.'
        });
    }
    try {
        const dup = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
        if (dup.rows.length > 0) {
            return res.status(409).json({ error: 'username_taken', message: 'Ten dang nhap da ton tai.' });
        }
        const hash = await bcrypt.hash(password, 10);
        const result = await pool.query(
            `INSERT INTO users (username, password_hash, role, status) VALUES ($1, $2, 'user', 'pending') RETURNING id`,
            [username, hash]
        );
        res.json({
            success: true,
            message: 'Dang ky thanh cong. Vui long cho quan tri vien (admin) cap quyen truoc khi xem noi dung.'
        });
        broadcastToAdmins({ type: 'user_registered', username, id: result.rows[0].id });
    } catch (err) {
        console.error('Loi register:', err);
        res.status(500).json({ error: 'server_error' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'invalid_input' });
    try {
        const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
        if (result.rows.length === 0) return res.status(401).json({ error: 'bad_credentials', message: 'Sai ten dang nhap hoac mat khau.' });
        const user = result.rows[0];
        const ok = await bcrypt.compare(password, user.password_hash);
        if (!ok) return res.status(401).json({ error: 'bad_credentials', message: 'Sai ten dang nhap hoac mat khau.' });
        const token = signToken(user);
        res.json({
            success: true,
            token,
            user: { id: user.id, username: user.username, role: user.role, status: user.status }
        });
    } catch (err) {
        console.error('Loi login:', err);
        res.status(500).json({ error: 'server_error' });
    }
});

app.get('/api/auth/me', authRequired, async (req, res) => {
    // Doc lai tu DB de phan anh dung trang thai duyet moi nhat (token co the cu)
    try {
        const result = await pool.query('SELECT id, username, role, status FROM users WHERE id = $1', [req.user.id]);
        if (result.rows.length === 0) return res.status(401).json({ error: 'user_not_found' });
        const user = result.rows[0];
        res.json({ user, token: signToken(user) });
    } catch (err) {
        console.error('Loi /me:', err);
        res.status(500).json({ error: 'server_error' });
    }
});

// Danh sach user da duoc duyet - dung cho tinh nang autocomplete @tag
app.get('/api/users', authRequired, approvedRequired, async (req, res) => {
    const result = await pool.query(
        `SELECT username FROM users WHERE status = 'approved' ORDER BY username ASC`
    );
    res.json({ users: result.rows.map(r => r.username) });
});

// ===================================================================
// Admin routes
// ===================================================================
app.get('/api/admin/users', authRequired, adminRequired, async (req, res) => {
    const result = await pool.query(
        `SELECT id, username, role, status, created_at FROM users ORDER BY created_at DESC`
    );
    res.json({ users: result.rows });
});

app.post('/api/admin/users/:id/approve', authRequired, adminRequired, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const result = await pool.query(
        `UPDATE users SET status = 'approved' WHERE id = $1 RETURNING id, username, role, status`, [id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'not_found' });
    res.json({ success: true, user: result.rows[0] });
    notifyUser(result.rows[0].username, { type: 'status_changed', status: 'approved' });
});

app.post('/api/admin/users/:id/revoke', authRequired, adminRequired, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const result = await pool.query(
        `UPDATE users SET status = 'pending' WHERE id = $1 AND role != 'admin' RETURNING id, username, role, status`, [id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'not_found' });
    res.json({ success: true, user: result.rows[0] });
    notifyUser(result.rows[0].username, { type: 'status_changed', status: 'pending' });
});

app.delete('/api/admin/users/:id', authRequired, adminRequired, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const target = await pool.query('SELECT username, role FROM users WHERE id = $1', [id]);
    if (target.rows.length === 0) return res.status(404).json({ error: 'not_found' });
    if (target.rows[0].role === 'admin') {
        return res.status(400).json({ error: 'cannot_delete_admin', message: 'Khong the xoa tai khoan admin duy nhat.' });
    }
    await pool.query('DELETE FROM users WHERE id = $1', [id]);
    res.json({ success: true });
    notifyUser(target.rows[0].username, { type: 'account_deleted' });
});

// ===================================================================
// Message routes (chi user da duoc duyet / admin)
// Noi dung (ciphertext) hoan toan do client ma hoa - server chi luu & phat lai.
// Tin nhan KHONG co endpoint xoa/thu hoi (theo yeu cau nghiep vu).
// ===================================================================
app.get('/api/messages', authRequired, approvedRequired, async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || MESSAGE_PAGE_SIZE, 200);
    const beforeId = parseInt(req.query.beforeId, 10);
    try {
        let result;
        if (beforeId) {
            result = await pool.query(
                `SELECT * FROM (
                    SELECT id, sender, msg_type, ciphertext, iv, mime_type, mentions, created_at
                    FROM messages WHERE id < $1 ORDER BY id DESC LIMIT $2
                 ) t ORDER BY id ASC`,
                [beforeId, limit]
            );
        } else {
            result = await pool.query(
                `SELECT * FROM (
                    SELECT id, sender, msg_type, ciphertext, iv, mime_type, mentions, created_at
                    FROM messages ORDER BY id DESC LIMIT $1
                 ) t ORDER BY id ASC`,
                [limit]
            );
        }
        res.json({ messages: result.rows, retentionDays: MESSAGE_RETENTION_DAYS });
    } catch (err) {
        console.error('Loi doc messages:', err);
        res.status(500).json({ error: 'server_error' });
    }
});

app.post('/api/messages', authRequired, approvedRequired, async (req, res) => {
    const { msgType, ciphertext, iv, mimeType, mentions } = req.body || {};
    if (!ciphertext || !iv || !['text', 'image', 'video'].includes(msgType)) {
        return res.status(400).json({ error: 'invalid_input' });
    }
    const mentionList = Array.isArray(mentions) ? mentions.filter(m => typeof m === 'string').slice(0, 20) : [];
    try {
        const result = await pool.query(
            `INSERT INTO messages (sender, msg_type, ciphertext, iv, mime_type, mentions)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING id, sender, msg_type, ciphertext, iv, mime_type, mentions, created_at`,
            [req.user.username, msgType, ciphertext, iv, mimeType || null, mentionList]
        );
        const message = result.rows[0];
        res.json({ success: true, message });
        broadcastToApproved({ type: 'new_message', message });
    } catch (err) {
        console.error('Loi ghi message:', err);
        if (err.message && /too large/i.test(err.message)) {
            return res.status(413).json({ error: 'payload_too_large' });
        }
        res.status(500).json({ error: 'server_error' });
    }
});

// SPA fallback
app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/ws')) return next();
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ===================================================================
// WebSocket realtime: xac thuc bang JWT qua query string (?token=...)
// Server chi dung de bao tin nhan moi + thay doi trang thai tai khoan,
// KHONG day push-notification xuong he dieu hanh (chi bao hieu trong app).
// ===================================================================
function verifyWsToken(token) {
    try {
        return jwt.verify(token, EFFECTIVE_JWT_SECRET);
    } catch {
        return null;
    }
}

wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('token');
    const payload = token ? verifyWsToken(token) : null;
    if (!payload) {
        ws.close(4001, 'unauthorized');
        return;
    }
    ws.userPayload = payload;
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('close', () => {});
});

// Heartbeat de don cac ket noi chet
setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        try { ws.ping(); } catch {}
    });
}, 30000);

function broadcastToApproved(obj) {
    const data = JSON.stringify(obj);
    wss.clients.forEach((ws) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        const u = ws.userPayload;
        if (!u) return;
        if (u.role === 'admin' || u.status === 'approved') ws.send(data);
    });
}

function broadcastToAdmins(obj) {
    const data = JSON.stringify(obj);
    wss.clients.forEach((ws) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (ws.userPayload && ws.userPayload.role === 'admin') ws.send(data);
    });
}

function notifyUser(username, obj) {
    const data = JSON.stringify(obj);
    wss.clients.forEach((ws) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (ws.userPayload && ws.userPayload.username === username) {
            ws.send(data);
            if (obj.type === 'account_deleted') ws.close(4002, 'account_deleted');
        }
    });
}

// ===================================================================
// Khoi dong
// ===================================================================
initDatabase()
    .then(() => {
        cleanupOldMessages();
        setInterval(cleanupOldMessages, 60 * 60 * 1000); // moi gio don dep tin nhan qua 2 ngay
        server.listen(PORT, () => {
            console.log(`🚀 Server dang chay tren cong ${PORT}`);
        });
    })
    .catch((err) => {
        console.error('❌ Khong the khoi tao database:', err);
        process.exit(1);
    });
