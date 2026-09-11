// ===================================================================
// Chat noi bo cong ty - server.js
// Express (REST) + ws (realtime) + PostgreSQL (Render.com Postgres)
//
// MO HINH MA HOA (STEP nay thay doi so voi ban dau):
//   Client --HTTPS/WSS--> Server --AES-256-GCM--> PostgreSQL
// Server co the giai ma noi dung (KHONG con la E2EE). Du lieu TRUYEN TAI duoc
// bao ve boi TLS (HTTPS/WSS), du lieu LUU TRU duoc ma hoa tai server bang
// AES-256-GCM voi khoa doc tu MESSAGE_ENCRYPTION_KEY. Database khong bao gio
// chua plaintext.
// ===================================================================

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { Pool } = require('pg');

const app = express();
app.set('trust proxy', true); // chay sau reverse proxy cua Render.com
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

const PORT = process.env.PORT || 3000;

// ===== Auth / JWT =====
// FAIL-FAST giong het MESSAGE_ENCRYPTION_KEY: neu thieu JWT_SECRET khi production,
// server TU CHOI khoi dong thay vi am tham dung mot secret mac dinh cong khai
// trong source code (ai doc duoc code deu tu ky JWT gia lam admin duoc).
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
    if (process.env.NODE_ENV === 'production') {
        console.error('❌ Thieu JWT_SECRET trong moi truong production. Server tu choi khoi dong vi ly do ' +
            'bao mat (khong dung fallback secret cong khai trong code cho production).');
        process.exit(1);
    }
    console.warn('⚠️  Thieu JWT_SECRET - dang dung khoa tam CHI DUNG CHO DEV. Hay dat JWT_SECRET tren Render ' +
        '(tab Environment) truoc khi dua vao san xuat.');
} else if (JWT_SECRET.length < 32) {
    console.warn('⚠️  JWT_SECRET qua ngan (<32 ky tu) - nen dung chuoi dai va ngau nhien hon (vd: openssl rand -base64 32).');
}
const EFFECTIVE_JWT_SECRET = JWT_SECRET || 'dev-only-insecure-secret-change-me';

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'do.huy';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '14503246';

// ===== Retention / storage config (STEP: rolling retention) =====
const MESSAGE_RETENTION_HOURS = parseInt(process.env.MESSAGE_RETENTION_HOURS, 10) || 48;
const DB_STORAGE_LIMIT_MB = process.env.DB_STORAGE_LIMIT_MB ? parseInt(process.env.DB_STORAGE_LIMIT_MB, 10) : null;
const DB_WARNING_RATIO = parseFloat(process.env.DB_WARNING_RATIO) || 0.80;
const DB_EMERGENCY_RATIO = parseFloat(process.env.DB_EMERGENCY_RATIO) || 0.90;
const DB_TARGET_RATIO = parseFloat(process.env.DB_TARGET_RATIO) || 0.75;
// STEP 2A: hard guard - DELETE khong lam pg_database_size() giam ngay lap tuc (dead
// tuples, chi VACUUM FULL/pg_repack moi rewrite that su - va khong duoc chay trong
// request/cleanup loop vi khoa bang). Vi vay emergency cleanup co the "thanh cong"
// (xoa rat nhieu tin) ma ratio van khong giam ro ret. Can 1 lop phong thu rieng:
// tu choi nhan file/tin nhan moi khi DB van con qua cao SAU KHI da thu cleanup.
const DB_HARD_BLOCK_MEDIA_RATIO = parseFloat(process.env.DB_HARD_BLOCK_MEDIA_RATIO) || 0.95;
const DB_HARD_BLOCK_TEXT_RATIO = parseFloat(process.env.DB_HARD_BLOCK_TEXT_RATIO) || 0.99;
const EMERGENCY_DELETE_BATCH_SIZE = parseInt(process.env.EMERGENCY_DELETE_BATCH_SIZE, 10) || 500;
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000; // 10 phut - nam trong khoang 5-15 phut yeu cau
const MAX_CLEANUP_ITERATIONS_PER_CYCLE = 50; // chan vong lap batch delete chay vo han

