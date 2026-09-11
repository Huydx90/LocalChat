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
// STEP NEXT (HEIC): pure-JS/WASM decoder (libheif-js under the hood) - khong can
// bien dich native (khac sharp/libvips), phu hop moi truong Render web service
// binh thuong. Chi dung lam FALLBACK phia server khi client khong tu convert
// duoc (xem prepareImageForUpload() ben client va route /api/messages/media).
const heicConvert = require('heic-convert');
// STEP 2.1: logic phan loai trang thai luu tru duoc tach ra file rieng (THUAN
// TUY, khong Postgres) de co the unit-test toan bo ma tran Case A-J ma khong
// can DB that (xem storage-policy.js va test/storage-policy.test.js).
const { validateThresholds, classifyUsage, formatDiagnostic, parseEnvNumber } = require('./storage-policy');

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
// STEP 2.1 (§25/§26 audit finding): .env.example truoc day chua mot mat khau
// THAT ('14503246') lam fallback mac dinh - neu ai quen dat ADMIN_PASSWORD tren
// Render, server se tao tai khoan admin voi mat khau nay, va gia tri nay lo
// ngay trong .env.example (git). Ap dung DUNG pattern fail-fast da co san cho
// JWT_SECRET/MESSAGE_ENCRYPTION_KEY: khong con fallback mat khau cong khai cho
// production.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
    if (process.env.NODE_ENV === 'production') {
        console.error('❌ Thieu ADMIN_PASSWORD trong moi truong production. Server tu choi khoi dong vi ly do ' +
            'bao mat (khong con fallback mat khau cong khai trong code/.env.example cho production).');
        process.exit(1);
    }
    console.warn('⚠️  Thieu ADMIN_PASSWORD - dang dung mat khau tam CHI DUNG CHO DEV ("dev-only-change-me"). ' +
        'Hay dat ADMIN_PASSWORD tren Render (tab Environment) truoc khi dua vao san xuat.');
}
const EFFECTIVE_ADMIN_PASSWORD = ADMIN_PASSWORD || 'dev-only-change-me';

// ===== Retention / storage config (STEP: rolling retention) =====
// STEP 2.2 (audit finding): pattern cu `parseInt(process.env.X, 10) || default`
// / `parseFloat(process.env.X) || default` AM THAM nuot moi gia tri falsy
// (0, hoac NaN do go sai ten bien vd "abc") thanh default, khong ai biet cho
// toi khi DB day that/gioi han sai ma tuong da cau hinh dung. Tu gio dung
// parseEnvNumber() (storage-policy.js) phan biet ro: chua cau hinh (dung
// default) vs. co cau hinh nhung SAI (throw -> fail-fast ngay khi khoi dong,
// giong het pattern JWT_SECRET/ADMIN_PASSWORD da co san o tren).
let MESSAGE_RETENTION_HOURS, DB_STORAGE_LIMIT_MB, DB_WARNING_RATIO, DB_EMERGENCY_RATIO,
    DB_TARGET_RATIO, DB_HARD_BLOCK_MEDIA_RATIO, DB_HARD_BLOCK_TEXT_RATIO,
    EMERGENCY_DELETE_BATCH_SIZE, MAX_CLEANUP_ITERATIONS_PER_CYCLE,
    MAX_IMAGE_BYTES, MAX_VIDEO_BYTES;