if (!DB_STORAGE_LIMIT_MB) {
    console.warn('⚠️  Chua cau hinh DB_STORAGE_LIMIT_MB - tinh nang rolling/emergency cleanup VA hard-block khi ' +
        'DB gan day se KHONG hoat dong, chi con normal retention 48h. Dat bien nay bang dung luong (MB) THUC TE ' +
        'cua goi Postgres ban dang dung tren Render (kiem tra trong Render dashboard, KHONG doan/mac dinh 1024) ' +
        'de bat tinh nang nay.');
} else if (!(DB_WARNING_RATIO < DB_EMERGENCY_RATIO && DB_EMERGENCY_RATIO < DB_HARD_BLOCK_MEDIA_RATIO &&
    DB_HARD_BLOCK_MEDIA_RATIO <= DB_HARD_BLOCK_TEXT_RATIO && DB_TARGET_RATIO < DB_EMERGENCY_RATIO)) {
    console.warn('⚠️  Cac nguong DB_WARNING_RATIO/DB_EMERGENCY_RATIO/DB_TARGET_RATIO/DB_HARD_BLOCK_*_RATIO dang ' +
        'khong theo dung thu tu hop ly (warning < emergency < hard-block-media <= hard-block-text, target < ' +
        'emergency). Kiem tra lai cau hinh, hanh vi cleanup/hard-block co the khong nhu mong doi.');
}

// ===== Media limits (STEP: image/video limits) =====
const MAX_IMAGE_BYTES = parseInt(process.env.MAX_IMAGE_BYTES, 10) || 512000;       // 500 KB
const MAX_VIDEO_BYTES = parseInt(process.env.MAX_VIDEO_BYTES, 10) || 10485760;     // 10 MB
const MAX_TEXT_CHARS = 4000;
const ALLOWED_IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const ALLOWED_VIDEO_MIMES = ['video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska'];

const ALLOWED_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];


// ===================================================================
// AES-256-GCM (ma hoa/giai ma tren SERVER - khong con la E2EE)
// ===================================================================
function loadEncryptionKey() {
    const raw = process.env.MESSAGE_ENCRYPTION_KEY;
    if (raw) {
        let buf = null;
        try { buf = Buffer.from(raw, 'base64'); } catch { /* ignore */ }
        if (!buf || buf.length !== 32) {
            console.error('❌ MESSAGE_ENCRYPTION_KEY khong hop le - phai la chuoi base64 giai ma ra dung 32 byte ' +
                '(tao bang: openssl rand -base64 32).');
            process.exit(1);
        }
        return buf;
    }
    if (process.env.NODE_ENV === 'production') {
        console.error('❌ Thieu MESSAGE_ENCRYPTION_KEY trong moi truong production. Server tu choi khoi dong ' +
            'vi ly do bao mat (khong dung fallback key khong an toan cho production).');
        process.exit(1);
    }
    console.warn('⚠️  Thieu MESSAGE_ENCRYPTION_KEY - dang tao khoa NGAU NHIEN CHI DUNG CHO DEV (mat khi restart, ' +
        'KHONG duoc dung kieu nay cho production).');
    return crypto.randomBytes(32);
}
const ENCRYPTION_KEY = loadEncryptionKey();

function encryptBuffer(buf) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
    const encrypted = Buffer.concat([cipher.update(buf), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return { iv, ciphertext: Buffer.concat([encrypted, authTag]) }; // tag noi vao cuoi ciphertext
}
function decryptBuffer(ivBuf, ciphertextWithTag) {
    const tag = ciphertextWithTag.subarray(ciphertextWithTag.length - 16);
    const encrypted = ciphertextWithTag.subarray(0, ciphertextWithTag.length - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', ENCRYPTION_KEY, ivBuf);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}
function encryptText(text) { return encryptBuffer(Buffer.from(text, 'utf8')); }
function decryptText(ivBuf, ciphertextWithTag) { return decryptBuffer(ivBuf, ciphertextWithTag).toString('utf8'); }

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

// ===================================================================
// Migration runner don gian (khong dung framework ngoai)
// ===================================================================
async function runMigrations() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            filename TEXT PRIMARY KEY,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `);
    const dir = path.join(__dirname, 'migrations');
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
    for (const file of files) {
        const already = await pool.query('SELECT 1 FROM schema_migrations WHERE filename = $1', [file]);
        if (already.rows.length > 0) continue;
        const sql = fs.readFileSync(path.join(dir, file), 'utf8');
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(sql);
            await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
            await client.query('COMMIT');
            console.log(`✅ Migration applied: ${file}`);
        } catch (err) {
            await client.query('ROLLBACK');
            console.error(`❌ Migration failed: ${file}`, err);
            throw err;
        } finally {
            client.release();
        }
    }
}

async function seedAdmin() {
    const existing = await pool.query('SELECT id FROM users WHERE username = $1', [ADMIN_USERNAME]);
    if (existing.rows.length === 0) {
        const hash = await bcrypt.hash(ADMIN_PASSWORD, 10);
        await pool.query(
            `INSERT INTO users (username, password_hash, role, status) VALUES ($1, $2, 'admin', 'approved')`,
            [ADMIN_USERNAME, hash]
        );
        console.log(`✅ Da tao tai khoan admin mac dinh: ${ADMIN_USERNAME}`);
    }
}

// ===================================================================
// Retention: normal (48h) + rolling/emergency cleanup theo dung luong DB
// ===================================================================
async function deleteOldestBatch(limit, onlyOlderThan) {
    let query, params;
    if (onlyOlderThan) {
        query = `DELETE FROM messages WHERE id IN (
                    SELECT id FROM messages WHERE created_at < $1 ORDER BY created_at ASC LIMIT $2
                 ) RETURNING id`;
        params = [onlyOlderThan, limit];
    } else {
        query = `DELETE FROM messages WHERE id IN (
                    SELECT id FROM messages ORDER BY created_at ASC LIMIT $1
                 ) RETURNING id`;
        params = [limit];
    }
    const res = await pool.query(query, params);
    return res.rowCount;
}

async function getDbUsage() {
    if (!DB_STORAGE_LIMIT_MB) return null; // tinh nang tat neu chua cau hinh quota
    const res = await pool.query('SELECT pg_database_size(current_database()) AS bytes');
    const usedMB = Number(res.rows[0].bytes) / (1024 * 1024);
    return { ratio: usedMB / DB_STORAGE_LIMIT_MB, usedMB };
}

// STEP 2A: dung mot bien module-level de cac route (upload media/text) co the
// doc "trang thai storage gan nhat" ma khong phai query pg_database_size() moi
// request (query nay khong cuc nhanh va khong can chinh xac tuyet doi tung giay).
// Duoc refresh moi chu ky cleanup (10 phut) VA truoc khi tra loi 1 request neu
// cache qua cu (xem checkStorageGuard).
let lastKnownUsage = null;
let lastKnownUsageAt = 0;
const USAGE_CACHE_MS = 30 * 1000; // cache toi da 30s truoc khi query lai

async function getDbUsageCached() {
    if (!DB_STORAGE_LIMIT_MB) return null;
    const now = Date.now();
    if (lastKnownUsage && (now - lastKnownUsageAt) < USAGE_CACHE_MS) return lastKnownUsage;
    const usage = await getDbUsage();
    lastKnownUsage = usage;
    lastKnownUsageAt = now;
    return usage;
}

// Kiem tra hard-block truoc khi nhan tin nhan/media moi. QUAN TRONG: day la lop
// phong thu DOC LAP voi emergency cleanup, vi DELETE khong dam bao lam
// pg_database_size() giam ngay (dead tuples - xem ghi chu o dinh nghia hang so
// DB_HARD_BLOCK_*_RATIO ben tren). Neu cleanup khong kip giai phong dung luong,
// hard-block van bao ve DB khoi bi day den 100% roi chet giua chung INSERT.
async function checkStorageGuard(kind) {
    const usage = await getDbUsageCached();
    if (!usage) return { blocked: false }; // tinh nang tat neu chua cau hinh DB_STORAGE_LIMIT_MB
    const threshold = kind === 'media' ? DB_HARD_BLOCK_MEDIA_RATIO : DB_HARD_BLOCK_TEXT_RATIO;
    if (usage.ratio >= threshold) {
        return {
            blocked: true,
            ratio: usage.ratio,
            message: kind === 'media'
                ? 'Hệ thống tạm thời không nhận ảnh/video mới do dung lượng lưu trữ gần đầy. Vui lòng thử lại sau ít phút.'
                : 'Hệ thống đang ở dung lượng lưu trữ nghiêm trọng, tạm thời không thể gửi tin nhắn mới. Vui lòng thử lại sau ít phút.'
        };
    }
    return { blocked: false, ratio: usage.ratio };
}

async function normalRetentionCleanup() {
    const cutoff = new Date(Date.now() - MESSAGE_RETENTION_HOURS * 3600 * 1000);
    let total = 0, deleted, iterations = 0;
    do {
        deleted = await deleteOldestBatch(EMERGENCY_DELETE_BATCH_SIZE, cutoff);
        total += deleted;
        iterations++;
    } while (deleted > 0 && iterations < MAX_CLEANUP_ITERATIONS_PER_CYCLE);
    if (total > 0) console.log(`[RETENTION] Deleted ${total} messages older than ${MESSAGE_RETENTION_HOURS}h`);
}

// STEP 2A - VIET LAI: KHONG con gia dinh "DELETE -> pg_database_size() giam ngay".
// PostgreSQL DELETE chi tao dead tuples; dung luong file tren dia (thu ma
// pg_database_size() do) chi thuc su giam khi VACUUM FULL / pg_repack rewrite
// lai table - nhung 2 lenh do KHONG duoc chay o day vi can khoa manh, block ca
// bang, khong phu hop chay trong 1 background cleanup cua app dang phuc vu
// nguoi dung. VACUUM (khong FULL) an toan hon (chay online, gan nhu khong
// khoa) va CO THE cat bot trang trong o cuoi file neu ranh - nen ta chay no sau
// khi xoa xong nhu mot no luc "best effort", nhung KHONG duoc coi la dam bao.
//
// Vi vay vong lap duoi day:
//   - Log trung thuc ratio THUC TE do duoc sau moi batch (khong suy doan).
//   - Dieu kien dung la: da xoa het tin nhan co the xoa (deleted===0), HOAC
//     dat MAX_CLEANUP_ITERATIONS_PER_CYCLE, HOAC ratio (do that) < target.
//   - Neu vong lap ket thuc ma ratio VAN >= DB_EMERGENCY_RATIO, log WARNING ro
//     rang thay vi "finished" mac dinh - de admin biet cleanup khong du hieu
//     qua ngay lap tuc va hard-block (checkStorageGuard) dang la tuyen phong
//     thu chinh luc nay.
async function emergencyStorageCleanup() {
    let usage = await getDbUsage(); // luon query moi (khong dung cache) de co so lieu chinh xac nhat luc quyet dinh
    if (!usage || usage.ratio < DB_EMERGENCY_RATIO) {
        if (usage) { lastKnownUsage = usage; lastKnownUsageAt = Date.now(); }
        return;
    }

    console.log(`[STORAGE] Database usage: ${(usage.ratio * 100).toFixed(1)}% (${usage.usedMB.toFixed(1)}MB / ${DB_STORAGE_LIMIT_MB}MB)`);
    console.log('[STORAGE] Emergency cleanup started');
    let iterations = 0;
    let totalDeleted = 0;
    let reachedTarget = false;

    while (iterations < MAX_CLEANUP_ITERATIONS_PER_CYCLE) {
        const deleted = await deleteOldestBatch(EMERGENCY_DELETE_BATCH_SIZE, null); // xoa tin cu nhat truoc, bat ke tuoi
        totalDeleted += deleted;
        iterations++;
        if (deleted === 0) {
            console.log('[STORAGE] Không còn message nào để xóa thêm.');
            break; // khong con gi de xoa, dung du ratio co the van cao (xem canh bao ben duoi)
        }
        usage = await getDbUsage(); // do lai THAT SU, khong gia dinh no giam
        console.log(`[STORAGE] Deleted ${deleted} oldest messages (tổng: ${totalDeleted}) - Database usage: ${(usage.ratio * 100).toFixed(1)}%`);
        if (usage.ratio < DB_TARGET_RATIO) { reachedTarget = true; break; }
    }

    lastKnownUsage = usage;
    lastKnownUsageAt = Date.now();

    if (reachedTarget) {
        console.log('[STORAGE] Emergency cleanup finished - đã về dưới target ratio.');
    } else if (usage.ratio >= DB_EMERGENCY_RATIO) {
        console.warn(`[STORAGE] ⚠️ Emergency cleanup kết thúc nhưng usage vẫn ở mức ${(usage.ratio * 100).toFixed(1)}% ` +
            '(>= emergency threshold). DELETE không đảm bảo giảm pg_database_size() ngay lập tức do dead tuples - ' +
            'đây là giới hạn cố hữu của PostgreSQL, không phải cleanup thất bại. Hard-block guard ' +
            `(DB_HARD_BLOCK_MEDIA_RATIO=${DB_HARD_BLOCK_MEDIA_RATIO}) sẽ chặn upload media mới nếu ratio vượt ngưỡng đó.`);
    } else {
        console.log(`[STORAGE] Emergency cleanup finished - usage hiện tại ${(usage.ratio * 100).toFixed(1)}% (dưới emergency threshold).`);
    }

    // Best-effort: khuyen khich Postgres tai su dung / cat bot vung trong o cuoi
    // heap. AN TOAN de chay online (khong phai VACUUM FULL), nhung KHONG dam
    // bao giam dung luong ngay - chi la buoc "co gang them", loi o day khong
    // duoc lam crash cleanup cycle.
    try {
        await pool.query('VACUUM (ANALYZE) messages');
    } catch (err) {
        console.error('[STORAGE] VACUUM (ANALYZE) messages thất bại (bỏ qua, không ảnh hưởng hoạt động chính):', err.message);
    }
}


let cleanupRunning = false; // khoa don gian, du cho 1 instance server (Render Free = 1 instance)
async function runCleanupCycle() {
    if (cleanupRunning) {
        console.log('[CLEANUP] Bo qua chu ky nay vi chu ky truoc van dang chay.');
        return;
    }
    cleanupRunning = true;
    try {
        await normalRetentionCleanup();
        await emergencyStorageCleanup();
    } catch (err) {
        console.error('[CLEANUP] Loi trong chu ky don dep (server van tiep tuc hoat dong binh thuong):', err.message);
    } finally {
        cleanupRunning = false;
    }
}

// ===================================================================
// Middleware
// ===================================================================
app.use(express.json({ limit: '64kb' })); // chi con dung cho auth/text-message/reaction - nho gon
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

app.get('/api/users', authRequired, approvedRequired, async (req, res) => {
    const result = await pool.query(`SELECT username FROM users WHERE status = 'approved' ORDER BY username ASC`);
    res.json({ users: result.rows.map(r => r.username) });
});

// ===================================================================
// Admin routes
// ===================================================================
app.get('/api/admin/users', authRequired, adminRequired, async (req, res) => {
    const result = await pool.query(`SELECT id, username, role, status, created_at FROM users ORDER BY created_at DESC`);
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
// Mentions: server tu trich xuat @username tu plaintext (KHONG tin client)
// ===================================================================
async function extractValidMentions(text) {
    const found = new Set();
    const re = /@([a-zA-Z0-9._-]{3,32})/g;
    let m;
    while ((m = re.exec(text))) found.add(m[1]);
    if (found.size === 0) return [];
    const candidates = Array.from(found);
    const res = await pool.query(
        `SELECT username FROM users WHERE username = ANY($1::text[]) AND status = 'approved'`,
        [candidates]
    );
    return res.rows.map(r => r.username);
}

// ===================================================================
// Messages: doc danh sach (text duoc giai ma san, media chi tra metadata)
// KHONG co endpoint xoa/thu hoi tin nhan (theo yeu cau nghiep vu).
// ===================================================================
app.get('/api/messages', authRequired, approvedRequired, async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const beforeId = parseInt(req.query.beforeId, 10);
    try {
        let result;
        if (beforeId) {
            result = await pool.query(
                `WITH base AS (
                    SELECT id, sender, msg_type, ciphertext, iv, mime_type, byte_size, mentions, created_at
                    FROM messages WHERE id < $1 ORDER BY id DESC LIMIT $2
                 )
                 SELECT b.*, COALESCE(
                    json_agg(json_build_object('emoji', r.emoji, 'username', r.username)) FILTER (WHERE r.id IS NOT NULL),
                    '[]'
                 ) AS reactions
                 FROM base b LEFT JOIN message_reactions r ON r.message_id = b.id
                 GROUP BY b.id, b.sender, b.msg_type, b.ciphertext, b.iv, b.mime_type, b.byte_size, b.mentions, b.created_at
                 ORDER BY b.id ASC`,
                [beforeId, limit]
            );
        } else {
            result = await pool.query(
                `WITH base AS (
                    SELECT id, sender, msg_type, ciphertext, iv, mime_type, byte_size, mentions, created_at
                    FROM messages ORDER BY id DESC LIMIT $1
                 )
                 SELECT b.*, COALESCE(
                    json_agg(json_build_object('emoji', r.emoji, 'username', r.username)) FILTER (WHERE r.id IS NOT NULL),
                    '[]'
                 ) AS reactions
                 FROM base b LEFT JOIN message_reactions r ON r.message_id = b.id
                 GROUP BY b.id, b.sender, b.msg_type, b.ciphertext, b.iv, b.mime_type, b.byte_size, b.mentions, b.created_at
                 ORDER BY b.id ASC`,
                [limit]
            );
        }

        const messages = result.rows.map(row => {
            const out = {
                id: row.id, sender: row.sender, msg_type: row.msg_type, mime_type: row.mime_type,
                byte_size: row.byte_size, mentions: row.mentions, created_at: row.created_at, reactions: row.reactions
            };
            if (row.msg_type === 'text') {
                try {
                    out.text = decryptText(row.iv, row.ciphertext);
                } catch (err) {
                    console.error(`Loi giai ma tin nhan #${row.id}:`, err.message);
                    out.text = '⚠️ Không thể giải mã tin nhắn này.';
                }
            }
            // Anh/video: KHONG gui ciphertext trong danh sach nay. Client tai noi dung
            // qua GET /api/messages/:id/media (tranh JSON khong lo + giam RAM/bang thong).
            return out;
        });

        res.json({
            messages,
            retentionHours: MESSAGE_RETENTION_HOURS,
            maxImageBytes: MAX_IMAGE_BYTES,
            maxVideoBytes: MAX_VIDEO_BYTES,
            allowedReactions: ALLOWED_REACTIONS
        });
    } catch (err) {
        console.error('Loi doc messages:', err);
        res.status(500).json({ error: 'server_error' });
    }
});