try {
    MESSAGE_RETENTION_HOURS = parseEnvNumber('MESSAGE_RETENTION_HOURS', process.env.MESSAGE_RETENTION_HOURS, 48, { integer: true, min: 1 });
    // DB_STORAGE_LIMIT_MB: unset/blank -> null (tinh nang tat, hop le). Nhung
    // neu DA cau hinh thi phai la so nguyen duong - "abc" hay "0" deu la LOI
    // cau hinh (truoc day bi am tham hieu la "chua cau hinh").
    DB_STORAGE_LIMIT_MB = parseEnvNumber('DB_STORAGE_LIMIT_MB', process.env.DB_STORAGE_LIMIT_MB, null, { integer: true, min: 1 });
    DB_WARNING_RATIO = parseEnvNumber('DB_WARNING_RATIO', process.env.DB_WARNING_RATIO, 0.80);
    DB_EMERGENCY_RATIO = parseEnvNumber('DB_EMERGENCY_RATIO', process.env.DB_EMERGENCY_RATIO, 0.90);
    DB_TARGET_RATIO = parseEnvNumber('DB_TARGET_RATIO', process.env.DB_TARGET_RATIO, 0.75);
    // STEP 2A: hard guard - DELETE khong lam pg_database_size() giam ngay lap tuc (dead
    // tuples, chi VACUUM FULL/pg_repack moi rewrite that su - va khong duoc chay trong
    // request/cleanup loop vi khoa bang). Vi vay emergency cleanup co the "thanh cong"
    // (xoa rat nhieu tin) ma ratio van khong giam ro ret. Can 1 lop phong thu rieng:
    // tu choi nhan file/tin nhan moi khi DB van con qua cao SAU KHI da thu cleanup.
    DB_HARD_BLOCK_MEDIA_RATIO = parseEnvNumber('DB_HARD_BLOCK_MEDIA_RATIO', process.env.DB_HARD_BLOCK_MEDIA_RATIO, 0.95);
    DB_HARD_BLOCK_TEXT_RATIO = parseEnvNumber('DB_HARD_BLOCK_TEXT_RATIO', process.env.DB_HARD_BLOCK_TEXT_RATIO, 0.99);
    EMERGENCY_DELETE_BATCH_SIZE = parseEnvNumber('EMERGENCY_DELETE_BATCH_SIZE', process.env.EMERGENCY_DELETE_BATCH_SIZE, 500, { integer: true, min: 1 });
    // STEP 2.1 §14: chan vong lap batch delete chay vo han, co the cau hinh qua MAX_CLEANUP_ITERATIONS
    MAX_CLEANUP_ITERATIONS_PER_CYCLE = parseEnvNumber('MAX_CLEANUP_ITERATIONS', process.env.MAX_CLEANUP_ITERATIONS, 50, { integer: true, min: 1 });
    // ===== Media limits (STEP: image/video limits) =====
    MAX_IMAGE_BYTES = parseEnvNumber('MAX_IMAGE_BYTES', process.env.MAX_IMAGE_BYTES, 512000, { integer: true, min: 1 });       // 500 KB
    MAX_VIDEO_BYTES = parseEnvNumber('MAX_VIDEO_BYTES', process.env.MAX_VIDEO_BYTES, 10485760, { integer: true, min: 1 });     // 10 MB
} catch (err) {
    console.error('❌ Cau hinh bien moi truong dang so khong hop le: ' + err.message);
    console.error('Server tu choi khoi dong. Sua bien moi truong roi khoi dong lai (blank/unset la hop le va se ' +
        'dung gia tri mac dinh, nhung neu DA dat gia tri thi phai la so hop le trong rang buoc cho phep).');
    process.exit(1);
}

const CLEANUP_INTERVAL_MS = 10 * 60 * 1000; // 10 phut - nam trong khoang 5-15 phut yeu cau

const STORAGE_THRESHOLDS = {
    target: DB_TARGET_RATIO,
    warning: DB_WARNING_RATIO,
    emergency: DB_EMERGENCY_RATIO,
    hardBlockMedia: DB_HARD_BLOCK_MEDIA_RATIO,
    hardBlockText: DB_HARD_BLOCK_TEXT_RATIO,
};

if (!DB_STORAGE_LIMIT_MB) {
    console.warn('⚠️  Chua cau hinh DB_STORAGE_LIMIT_MB - tinh nang rolling/emergency cleanup VA hard-block khi ' +
        'DB gan day se KHONG hoat dong, chi con normal retention 48h. Dat bien nay bang dung luong (MB) THUC TE ' +
        'cua goi Postgres ban dang dung tren Render (kiem tra trong Render dashboard, KHONG doan/mac dinh 1024) ' +
        'de bat tinh nang nay.');
} else {
    // STEP 2.1 §22: FAIL-FAST that su (khong chi warn) neu nguong sai quan he
    // logic - nguong sai co the vo hieu hoa hard-block/emergency cleanup ma
    // khong ai biet cho toi khi DB day that.
    const check = validateThresholds(STORAGE_THRESHOLDS);
    if (!check.valid) {
        console.error('❌ Cau hinh nguong luu tru (DB_WARNING_RATIO/DB_EMERGENCY_RATIO/DB_TARGET_RATIO/' +
            'DB_HARD_BLOCK_MEDIA_RATIO/DB_HARD_BLOCK_TEXT_RATIO) khong hop le:');
        check.errors.forEach(e => console.error('   - ' + e));
        console.error('Server tu choi khoi dong. Sua bien moi truong roi khoi dong lai.');
        process.exit(1);
    }
}