// Gui tin nhan TEXT (JSON nho gon, khong con base64 media o day)
app.post('/api/messages', authRequired, approvedRequired, async (req, res) => {
    const { text } = req.body || {};
    if (typeof text !== 'string' || !text.trim()) return res.status(400).json({ error: 'invalid_input' });
    if (text.length > MAX_TEXT_CHARS) {
        return res.status(400).json({ error: 'text_too_long', message: `Tin nhắn tối đa ${MAX_TEXT_CHARS} ký tự.` });
    }
    // STEP 2A hard-block: chi chan text o nguong rat cao (gan nhu day hoan toan) -
    // vi text rat nho, uu tien van cho hoat dong duoc cang lau cang tot.
    const guard = await checkStorageGuard('text');
    if (guard.blocked) return res.status(503).json({ error: 'storage_full', message: guard.message });
    try {
        const mentions = await extractValidMentions(text);
        const { iv, ciphertext } = encryptText(text);
        const result = await pool.query(
            `INSERT INTO messages (sender, msg_type, ciphertext, iv, mime_type, byte_size, mentions)
             VALUES ($1, 'text', $2, $3, NULL, $4, $5)
             RETURNING id, sender, msg_type, mime_type, byte_size, mentions, created_at`,
            [req.user.username, ciphertext, iv, Buffer.byteLength(text, 'utf8'), mentions]
        );
        const message = result.rows[0];
        message.text = text;
        message.reactions = [];
        res.json({ success: true, message });
        broadcastToApproved({ type: 'new_message', message });
    } catch (err) {
        console.error('Loi ghi message (text):', err);
        res.status(500).json({ error: 'server_error' });
    }
});