const MAX_TEXT_CHARS = 4000;
const ALLOWED_IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const ALLOWED_VIDEO_MIMES = ['video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska'];
// STEP NEXT (HEIC): anh HEIC/HEIF duoc chap nhan RIENG o day va LUON duoc convert
// sang JPEG truoc khi luu - database/viewer hien tai khong bao gio thay HEIC.
const HEIC_MIMES = ['image/heic', 'image/heif'];
const HEIC_EXT_RE = /\.(heic|heif)$/i;

// STEP NEXT: whitelist dung DUNG danh sach da chot trong spec (👍 ❤️ 😂 😮 😢 😡 🎉).
// KHONG cho arbitrary string - route /api/messages/:id/react kiem tra .includes(emoji).
const ALLOWED_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '😡', '🎉'];


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
        const hash = await bcrypt.hash(EFFECTIVE_ADMIN_PASSWORD, 10);
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
// STEP 2.1 §4/§18: THU TU XOA PHAI TAT DINH - ORDER BY created_at ASC, id ASC
// (khong chi created_at ASC). Nhieu message co the co CUNG created_at (vi du
// gui lien tiep trong cung 1ms, hoac do do phan giai timestamp), luc do can
// tieu chi phu id ASC de ket qua luon nhat quan giua cac lan chay, khong phu
// thuoc vao thu tu vat ly khong xac dinh cua Postgres khi ORDER BY co ties.
async function deleteOldestBatch(limit, onlyOlderThan) {
    let query, params;
    if (onlyOlderThan) {
        query = `DELETE FROM messages WHERE id IN (
                    SELECT id FROM messages WHERE created_at < $1 ORDER BY created_at ASC, id ASC LIMIT $2
                 ) RETURNING id`;
        params = [onlyOlderThan, limit];
    } else {
        query = `DELETE FROM messages WHERE id IN (
                    SELECT id FROM messages ORDER BY created_at ASC, id ASC LIMIT $1
                 ) RETURNING id`;
        params = [limit];
    }
    const res = await pool.query(query, params);
    return res.rowCount;
}

// STEP 2.1 §9/§14: do dung luong that. TRA VE 1 OBJECT CO CO CAU RO RANG thay
// vi null/throw lan lon, de moi noi goi ham nay xu ly tuong minh 3 truong hop
// khac nhau (quota tat / do thanh cong / do THAT BAI) thay vi nham lan
// "khong co quota" voi "loi tam thoi khi query".
//   { disabled: true }                       -> chua cau hinh DB_STORAGE_LIMIT_MB, tinh nang tat
//   { disabled:false, error:true }           -> pg_database_size() that bai (vd mat ket noi tam thoi)
//   { disabled:false, error:false, ratio, usedMB } -> do thanh cong
async function getDbUsage() {
    if (!DB_STORAGE_LIMIT_MB) return { disabled: true, error: false };
    try {
        const res = await pool.query('SELECT pg_database_size(current_database()) AS bytes');
        const usedMB = Number(res.rows[0].bytes) / (1024 * 1024);
        return { disabled: false, error: false, ratio: usedMB / DB_STORAGE_LIMIT_MB, usedMB };
    } catch (err) {
        // Khong log err chi tiet ra ngoai (co the chua thong tin ket noi) - chi
        // log message ngan, khong log DATABASE_URL/secrets (STEP 2.1 §25).
        console.error('[STORAGE] Khong the do dung luong PostgreSQL (pg_database_size that bai), coi nhu ' +
            'KHONG XAC MINH DUOC trang thai luu tru luc nay:', err.message);
        return { disabled: false, error: true };
    }
}