// ===================================================================
// Upload anh/video: multipart (KHONG con base64 trong JSON), gioi han
// nghiem ngat ca client lan server. Server khong bao gio tin client.
// ===================================================================
const upload = multer({
    storage: multer.memoryStorage(), // buffer bi chan boi limits.fileSize ngay ben duoi -> khong doc vo han vao RAM
    limits: { fileSize: MAX_VIDEO_BYTES, files: 1 }, // gioi han cung o muc lon nhat (video); anh se bi kiem tra rieng ben duoi
    fileFilter: (req, file, cb) => {
        if (ALLOWED_IMAGE_MIMES.includes(file.mimetype) || ALLOWED_VIDEO_MIMES.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('unsupported_mime'));
        }
    }
});

app.post('/api/messages/media', authRequired, approvedRequired, async (req, res, next) => {
    // STEP 2A hard-block: kiem tra TRUOC khi ton cong parse multipart - media
    // (toi da 10MB) la thu day DB nhanh nhat, nen chan o nguong thap hon text.
    const guard = await checkStorageGuard('media');
    if (guard.blocked) return res.status(503).json({ error: 'storage_full', message: guard.message });
    next();
}, (req, res, next) => {
    upload.single('file')(req, res, (err) => {
        if (err) {
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.status(413).json({ error: 'payload_too_large', message: 'File vượt quá giới hạn cho phép.' });
            }
            return res.status(400).json({ error: 'invalid_file', message: 'File không hợp lệ hoặc không được hỗ trợ.' });
        }
        next();
    });
}, async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'no_file' });
    const isImage = ALLOWED_IMAGE_MIMES.includes(req.file.mimetype);
    const isVideo = ALLOWED_VIDEO_MIMES.includes(req.file.mimetype);
    if (!isImage && !isVideo) return res.status(400).json({ error: 'invalid_mime' });

    const limit = isImage ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES;
    if (req.file.size > limit) {
        return res.status(413).json({
            error: 'payload_too_large',
            message: isImage ? 'Ảnh vượt quá 500KB.' : 'Video vượt quá 10MB.'
        });
    }

    try {
        const { iv, ciphertext } = encryptBuffer(req.file.buffer);
        const msgType = isImage ? 'image' : 'video';
        const result = await pool.query(
            `INSERT INTO messages (sender, msg_type, ciphertext, iv, mime_type, byte_size, mentions)
             VALUES ($1, $2, $3, $4, $5, $6, '{}')
             RETURNING id, sender, msg_type, mime_type, byte_size, mentions, created_at`,
            [req.user.username, msgType, ciphertext, iv, req.file.mimetype, req.file.size]
        );
        const message = result.rows[0];
        message.reactions = [];
        res.json({ success: true, message });
        broadcastToApproved({ type: 'new_message', message }); // khong kem noi dung - client khac tu fetch qua /media
        lastKnownUsageAt = 0; // invalidate cache: video toi 10MB co the day ratio len dang ke, muon check tiep theo la so lieu tuoi
    } catch (err) {
        console.error('Loi ghi message (media):', err);
        res.status(500).json({ error: 'server_error' });
    }
});

// Tra noi dung nhi phan da giai ma cho 1 tin nhan anh/video
app.get('/api/messages/:id/media', authRequired, approvedRequired, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).end();
    try {
        const result = await pool.query('SELECT msg_type, mime_type, ciphertext, iv FROM messages WHERE id = $1', [id]);
        if (result.rows.length === 0) return res.status(404).end();
        const row = result.rows[0];
        if (row.msg_type === 'text') return res.status(400).end();
        const buf = decryptBuffer(row.iv, row.ciphertext);
        res.set('Content-Type', row.mime_type || 'application/octet-stream');
        res.set('Content-Length', buf.length);
        res.set('Cache-Control', 'private, max-age=300');
        res.send(buf);
    } catch (err) {
        console.error(`Loi giai ma media #${id}:`, err.message);
        res.status(500).end();
    }
});

// Tha / doi / bo cam xuc len 1 tin nhan - moi user chi giu 1 cam xuc / 1 tin nhan
// (click lai cung 1 emoji se go cam xuc). Day KHONG phai xoa/thu hoi tin nhan.
app.post('/api/messages/:id/react', authRequired, approvedRequired, async (req, res) => {
    const messageId = parseInt(req.params.id, 10);
    const { emoji } = req.body || {};
    if (!messageId || !ALLOWED_REACTIONS.includes(emoji)) {
        return res.status(400).json({ error: 'invalid_input' });
    }
    try {
        const msgExists = await pool.query('SELECT id FROM messages WHERE id = $1', [messageId]);
        if (msgExists.rows.length === 0) return res.status(404).json({ error: 'not_found' });

        const existing = await pool.query(
            'SELECT emoji FROM message_reactions WHERE message_id = $1 AND username = $2',
            [messageId, req.user.username]
        );
        if (existing.rows.length > 0 && existing.rows[0].emoji === emoji) {
            await pool.query('DELETE FROM message_reactions WHERE message_id = $1 AND username = $2', [messageId, req.user.username]);
        } else {
            await pool.query(
                `INSERT INTO message_reactions (message_id, username, emoji) VALUES ($1, $2, $3)
                 ON CONFLICT (message_id, username) DO UPDATE SET emoji = EXCLUDED.emoji, created_at = now()`,
                [messageId, req.user.username, emoji]
            );
        }
        const reactionsRes = await pool.query(
            'SELECT emoji, username FROM message_reactions WHERE message_id = $1 ORDER BY id ASC',
            [messageId]
        );
        const reactions = reactionsRes.rows;
        res.json({ success: true, reactions });
        broadcastToApproved({ type: 'reaction_updated', messageId, reactions });
    } catch (err) {
        console.error('Loi cap nhat reaction:', err);
        res.status(500).json({ error: 'server_error' });
    }
});

// SPA fallback
app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/ws')) return next();
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Error handler chung - khong de server crash vi loi request (multer, JSON malformed, v.v.)
app.use((err, req, res, next) => {
    console.error('Unhandled request error:', err.message);
    if (res.headersSent) return next(err);
    res.status(500).json({ error: 'server_error' });
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
// Khoi dong: migrate -> seed admin -> cleanup ngay (khong doi 5-15 phut
// neu DB dang critical luc restart) -> bat scheduler -> listen.
// ===================================================================
async function start() {
    try {
        await runMigrations();
        await seedAdmin();
        await runCleanupCycle();
        setInterval(runCleanupCycle, CLEANUP_INTERVAL_MS);
        server.listen(PORT, () => {
            console.log(`🚀 Server dang chay tren cong ${PORT}`);
        });
    } catch (err) {
        console.error('❌ Khong the khoi dong server:', err);
        process.exit(1);
    }
}
start();