// STEP 2.1 §7/§15: cache toi da 30s DE TRANH goi pg_database_size() qua nhieu
// (moi request upload/text deu goi checkStorageGuard) - nhung cache nay CHI AN
// TOAN khi con CACH XA nguong hard-block. Neu so lieu cache gan nhat da nam
// trong pham vi "an toan margin" duoi DB_HARD_BLOCK_MEDIA_RATIO, BAT BUOC do
// lai THAT thay vi tin cache, vi trong toi da 30s do nhieu upload dong thoi co
// the cung "nhin thay" 1 con so cu va cung vuot nguong ma khong ai bi chan.
// Xa nguong (truong hop pho bien) thi van dung cache de khong lam qua tai DB
// bang hang tram query gan nhu trung lap moi giay.
let lastKnownUsage = null;
let lastKnownUsageAt = 0;
const USAGE_CACHE_MS = 30 * 1000;
const STORAGE_GUARD_FRESH_MARGIN = 0.03; // trong vong 3 diem % duoi hard-block-media -> luon do lai

async function getDbUsageForGuard() {
    const now = Date.now();
    const cacheUsable = lastKnownUsage && !lastKnownUsage.disabled && !lastKnownUsage.error &&
        (now - lastKnownUsageAt) < USAGE_CACHE_MS;
    const cacheNearHardBlock = cacheUsable && lastKnownUsage.ratio >= (DB_HARD_BLOCK_MEDIA_RATIO - STORAGE_GUARD_FRESH_MARGIN);
    if (cacheUsable && !cacheNearHardBlock) return lastKnownUsage;
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
    const usage = await getDbUsageForGuard();
    if (usage.disabled) return { blocked: false }; // tinh nang tat neu chua cau hinh DB_STORAGE_LIMIT_MB
    if (usage.error) {
        // STEP 2.1 §9: khong xac minh duoc dung luong - fail-safe co CHU DICH,
        // khac nhau giua media va text vi rui ro khac nhau:
        //  - Media (anh/video toi 10MB): FAIL-CLOSED. Chap nhan mu quang 1 video
        //    10MB trong luc khong biet DB con trong hay khong la rui ro qua lon.
        //  - Text (vai KB): FAIL-OPEN. Mot lan do dung luong that bai tam thoi
        //    khong nen lam gian doan toan bo chat - loi da duoc log o getDbUsage().
        if (kind === 'media') {
            return {
                blocked: true,
                message: 'Hệ thống tạm thời không thể xác minh dung lượng lưu trữ. Vui lòng thử gửi lại sau ít phút.'
            };
        }
        return { blocked: false };
    }
    const state = classifyUsage(usage.ratio, STORAGE_THRESHOLDS);
    const blocked = kind === 'media' ? state.mediaBlocked : state.textBlocked;
    if (blocked) {
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
    if (iterations >= MAX_CLEANUP_ITERATIONS_PER_CYCLE && deleted > 0) {
        console.warn(`[RETENTION] Dừng ở MAX_CLEANUP_ITERATIONS_PER_CYCLE (${MAX_CLEANUP_ITERATIONS_PER_CYCLE}) - ` +
            'vẫn còn tin nhắn quá hạn retention, sẽ tiếp tục xóa ở chu kỳ tiếp theo.');
    }
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
//   - Dieu kien dung la (STEP 2.1 §14, moi truong hop deu log ro ly do dung):
//     1. da ve duoi target ratio, 2. het tin nhan de xoa, 3. do dung luong
//     that bai giua chung, 4. dat MAX_CLEANUP_ITERATIONS_PER_CYCLE.
//   - Neu vong lap ket thuc ma ratio VAN >= DB_EMERGENCY_RATIO, log WARNING ro
//     rang thay vi "finished" mac dinh - de admin biet cleanup khong du hieu
//     qua ngay lap tuc va hard-block (checkStorageGuard) dang la tuyen phong
//     thu chinh luc nay.
// STEP 2.1: nhan "prefetchedUsage" tuy chon de tranh 1 lan query pg_database_size()
// thua khi ham goi (checkStorageAndMaybeCleanup) da vua do xong.
async function emergencyStorageCleanup(prefetchedUsage) {
    let usage = prefetchedUsage || await getDbUsage();
    if (usage.disabled) return;
    if (usage.error) {
        console.error('[STORAGE] Bỏ qua emergency cleanup chu kỳ này vì không đo được dung lượng (sẽ thử lại ở chu kỳ sau).');
        return;
    }
    if (usage.ratio < DB_EMERGENCY_RATIO) {
        lastKnownUsage = usage; lastKnownUsageAt = Date.now();
        return;
    }

    console.log(formatDiagnostic('[STORAGE]', usage.usedMB, DB_STORAGE_LIMIT_MB, usage.ratio));
    console.log('[STORAGE] Emergency cleanup started');
    let iterations = 0;
    let totalDeleted = 0;
    let stopReason = null;

    while (iterations < MAX_CLEANUP_ITERATIONS_PER_CYCLE) {
        const deleted = await deleteOldestBatch(EMERGENCY_DELETE_BATCH_SIZE, null); // xoa tin cu nhat truoc, bat ke tuoi
        totalDeleted += deleted;
        iterations++;
        if (deleted === 0) {
            stopReason = 'no_more_rows';
            console.log('[STORAGE] Không còn message nào để xóa thêm.');
            break;
        }
        usage = await getDbUsage(); // do lai THAT SU, khong gia dinh no giam
        if (usage.error) {
            stopReason = 'measurement_failed';
            console.error(`[STORAGE] Dừng emergency cleanup giữa chừng (đã xóa ${totalDeleted}) vì không đo lại được dung lượng.`);
            break;
        }
        console.log(`[STORAGE] Deleted ${deleted} oldest messages (tổng: ${totalDeleted}) - Database usage: ${(usage.ratio * 100).toFixed(1)}%`);
        if (usage.ratio < DB_TARGET_RATIO) { stopReason = 'target_reached'; break; }
    }
    if (!stopReason) {
        stopReason = 'max_iterations';
        console.warn(`[STORAGE] Dừng emergency cleanup vì đạt MAX_CLEANUP_ITERATIONS_PER_CYCLE (${MAX_CLEANUP_ITERATIONS_PER_CYCLE}), sẽ tiếp tục ở chu kỳ sau.`);
    }

    if (!usage.error) { lastKnownUsage = usage; lastKnownUsageAt = Date.now(); }

    if (stopReason === 'target_reached') {
        console.log('[STORAGE] Emergency cleanup finished - đã về dưới target ratio.');
    } else if (!usage.error && usage.ratio >= DB_EMERGENCY_RATIO) {
        console.warn(`[STORAGE] ⚠️ Emergency cleanup kết thúc (lý do: ${stopReason}) nhưng usage vẫn ở mức ` +
            `${(usage.ratio * 100).toFixed(1)}% (>= emergency threshold). DELETE không đảm bảo giảm pg_database_size() ` +
            'ngay lập tức do dead tuples - đây là giới hạn cố hữu của PostgreSQL, không phải cleanup thất bại. ' +
            `Hard-block guard (DB_HARD_BLOCK_MEDIA_RATIO=${DB_HARD_BLOCK_MEDIA_RATIO}) sẽ chặn upload media mới nếu ratio vượt ngưỡng đó.`);
    } else if (!usage.error) {
        console.log(`[STORAGE] Emergency cleanup finished (lý do: ${stopReason}) - usage hiện tại ${(usage.ratio * 100).toFixed(1)}% (dưới emergency threshold).`);
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

// STEP 2.1 §3: canh bao thuc su khi usage vao vung [WARNING, EMERGENCY) - truoc
// day DB_WARNING_RATIO CHI duoc dinh nghia/validate nhung KHONG bao gio thuc su
// log canh bao. Chay 1 lan moi chu ky cleanup (10 phut/lan, KHONG phai moi
// request) va CHI log khi MOI VAO vung canh bao (rate-limit tu nhien qua
// "warnedAboveThreshold") de tranh spam log lien tuc trong khi van o nguyen
// trang thai canh bao trong nhieu gio.
let warnedAboveThreshold = false;
async function checkStorageAndMaybeCleanup() {
    const usage = await getDbUsage();
    if (usage.disabled) return;
    if (usage.error) {
        console.error('[STORAGE] Bỏ qua kiểm tra cảnh báo/emergency chu kỳ này vì không đo được dung lượng.');
        return;
    }
    lastKnownUsage = usage; lastKnownUsageAt = Date.now();

    const state = classifyUsage(usage.ratio, STORAGE_THRESHOLDS);
    if (state.emergencyCleanup) {
        warnedAboveThreshold = false; // reset - emergencyStorageCleanup tu log chi tiet rieng
        await emergencyStorageCleanup(usage);
        return;
    }
    if (state.warning) {
        if (!warnedAboveThreshold) {
            console.warn(`[STORAGE WARNING] PostgreSQL storage usage is ${(usage.ratio * 100).toFixed(1)}% ` +
                `(${usage.usedMB.toFixed(1)} MB / ${DB_STORAGE_LIMIT_MB} MB)`);
            warnedAboveThreshold = true;
        }
    } else {
        warnedAboveThreshold = false;
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
        await checkStorageAndMaybeCleanup();
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
// Reply: server tu doc tin nhan duoc reply (theo id client gui len) va tao
// 1 "snapshot" PLAINTEXT (sender + doan trich text/nhan dien loai media) de
// luu kem tin nhan moi - cung nguyen tac voi "mentions" (metadata hien thi,
// khong phai noi dung ma hoa chinh). KHONG tin id client gui la hop le -
// truy van lai DB, neu khong ton tai thi coi nhu khong reply gi ca.
// ===================================================================
const REPLY_PREVIEW_MAX_CHARS = 140;
async function buildReplySnapshot(rawReplyToId) {
    const replyToId = parseInt(rawReplyToId, 10);
    if (!replyToId) return { reply_to_id: null, reply_to_sender: null, reply_to_preview: null };
    const result = await pool.query(
        'SELECT id, sender, msg_type, ciphertext, iv FROM messages WHERE id = $1',
        [replyToId]
    );
    if (result.rows.length === 0) return { reply_to_id: null, reply_to_sender: null, reply_to_preview: null };
    const row = result.rows[0];
    let preview;
    if (row.msg_type === 'text') {
        try {
            const text = decryptText(row.iv, row.ciphertext);
            preview = text.length > REPLY_PREVIEW_MAX_CHARS ? text.slice(0, REPLY_PREVIEW_MAX_CHARS) + '…' : text;
        } catch (err) {
            preview = '⚠️ Không thể giải mã tin nhắn này.';
        }
    } else if (row.msg_type === 'image') {
        preview = '📷 Hình ảnh';
    } else {
        preview = '🎥 Video';
    }
    return { reply_to_id: row.id, reply_to_sender: row.sender, reply_to_preview: preview };
}

// ===================================================================
// Messages: doc danh sach (text duoc giai ma san, media chi tra metadata)
// ===================================================================
app.get('/api/messages', authRequired, approvedRequired, async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const beforeId = parseInt(req.query.beforeId, 10);
    try {
        let result;
        if (beforeId) {
            result = await pool.query(
                `WITH base AS (
                    SELECT id, sender, msg_type, ciphertext, iv, mime_type, byte_size, mentions, created_at,
                           reply_to_id, reply_to_sender, reply_to_preview
                    FROM messages WHERE id < $1 ORDER BY id DESC LIMIT $2
                 )
                 SELECT b.*, COALESCE(
                    json_agg(json_build_object('emoji', r.emoji, 'username', r.username)) FILTER (WHERE r.id IS NOT NULL),
                    '[]'
                 ) AS reactions
                 FROM base b LEFT JOIN message_reactions r ON r.message_id = b.id
                 GROUP BY b.id, b.sender, b.msg_type, b.ciphertext, b.iv, b.mime_type, b.byte_size, b.mentions, b.created_at,
                          b.reply_to_id, b.reply_to_sender, b.reply_to_preview
                 ORDER BY b.id ASC`,
                [beforeId, limit]
            );
        } else {
            result = await pool.query(
                `WITH base AS (
                    SELECT id, sender, msg_type, ciphertext, iv, mime_type, byte_size, mentions, created_at,
                           reply_to_id, reply_to_sender, reply_to_preview
                    FROM messages ORDER BY id DESC LIMIT $1
                 )
                 SELECT b.*, COALESCE(
                    json_agg(json_build_object('emoji', r.emoji, 'username', r.username)) FILTER (WHERE r.id IS NOT NULL),
                    '[]'
                 ) AS reactions
                 FROM base b LEFT JOIN message_reactions r ON r.message_id = b.id
                 GROUP BY b.id, b.sender, b.msg_type, b.ciphertext, b.iv, b.mime_type, b.byte_size, b.mentions, b.created_at,
                          b.reply_to_id, b.reply_to_sender, b.reply_to_preview
                 ORDER BY b.id ASC`,
                [limit]
            );
        }

        const messages = result.rows.map(row => {
            const out = {
                id: row.id, sender: row.sender, msg_type: row.msg_type, mime_type: row.mime_type,
                byte_size: row.byte_size, mentions: row.mentions, created_at: row.created_at, reactions: row.reactions,
                reply_to_id: row.reply_to_id, reply_to_sender: row.reply_to_sender, reply_to_preview: row.reply_to_preview
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
    const { text, replyToId } = req.body || {};
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
        const reply = await buildReplySnapshot(replyToId);
        const result = await pool.query(
            `INSERT INTO messages (sender, msg_type, ciphertext, iv, mime_type, byte_size, mentions,
                                    reply_to_id, reply_to_sender, reply_to_preview)
             VALUES ($1, 'text', $2, $3, NULL, $4, $5, $6, $7, $8)
             RETURNING id, sender, msg_type, mime_type, byte_size, mentions, created_at,
                       reply_to_id, reply_to_sender, reply_to_preview`,
            [req.user.username, ciphertext, iv, Buffer.byteLength(text, 'utf8'), mentions,
             reply.reply_to_id, reply.reply_to_sender, reply.reply_to_preview]
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
// HEIC/HEIF: nhan dien that su bang magic bytes (ISO-BMFF "ftyp" box), KHONG
// tin vao mimetype/extension do client tu bao (nhieu OS/browser gui mimetype
// rong hoac application/octet-stream cho HEIC). Day la lop validate CUOI CUNG
// truoc khi quyet dinh co convert hay khong.
// ===================================================================
const HEIC_BRANDS = ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1', 'heim', 'heis', 'hevm', 'hevs'];
function looksLikeHeicBuffer(buf) {
    if (!buf || buf.length < 12) return false;
    if (buf.toString('ascii', 4, 8) !== 'ftyp') return false;
    const brand = buf.toString('ascii', 8, 12).toLowerCase();
    return HEIC_BRANDS.includes(brand);
}

// Convert 1 buffer HEIC/HEIF sang JPEG buffer. Thu giam quality 1 lan neu ket
// qua dau tien vuot MAX_IMAGE_BYTES (server khong co pipeline resize day du
// nhu client - canvas - nen chi con don bay quality de co gang lot duoi gioi
// han truoc khi phai reject).
async function convertHeicToJpeg(buf) {
    let out = await heicConvert({ buffer: buf, format: 'JPEG', quality: 0.82 });
    if (out.length > MAX_IMAGE_BYTES) {
        out = await heicConvert({ buffer: buf, format: 'JPEG', quality: 0.5 });
    }
    return out;
}

// ===================================================================
// Upload anh/video: multipart (KHONG con base64 trong JSON), gioi han
// nghiem ngat ca client lan server. Server khong bao gio tin client.
// ===================================================================
const upload = multer({
    storage: multer.memoryStorage(), // buffer bi chan boi limits.fileSize ngay ben duoi -> khong doc vo han vao RAM
    limits: { fileSize: MAX_VIDEO_BYTES, files: 1 }, // gioi han cung o muc lon nhat (video); anh se bi kiem tra rieng ben duoi
    fileFilter: (req, file, cb) => {
        const nameLooksHeic = HEIC_EXT_RE.test(file.originalname || '');
        if (
            ALLOWED_IMAGE_MIMES.includes(file.mimetype) ||
            ALLOWED_VIDEO_MIMES.includes(file.mimetype) ||
            HEIC_MIMES.includes(file.mimetype) ||
            // Mot so trinh duyet/OS gui mimetype rong hoac application/octet-stream cho
            // HEIC - chi tam chap nhan qua fileFilter dua vao extension, buffer se duoc
            // sniff bang magic bytes (looksLikeHeicBuffer) trong route handler truoc khi
            // thuc su tin day la HEIC. Khong noi long cho bat ky loai file nao khac.
            ((file.mimetype === 'application/octet-stream' || !file.mimetype) && nameLooksHeic)
        ) {
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

    // STEP NEXT (HEIC fallback): client (heic2any) la duong chinh - da convert
    // + nen san thanh JPEG truoc khi den day. Nhanh nay CHI chay khi client
    // khong convert duoc (browser khong ho tro) va gui thang file HEIC goc len.
    // Nhan dien bang magic bytes that su, khong tin mimetype/extension client gui.
    const declaredHeic = HEIC_MIMES.includes(req.file.mimetype) || HEIC_EXT_RE.test(req.file.originalname || '');
    if (declaredHeic || looksLikeHeicBuffer(req.file.buffer)) {
        if (!looksLikeHeicBuffer(req.file.buffer)) {
            // Duoi/mimetype noi la HEIC nhung magic bytes khong khop -> khong tin, reject.
            return res.status(400).json({ error: 'invalid_file', message: 'File không đúng định dạng HEIC/HEIF.' });
        }
        try {
            const jpegBuf = await convertHeicToJpeg(req.file.buffer);
            if (jpegBuf.length > MAX_IMAGE_BYTES) {
                return res.status(413).json({
                    error: 'payload_too_large',
                    message: 'Ảnh HEIC sau khi chuyển đổi vẫn vượt quá 500KB. Vui lòng thử ảnh khác hoặc dùng trình duyệt hỗ trợ chuyển đổi HEIC (Safari/Chrome bản mới).'
                });
            }
            req.file.buffer = jpegBuf;
            req.file.mimetype = 'image/jpeg';
            req.file.size = jpegBuf.length;
        } catch (err) {
            console.error('Loi convert HEIC tren server:', err.message);
            return res.status(400).json({
                error: 'heic_conversion_failed',
                message: 'Không thể chuyển đổi ảnh HEIC này. Vui lòng thử ảnh khác hoặc chụp/gửi lại ở định dạng JPEG.'
            });
        }
    }

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
        // req.body.replyToId: multer da parse xong cac field text cua multipart
        // truoc khi route handler nay chay, nen co san o day giong nhu JSON body.
        const reply = await buildReplySnapshot(req.body && req.body.replyToId);
        const result = await pool.query(
            `INSERT INTO messages (sender, msg_type, ciphertext, iv, mime_type, byte_size, mentions,
                                    reply_to_id, reply_to_sender, reply_to_preview)
             VALUES ($1, $2, $3, $4, $5, $6, '{}', $7, $8, $9)
             RETURNING id, sender, msg_type, mime_type, byte_size, mentions, created_at,
                       reply_to_id, reply_to_sender, reply_to_preview`,
            [req.user.username, msgType, ciphertext, iv, req.file.mimetype, req.file.size,
             reply.reply_to_id, reply.reply_to_sender, reply.reply_to_preview]
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

// Xoa tin nhan (CHI ADMIN). Khac voi "khong the xoa/thu hoi" cua STEP truoc -
// day la yeu cau nghiep vu moi, gioi han rieng cho admin (adminRequired).
// message_reactions bi xoa theo (ON DELETE CASCADE). Cac tin nhan reply toi
// tin nay se mat reply_to_id (ON DELETE SET NULL) nhung van giu duoc
// reply_to_sender/reply_to_preview (snapshot) de UI tiep tuc hien thi trich dan.
app.delete('/api/messages/:id', authRequired, adminRequired, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'invalid_input' });
    try {
        const result = await pool.query('DELETE FROM messages WHERE id = $1 RETURNING id', [id]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'not_found' });
        res.json({ success: true, id });
        broadcastToApproved({ type: 'message_deleted', id });
    } catch (err) {
        console.error('Loi xoa message:', err);
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
        console.warn(`[WS] Tu choi ket noi - token khong hop le/het han (co token: ${!!token})`);
        ws.close(4001, 'unauthorized');
        return;
    }
    console.log(`[WS] Ket noi thanh cong: user=${payload.username} role=${payload.role}`);
    ws.userPayload = payload;
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('close', (code, reason) => {
        console.log(`[WS] Dong ket noi: user=${payload.username} code=${code} reason=${reason}`);
    });
    ws.on('error', (err) => {
        console.error(`[WS] Loi ket noi: user=${payload.username}`, err.message);
    });
});

// STEP DEBUG (tam thoi de chan doan WS "failed" tren Render): log moi lan HTTP
// server nhan duoc yeu cau UPGRADE (buoc bat tay dau tien cua WebSocket, TRUOC
// khi toi duoc wss.on('connection') o tren). Neu KHONG thay dong nay xuat hien
// khi client bao "WebSocket connection ... failed", nghia la request khong toi
// duoc tien trinh Node nay - loi nam o tang ngoai (proxy/Render/trinh duyet/
// extension), khong phai logic server. Neu THAY dong nay nhung sau do khong
// thay "[WS] Ket noi thanh cong" / "[WS] Tu choi ket noi", loi nam trong buoc
// xu ly upgrade cua thu vien ws.
server.on('upgrade', (req) => {
    console.log(`[WS] Nhan duoc yeu cau upgrade: ${req.url}`);
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
