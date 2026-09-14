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
// STEP 3.2: cung nguyen tac voi storage-policy.js o tren - logic validation
// THUAN TUY (ID nghiem ngat, control-char filter, magic-byte detection,
// prototype-pollution guard) duoc tach rieng de unit-test duoc ma khong can
// Express/Postgres/network (xem test/input-validation.test.js).
const {
    parsePositiveIntStrict, parseNonNegativeIntStrict, DISALLOWED_CONTROL_CHARS_RE,
    looksLikeHeicBuffer, IMAGE_SIGNATURE_CHECKS, VIDEO_SIGNATURE_CHECKS,
    rejectDangerousKeys,
} = require('./input-validation');
// STEP 3.3: rate limiting / concurrency-guard / IP extraction - THUAN TUY
// (khong Express/Postgres/network), xem rate-limit.js cho ly do kien truc
// (in-memory O(1), 1-process, thiet ke de sau nay thay bang Redis khong can
// sua code goi) va test/rate-limit.test.js cho unit test doc lap.
const { RateLimiter, ConcurrencyGuard, getHttpClientIp, getWsClientIp } = require('./rate-limit');

const app = express();
// FINAL STEP 3.3 FIX: "trust proxy" duoc dat la FALSE tuong minh - KHONG con
// dua vao "dem so hop trong X-Forwarded-For" nua (ca "true" lan "1" o 2 vong
// audit truoc deu dua tren gia dinh ve SO LUONG proxy phia truoc app ma
// khong the xac minh chac chan cho 1 PaaS cong khai nhu Render, noi co the
// co them CDN/edge (vd Cloudflare) hoac nhieu lop proxy noi bo khac ma app
// khong biet truoc). Voi "trust proxy: false", Express KHONG doc bat ky
// X-Forwarded-* header nao de tinh `req.ip`/`req.secure` nua - `req.ip` luon
// la dia chi socket TCP thuc su (khong the bi client gia mao qua header).
//
// IP dung cho rate-limit KHONG con lay tu `req.ip` cua Express nua (xem
// getHttpClientIp()/getWsClientIp() trong rate-limit.js) - thay vao do:
//   - Neu deployment THAT SU dat sau Cloudflare VA nguoi van hanh da xac
//     nhan dieu do, bat TRUST_CF_CONNECTING_IP=true (bien moi truong duoi
//     day) de dung header "CF-Connecting-IP" (Cloudflare edge GHI DE, khong
//     phai append, nen KHONG the bi client tu thiet lap NEU request thuc su
//     di qua Cloudflare va origin duoc khoa chi nhan tu Cloudflare).
//   - Mac dinh (chua bat co nay) - dung THANG dia chi socket TCP, AN TOAN
//     theo huong "fail-closed": co the qua chat (nhieu client sau cung 1
//     proxy se "trung" 1 dia chi) nhung KHONG BAO GIO bi client bypass.
// Xem giai thich day du (bao gom gioi han/gia dinh CHUA kiem chung) trong
// rate-limit.js va README.
app.set('trust proxy', false);
const server = http.createServer(app);
// STEP 3.3 §15: "const wss = new WebSocket.Server(...)" duoc KHOI TAO O DUOI,
// SAU khi doc xong MAX_WS_MESSAGE_BYTES tu bien moi truong (option
// "maxPayload" chi doc duoc luc KHOI TAO WebSocketServer, khong the gan lai
// sau) - xem dinh nghia thuc su gan "wss" gan cuoi khoi cau hinh STEP 3.3 o duoi.
let wss;

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

// ===================================================================
// STEP 3.3: Rate limiting / abuse protection config.
//
// Cung nguyen tac fail-fast voi cac bien o tren (STEP 2.2): dung
// parseEnvNumber() - "chua cau hinh" -> dung default hop ly; "co cau hinh
// nhung sai" (vd "abc", "-1", "0") -> throw -> server tu choi khoi dong,
// KHONG am tham fallback ve default (spec §39: "khong duoc silently accept
// malformed security configuration").
//
// Cac gia tri default o day la BASELINE tu spec STEP 3.3 (§5/§6/§7/§8/§9/§11/
// §14/§15) - co the dieu chinh qua .env neu can, xem .env.example.
// ===================================================================
let LOGIN_RATE_LIMIT_IP_MAX, LOGIN_RATE_LIMIT_IP_WINDOW_MS,
    LOGIN_RATE_LIMIT_ACCOUNT_MAX, LOGIN_RATE_LIMIT_ACCOUNT_WINDOW_MS,
    REGISTER_RATE_LIMIT_MAX, REGISTER_RATE_LIMIT_WINDOW_MS,
    MESSAGE_RATE_LIMIT_PER_MINUTE, MESSAGE_RATE_LIMIT_BURST_MAX, MESSAGE_RATE_LIMIT_BURST_WINDOW_MS,
    UPLOAD_RATE_LIMIT_PER_MINUTE, UPLOAD_RATE_LIMIT_PER_HOUR,
    MAX_CONCURRENT_UPLOADS_PER_USER, MAX_CONCURRENT_UPLOADS_PER_IP,
    WS_CONNECT_RATE_LIMIT_MAX, WS_CONNECT_RATE_LIMIT_WINDOW_MS, MAX_WS_CONNECTIONS_PER_IP,
    MAX_WS_MESSAGE_BYTES, WS_MESSAGE_RATE_LIMIT_PER_MINUTE;

try {
    // --- Login brute-force (spec §5: 2 lop - IP va account) ---
    LOGIN_RATE_LIMIT_IP_MAX = parseEnvNumber('LOGIN_RATE_LIMIT_IP_MAX', process.env.LOGIN_RATE_LIMIT_IP_MAX, 5, { integer: true, min: 1 });
    LOGIN_RATE_LIMIT_IP_WINDOW_MS = parseEnvNumber('LOGIN_RATE_LIMIT_IP_WINDOW_MS', process.env.LOGIN_RATE_LIMIT_IP_WINDOW_MS, 5 * 60 * 1000, { integer: true, min: 1000 });
    LOGIN_RATE_LIMIT_ACCOUNT_MAX = parseEnvNumber('LOGIN_RATE_LIMIT_ACCOUNT_MAX', process.env.LOGIN_RATE_LIMIT_ACCOUNT_MAX, 5, { integer: true, min: 1 });
    LOGIN_RATE_LIMIT_ACCOUNT_WINDOW_MS = parseEnvNumber('LOGIN_RATE_LIMIT_ACCOUNT_WINDOW_MS', process.env.LOGIN_RATE_LIMIT_ACCOUNT_WINDOW_MS, 10 * 60 * 1000, { integer: true, min: 1000 });
    // --- Registration abuse (spec §6) - dem MOI request (ke ca bi tu choi vi
    // validation), khong chi dem dang ky THANH CONG, de chan flood request tho ---
    REGISTER_RATE_LIMIT_MAX = parseEnvNumber('REGISTER_RATE_LIMIT_MAX', process.env.REGISTER_RATE_LIMIT_MAX, 20, { integer: true, min: 1 });
    REGISTER_RATE_LIMIT_WINDOW_MS = parseEnvNumber('REGISTER_RATE_LIMIT_WINDOW_MS', process.env.REGISTER_RATE_LIMIT_WINDOW_MS, 60 * 60 * 1000, { integer: true, min: 1000 });
    // --- Message spam (spec §7) - 2 lop: burst ngan + per-minute ---
    MESSAGE_RATE_LIMIT_PER_MINUTE = parseEnvNumber('MESSAGE_RATE_LIMIT_PER_MINUTE', process.env.MESSAGE_RATE_LIMIT_PER_MINUTE, 30, { integer: true, min: 1 });
    MESSAGE_RATE_LIMIT_BURST_MAX = parseEnvNumber('MESSAGE_RATE_LIMIT_BURST_MAX', process.env.MESSAGE_RATE_LIMIT_BURST_MAX, 5, { integer: true, min: 1 });
    MESSAGE_RATE_LIMIT_BURST_WINDOW_MS = parseEnvNumber('MESSAGE_RATE_LIMIT_BURST_WINDOW_MS', process.env.MESSAGE_RATE_LIMIT_BURST_WINDOW_MS, 5000, { integer: true, min: 1000 });
    // --- Upload rate + concurrency (spec §8/§9) ---
    UPLOAD_RATE_LIMIT_PER_MINUTE = parseEnvNumber('UPLOAD_RATE_LIMIT_PER_MINUTE', process.env.UPLOAD_RATE_LIMIT_PER_MINUTE, 5, { integer: true, min: 1 });
    UPLOAD_RATE_LIMIT_PER_HOUR = parseEnvNumber('UPLOAD_RATE_LIMIT_PER_HOUR', process.env.UPLOAD_RATE_LIMIT_PER_HOUR, 20, { integer: true, min: 1 });
    MAX_CONCURRENT_UPLOADS_PER_USER = parseEnvNumber('MAX_CONCURRENT_UPLOADS_PER_USER', process.env.MAX_CONCURRENT_UPLOADS_PER_USER, 2, { integer: true, min: 1 });
    MAX_CONCURRENT_UPLOADS_PER_IP = parseEnvNumber('MAX_CONCURRENT_UPLOADS_PER_IP', process.env.MAX_CONCURRENT_UPLOADS_PER_IP, 5, { integer: true, min: 1 });
    // --- WebSocket flood protection (spec §11/§14/§15) ---
    WS_CONNECT_RATE_LIMIT_MAX = parseEnvNumber('WS_CONNECT_RATE_LIMIT_MAX', process.env.WS_CONNECT_RATE_LIMIT_MAX, 10, { integer: true, min: 1 });
    WS_CONNECT_RATE_LIMIT_WINDOW_MS = parseEnvNumber('WS_CONNECT_RATE_LIMIT_WINDOW_MS', process.env.WS_CONNECT_RATE_LIMIT_WINDOW_MS, 60 * 1000, { integer: true, min: 1000 });
    MAX_WS_CONNECTIONS_PER_IP = parseEnvNumber('MAX_WS_CONNECTIONS_PER_IP', process.env.MAX_WS_CONNECTIONS_PER_IP, 5, { integer: true, min: 1 });
    MAX_WS_MESSAGE_BYTES = parseEnvNumber('MAX_WS_MESSAGE_BYTES', process.env.MAX_WS_MESSAGE_BYTES, 65536, { integer: true, min: 1 }); // 64 KB
    WS_MESSAGE_RATE_LIMIT_PER_MINUTE = parseEnvNumber('WS_MESSAGE_RATE_LIMIT_PER_MINUTE', process.env.WS_MESSAGE_RATE_LIMIT_PER_MINUTE, 30, { integer: true, min: 1 });
} catch (err) {
    console.error('❌ Cau hinh rate-limit/abuse-protection khong hop le: ' + err.message);
    console.error('Server tu choi khoi dong. Sua bien moi truong roi khoi dong lai.');
    process.exit(1);
}

// ===================================================================
// STEP 4: Performance tuning config (fail-fast, cung nguyen tac voi cac bien
// o tren). Cac gia tri nay CHI anh huong hieu nang/tai nguyen, KHONG anh huong
// security control nao cua STEP 3.
// ===================================================================
let MAX_CONCURRENT_HEIC_CONVERSIONS, WS_MAX_BUFFERED_BYTES, DB_POOL_MAX,
    DB_POOL_IDLE_TIMEOUT_MS, DB_POOL_CONNECTION_TIMEOUT_MS;
try {
    // STEP 4 §10.1: HEIC conversion (giai ma WASM qua heic-convert) rat ton CPU.
    // Concurrency guard STEP 3.3 (MAX_CONCURRENT_UPLOADS_PER_USER/IP) chi gioi
    // han theo TUNG user/IP - 2 user KHAC nhau (moi nguoi trong quota rieng cua
    // ho) van co the vo tinh cung luc convert HEIC, canh tranh 1 lieu CPU duy
    // nhat tren Render Free. Day la GIOI HAN TOAN CUC (global), doc lap voi user/IP.
    MAX_CONCURRENT_HEIC_CONVERSIONS = parseEnvNumber('MAX_CONCURRENT_HEIC_CONVERSIONS', process.env.MAX_CONCURRENT_HEIC_CONVERSIONS, 1, { integer: true, min: 1 });
    // STEP 4 §14: WebSocket backpressure - neu 1 client cham (mang yeu, tab bi
    // treo...) khong kip tieu thu du lieu, thu vien "ws" se tu xep hang du lieu
    // cho no trong bo nho ("ws.bufferedAmount" tang dan). KHONG gioi han se cho
    // phep 1 client cham lam RAM server phinh to vo han qua thoi gian (broadcast
    // lien tuc cho ca client do trong khi no khong bao gio "bat kip"). 1MB mac
    // dinh la du rong rai cho chat text/thong bao (khong phai media - media di
    // qua HTTP rieng, khong qua WS).
    WS_MAX_BUFFERED_BYTES = parseEnvNumber('WS_MAX_BUFFERED_BYTES', process.env.WS_MAX_BUFFERED_BYTES, 1024 * 1024, { integer: true, min: 1024 });
    // STEP 4 §22: PostgreSQL connection pool - truoc STEP nay dung MAC DINH cua
    // thu vien "pg" (max=10, idleTimeoutMillis=10000, connectionTimeoutMillis=0)
    // MOT CACH NGAM (khong khai bao tuong minh). Gia tri mac dinh o day GIU
    // NGUYEN dung 3 con so do (KHONG doi hanh vi neu khong cau hinh) - chi lam
    // TUONG MINH + CO THE CHINH duoc qua .env cho phu hop Render Free (it RAM,
    // Postgres Free cung gioi han so connection dong thoi).
    DB_POOL_MAX = parseEnvNumber('DB_POOL_MAX', process.env.DB_POOL_MAX, 10, { integer: true, min: 1 });
    DB_POOL_IDLE_TIMEOUT_MS = parseEnvNumber('DB_POOL_IDLE_TIMEOUT_MS', process.env.DB_POOL_IDLE_TIMEOUT_MS, 10000, { integer: true, min: 1000 });
    DB_POOL_CONNECTION_TIMEOUT_MS = parseEnvNumber('DB_POOL_CONNECTION_TIMEOUT_MS', process.env.DB_POOL_CONNECTION_TIMEOUT_MS, 0, { integer: true, min: 0 });
} catch (err) {
    console.error('❌ Cau hinh performance-tuning (STEP 4) khong hop le: ' + err.message);
    console.error('Server tu choi khoi dong. Sua bien moi truong roi khoi dong lai.');
    process.exit(1);
}

// FINAL STEP 3.3 FIX: TRUST_CF_CONNECTING_IP - CO/KHONG tin header
// "CF-Connecting-IP" (Cloudflare edge) lam nguon IP client cho rate-limit.
// Mac dinh AN TOAN la "false" (KHONG tin) - CHI bat "true" khi nguoi van
// hanh DA XAC NHAN deployment nay THAT SU dat sau Cloudflare VA origin (app
// tren Render) duoc cau hinh de CHI nhan ket noi tu Cloudflare (khong ai co
// the ket noi thang toi app ma bo qua Cloudflare). Neu bat gia tri nay ma
// gia dinh do SAI, attacker co the tu gui header "CF-Connecting-IP" gia mao
// va bypass hoan toan rate-limit theo IP - xem giai thich day du trong
// rate-limit.js va README.
//
// Fail-fast tren gia tri khong hop le (khac "true"/"false"/rong) - dung y
// STEP 2/3.2/3.3: khong am tham chap nhan cau hinh sai dinh dang.
let TRUST_CF_CONNECTING_IP;
{
    const raw = (process.env.TRUST_CF_CONNECTING_IP || '').trim().toLowerCase();
    if (raw === '' || raw === 'false' || raw === '0') {
        TRUST_CF_CONNECTING_IP = false;
    } else if (raw === 'true' || raw === '1') {
        TRUST_CF_CONNECTING_IP = true;
    } else {
        console.error(`❌ Cau hinh TRUST_CF_CONNECTING_IP khong hop le: "${process.env.TRUST_CF_CONNECTING_IP}" (chi chap nhan "true"/"false"/de trong).`);
        console.error('Server tu choi khoi dong. Sua bien moi truong roi khoi dong lai.');
        process.exit(1);
    }
}
const IP_RESOLVER_OPTIONS = { trustCfConnectingIp: TRUST_CF_CONNECTING_IP };

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
// STEP 3.3: khoi tao cac RateLimiter/ConcurrencyGuard - 1 instance moi loai,
// SONG SUOT VONG DOI process (dung y __một process duy nhất__ - xem
// rate-limit.js). Khong query Postgres cho rate-limit (spec §35: "khong
// query PostgreSQL cho moi request chi de rate-limit neu khong can").
// ===================================================================
const loginIpLimiter = new RateLimiter({ windowMs: LOGIN_RATE_LIMIT_IP_WINDOW_MS, max: LOGIN_RATE_LIMIT_IP_MAX });
const loginAccountLimiter = new RateLimiter({ windowMs: LOGIN_RATE_LIMIT_ACCOUNT_WINDOW_MS, max: LOGIN_RATE_LIMIT_ACCOUNT_MAX });
const registerIpLimiter = new RateLimiter({ windowMs: REGISTER_RATE_LIMIT_WINDOW_MS, max: REGISTER_RATE_LIMIT_MAX });
const messageUserMinuteLimiter = new RateLimiter({ windowMs: 60 * 1000, max: MESSAGE_RATE_LIMIT_PER_MINUTE });
const messageUserBurstLimiter = new RateLimiter({ windowMs: MESSAGE_RATE_LIMIT_BURST_WINDOW_MS, max: MESSAGE_RATE_LIMIT_BURST_MAX });
const uploadUserMinuteLimiter = new RateLimiter({ windowMs: 60 * 1000, max: UPLOAD_RATE_LIMIT_PER_MINUTE });
const uploadUserHourLimiter = new RateLimiter({ windowMs: 60 * 60 * 1000, max: UPLOAD_RATE_LIMIT_PER_HOUR });
const concurrentUploadsPerUser = new ConcurrencyGuard({ max: MAX_CONCURRENT_UPLOADS_PER_USER });
const concurrentUploadsPerIp = new ConcurrencyGuard({ max: MAX_CONCURRENT_UPLOADS_PER_IP });
// STEP 4 §10.1: gioi han TOAN CUC (khong phai theo user/IP) so luong HEIC
// conversion dang chay dong thoi - dung 1 key hang so ('global') vi day la
// tai nguyen CPU DUY NHAT cua ca process, khong phai tai nguyen rieng cho
// tung user/IP.
const concurrentHeicConversions = new ConcurrencyGuard({ max: MAX_CONCURRENT_HEIC_CONVERSIONS });
const HEIC_CONCURRENCY_GLOBAL_KEY = 'global';
const wsConnectIpLimiter = new RateLimiter({ windowMs: WS_CONNECT_RATE_LIMIT_WINDOW_MS, max: WS_CONNECT_RATE_LIMIT_MAX });
const concurrentWsConnectionsPerIp = new ConcurrencyGuard({ max: MAX_WS_CONNECTIONS_PER_IP });
const wsMessageUserLimiter = new RateLimiter({ windowMs: 60 * 1000, max: WS_MESSAGE_RATE_LIMIT_PER_MINUTE });

// STEP 3.3 §35: don rac dinh ky cho TAT CA RateLimiter o tren (KHONG cho
// ConcurrencyGuard - entry cua no tu xoa het ngay khi release() ve 0, khong
// can sweep dinh ky) - tranh Map phinh to vo han neu attacker tao rat nhieu
// key khac nhau (nhieu IP/username khac nhau) trong thoi gian dai.
const RATE_LIMIT_SWEEP_INTERVAL_MS = 5 * 60 * 1000; // 5 phut
setInterval(() => {
    for (const limiter of [
        loginIpLimiter, loginAccountLimiter, registerIpLimiter,
        messageUserMinuteLimiter, messageUserBurstLimiter,
        uploadUserMinuteLimiter, uploadUserHourLimiter,
        wsConnectIpLimiter, wsMessageUserLimiter,
    ]) limiter.sweep();
}, RATE_LIMIT_SWEEP_INTERVAL_MS);

// STEP 3.3 §38: response 429 THONG NHAT - KHONG leak username/IP/limiter key/
// counter noi bo ra response (chi Retry-After + message chung chung).
function sendRateLimited(res, retryAfterSeconds, message) {
    res.set('Retry-After', String(Math.max(1, Math.round(retryAfterSeconds || 1))));
    res.status(429).json({ error: 'rate_limited', message: message || 'Bạn thao tác quá nhanh, vui lòng thử lại sau.' });
}

// STEP 3.3 §15: khoi tao WebSocketServer THAT SU o day (sau khi
// MAX_WS_MESSAGE_BYTES da duoc doc xong) voi "maxPayload" - gioi han cung do
// thu vien "ws" tu choi/dong ket noi voi ma 1009 (Message Too Big) NGAY O
// TANG PROTOCOL truoc khi bat ky buffer nao duoc cap phat day du cho 1 frame
// qua lon, khong can code tu kiem tra kich thuoc thu cong.
wss = new WebSocket.Server({ server, path: '/ws', maxPayload: MAX_WS_MESSAGE_BYTES });

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
    ssl: isExternalUrl ? { rejectUnauthorized: false } : false,
    // STEP 4 §22: truoc day dung MAC DINH ngam cua "pg" - gio KHAI BAO TUONG
    // MINH (gia tri mac dinh GIU NGUYEN dung mac dinh cu cua thu vien, KHONG
    // doi hanh vi neu .env khong cau hinh gi them) de de audit/tuning cho
    // Render Free sau nay.
    max: DB_POOL_MAX,
    idleTimeoutMillis: DB_POOL_IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: DB_POOL_CONNECTION_TIMEOUT_MS,
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

// STEP 3.2 §27 + STEP 3.3 §17: security headers cho MOI response (ca
// /api/messages/:id/media lan cac response JSON/HTML khac).
//
// STEP 3.3 §17 audit truoc khi viet CSP (KHONG ap dat CSP "mu quang" - xem
// bao cao chi tiet trong README/final report):
//   - script-src: chi 2 nguon duoc dung THAT SU - "self" (/app.js) va
//     https://cdn.jsdelivr.net (heic2any@0.0.4, CDN duy nhat cua app). KHONG
//     co <script> inline nao trong public/index.html/app.js, KHONG dung
//     eval()/new Function() o dau ca -> KHONG can 'unsafe-inline'/'unsafe-eval'.
//   - style-src: chi 1 file CSS noi bo (/style.css qua <link>), KHONG co
//     <style> inline hay style="..." attribute nao trong index.html, KHONG
//     dung .cssText/.setAttribute('style', ...) trong app.js (chi dung
//     .style.<property> = ... qua CSSOM, KHONG bi CSP style-src chan) -> chi
//     can 'self', KHONG can 'unsafe-inline'.
//   - img-src/media-src: anh/video hien thi qua createObjectURL() (blob:) -
//     can "blob:". KHONG dung data: URI o dau -> khong can them "data:".
//   - connect-src: toan bo fetch()/WebSocket deu goi VE CHINH SERVER NAY
//     (relative path hoac location.host) - "self" la du (CSP anh xa "self"
//     tu dong sang ws/wss cung origin), KHONG can mo rong ra ngoai.
//   - object-src 'none': khong dung Flash/plugin nao.
//   - frame-ancestors 'none' + X-Frame-Options: DENY: app khong duoc thiet
//     ke de nhung trong <iframe> cua trang khac.
// GIOI HAN CON LAI (ghi ro, khong gia vo da giai quyet - xem README): CDN
// "cdn.jsdelivr.net" van la 1 dependency ben ngoai (soft-fail: neu bi mang
// cong ty chan, HEIC convert client-side that bai va rung xuong server-side
// fallback co san - KHONG lam vo UI). De sau nay siet CSP chat hon nua (bo
// han CDN khoi script-src), co the vendor hoa heic2any.min.js vao
// public/vendor/ va phuc vu tu server nay - de xuat migration, CHUA lam o
// STEP nay (ngoai pham vi, xem "OUT OF SCOPE / FOLLOW-UP").
const CSP_HEADER = [
    "default-src 'self'",
    "script-src 'self' https://cdn.jsdelivr.net",
    "style-src 'self'",
    "img-src 'self' blob:",
    "media-src 'self' blob:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
].join('; ');
app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'DENY');
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    // Chi tat cac quyen browser app KHONG he dung (audit xac nhan: khong
    // getUserMedia/geolocation/payment...) - KHONG dua "clipboard-write" vao
    // day vi nut "Copy" (navigator.clipboard.writeText) dang dung tinh nang do.
    res.set('Permissions-Policy', 'geolocation=(), camera=(), microphone=(), payment=(), usb=(), magnetometer=(), gyroscope=(), interest-cohort=()');
    res.set('Content-Security-Policy', CSP_HEADER);
    // FINAL STEP 3.3 FIX: Strict-Transport-Security - CHI gui khi request
    // THAT SU la HTTPS. "trust proxy" gio la false (khong con dua vao dem-so-
    // hop XFF cho IP nua - xem giai thich o dau file), nen `req.secure` cua
    // Express se LUON la false tren Render (Render terminate TLS o edge roi
    // forward HTTP thuan toi app - `req.secure` chi true cho ket noi TLS TRUC
    // TIEP toi chinh process nay, khong bao gio xay ra tren Render). Vi vay
    // doc THANG header "X-Forwarded-Proto" o day, KHONG qua co che "trust
    // proxy" chung. Day la lua chon AN TOAN CHAP NHAN DUOC (khac voi IP-based
    // rate-limit): neu client tu gui "X-Forwarded-Proto: https" gia khi ket
    // noi that su la HTTP, hau qua DUY NHAT la server GUI THEM 1 header yeu
    // cau trinh duyet uu tien HTTPS cho lan sau - KHONG mo ra bat ky bypass
    // bao mat nao (khac han voi viec tin sai IP, co the bypass rate-limit).
    const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
    if (isHttps) {
        res.set('Strict-Transport-Security', 'max-age=15552000; includeSubDomains'); // 180 ngay
    }
    next();
});

// STEP 3.3 §18 CORS audit: app hien tai la SAME-ORIGIN THUAN TUY (frontend
// duoc chinh Express nay phuc vu qua express.static() + SPA fallback, KHONG
// co frontend nao chay tren domain/port khac goi API nay). Audit xac nhan
// KHONG co dong nao set "Access-Control-Allow-Origin" hay dung package
// "cors" trong toan bo source/package.json truoc STEP nay. Dung nguyen tac
// spec §18 ("khong duoc thay doi CORS neu project hien tai khong su dung
// CORS"): KHONG them CORS middleware nao o STEP 3.3 - trinh duyet se tu
// chan moi request cross-origin toi API nay theo Same-Origin Policy mac
// dinh, dung y muon.

// STEP 3.2 §13: audit hien tai KHONG thay Object.assign(...)/{...req.body}/
// for..in nao merge truc tiep req.body vao user/admin/config model - nhung
// van chan tuong minh cac key nguy hiem ngay o middleware chung (phong truong
// hop code sau nay vo tinh them 1 cho merge object ma khong ai de y lai rui ro
// prototype pollution). Tu choi 400 ngay khi phat hien, khong am tham bo qua.
// (Dinh nghia trong input-validation.js de co the unit-test doc lap.)
app.use(rejectDangerousKeys);

// STEP 4 §25: cache modest cho static assets (app.js/style.css/index.html).
// KHONG dat maxAge dai (vd hang ngay/tuan) vi project HIEN TAI khong co co
// che cache-busting (index.html tham chieu thang "/app.js"/"/style.css",
// khong co query-string version/hash) - cache qua dai co the khien trinh
// duyet tiep tuc dung JS/CSS CU sau khi deploy ban moi, gay loi kho debug.
// 10 phut la muc thoa hiep AN TOAN: giam dang ke so request lap lai trong 1
// phien lam viec binh thuong, nhung "do tre cap nhat" toi da sau deploy chi
// la vai phut, khong phai hang gio/ngay. "etag: true" (mac dinh cua Express)
// van giu nguyen - validate lai dung noi dung qua conditional request (304)
// ngay ca trong cua so 10 phut do neu trinh duyet chu dong revalidate.
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '10m' }));

function signToken(user) {
    return jwt.sign(
        { id: user.id, username: user.username, role: user.role, status: user.status },
        EFFECTIVE_JWT_SECRET,
        { expiresIn: '30d', algorithm: 'HS256' }
    );
}

// STEP 3.1 (Authentication/Authorization/IDOR hardening — audit finding, MỨC ĐỘ CAO):
// TRUOC DAY authRequired chi verify CHU KY JWT roi tin THANG role/status "dong
// bang" trong payload tu luc dang nhap. JWT co han 30 ngay (xem signToken) - neu
// admin REVOKE hoac XOA mot user SAU KHI ho da co token, token cu do (van hop le
// ve chu ky) se TIEP TUC duoc coi la "approved"/dung role cu cho toi khi het han
// 30 ngay, vi khong co gi kiem tra lai DB. Day la lo hong authorization nghiem
// trong (xem STEP 3.1 §17 trong spec audit).
//
// Fix: JWT gio CHI con dung de XAC THUC DANH TINH (id nao dang goi, chu ky hop
// le). Moi request authRequired LUON doc lai role/status THAT TU DATABASE va
// GAN DE LEN req.user - khong noi nao con doc role/status truc tiep tu payload
// JWT nua. Chi phi: 1 query nho/request - chap nhan duoc voi quy mo chat noi bo,
// va la cach don gian nhat de dong hoan toan "stale JWT" window MA KHONG CAN xay
// them ha tang session/token-blacklist/redis rieng (dung dung nguyen tac spec:
// uu tien security thuc te hon la chi "chu ky JWT hop le").
async function authRequired(req, res, next) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'unauthorized' });
    let payload;
    try {
        payload = jwt.verify(token, EFFECTIVE_JWT_SECRET, { algorithms: ['HS256'] });
    } catch (err) {
        return res.status(401).json({ error: 'invalid_token' });
    }
    if (!payload || !Number.isInteger(payload.id)) return res.status(401).json({ error: 'invalid_token' });
    try {
        const result = await pool.query('SELECT id, username, role, status FROM users WHERE id = $1', [payload.id]);
        if (result.rows.length === 0) {
            // Tai khoan da bi admin xoa - token cu (dung ve chu ky) khong con giu duoc gia tri gi.
            return res.status(401).json({ error: 'account_deleted' });
        }
        req.user = result.rows[0]; // FRESH tu DB - moi middleware/route phia sau CHI duoc doc tu day
        next();
    } catch (err) {
        console.error('Loi xac thuc (doc lai user tu DB):', err.message);
        res.status(500).json({ error: 'server_error' });
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

// STEP 3.3 FIX §2: bcrypt hash CO DINH, HOP LE, tao SAN 1 LAN duy nhat (KHONG
// bao gio duoc tao moi/goi bcrypt.hash() trong luc xu ly request login - lam
// vay se tu no gay ra 1 do tre CPU khac biet, phan tac dung chong-timing).
// Chuoi nay CHI dung de bcrypt.compare() co viec ma lam (chi phi CPU giong
// het so sanh voi 1 hash that) khi username KHONG TON TAI trong DB - noi dung
// mat khau ma no "tuong ung" khong quan trong va KHONG BAO GIO duoc dung de
// xac dinh ket qua dang nhap (xem route /api/auth/login). Day la dinh dang
// bcrypt chuan (cost=10, cung cost voi bcrypt.hash(password, 10) o route dang
// ky ben duoi) - vi du hash cong khai, quen thuoc, thuong thay trong tai lieu
// bcrypt (KHONG phai hash cua mat khau that nao dang dung trong he thong nay).
const DUMMY_PASSWORD_HASH = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';

app.post('/api/auth/register', async (req, res) => {
    // STEP 3.3 §6: dem MOI request (ke ca bi tu choi vi validation sau) theo
    // IP - chan flood request tho TRUOC KHI ton cong query DB kiem tra trung
    // username. KHONG dem theo username (client co the doi username moi lan).
    const ip = getHttpClientIp(req, IP_RESOLVER_OPTIONS);
    const ipCheck = registerIpLimiter.consume(ip);
    if (!ipCheck.allowed) {
        return sendRateLimited(res, ipCheck.retryAfterSeconds, 'Bạn đăng ký quá nhiều lần, vui lòng thử lại sau.');
    }
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

    // STEP 3.3 FIX §1 — ATOMIC ADMISSION (khac phien ban truoc: KHONG con dung
    // peek() truoc bcrypt/DB nua). tryConsume() la operation DONG BO, KHONG co
    // "await" ben trong (xem chu thich chi tiet trong rate-limit.js) - goi NGAY
    // LAP TUC o day, TRUOC BAT KY await nao (truy van DB, bcrypt.compare), dam
    // bao N request dong thoi se lan luot tang dung bo dem tung cai mot, KHONG
    // request nao co the "nhin thay" quota con trong khi cac request khac cung
    // dang cho DB/bcrypt roi tat ca cung duoc coi la hop le.
    //
    // Ca 2 limiter deu duoc tieu thu (consume) cho MOI lan goi - THANH CONG
    // hay THAT BAI deu tinh - vi ban than viec "giu cho" (reservation) phai
    // xay ra TRUOC KHI biet ket qua. Neu login THANH CONG, limiter account-level
    // se duoc reset() lai hoan toan ben duoi (dung yeu cau: "login thanh cong
    // phai reset account-level failure counter"). Limiter IP-level KHONG bao
    // gio duoc reset lai (ke ca khi thanh cong) - day la chu dinh: IP-level la
    // thong so ve LUU LUONG request tu 1 dia chi, khong phai "danh gia dung/sai
    // 1 tai khoan", va KHONG reset de tranh attacker de dang "rua" lai quota
    // IP chi bang 1 lan dang nhap dung xen giua nhieu lan sai.
    const ip = getHttpClientIp(req, IP_RESOLVER_OPTIONS);
    const ipCheck = loginIpLimiter.tryConsume(ip);
    if (!ipCheck.allowed) {
        return sendRateLimited(res, ipCheck.retryAfterSeconds, 'Quá nhiều lần đăng nhập từ địa chỉ này, vui lòng thử lại sau.');
    }
    const accountCheck = loginAccountLimiter.tryConsume(username);
    if (!accountCheck.allowed) {
        return sendRateLimited(res, accountCheck.retryAfterSeconds, 'Tài khoản này đang tạm khóa đăng nhập do quá nhiều lần thử, vui lòng thử lại sau.');
    }

    try {
        const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
        const user = result.rows.length > 0 ? result.rows[0] : null;
        // STEP 3.3 FIX §2 — CHONG TIMING-BASED ACCOUNT ENUMERATION: LUON goi
        // bcrypt.compare() CHO CA HAI truong hop (user ton tai / khong ton tai),
        // KHONG BAO GIO "bo qua" bcrypt chi vi khong tim thay user - neu bo qua,
        // nhanh "user khong ton tai" se tra loi NHANH HON ro ret so voi nhanh
        // "sai mat khau" (vi thieu hang chuc mili-giay tinh toan bcrypt cost=10),
        // tao ra 1 timing side-channel de attacker do va suy ra username nao
        // TON TAI trong he thong du response/status giong het nhau.
        //
        // DUNG_PASSWORD_HASH la 1 bcrypt hash CO DINH, HOP LE, tao SAN 1 LAN
        // (khong phai moi request) - dung lam "mat khau gia" de bcrypt.compare()
        // thuc hien DU cong suc tinh toan CPU giong het nhu khi so sanh voi 1
        // hash that. KET QUA cua lan so sanh nay (dummyMatches) KHONG BAO GIO
        // duoc dung de quyet dinh thanh cong/that bai khi user khong ton tai -
        // luon la that bai trong truong hop do, bat ke bcrypt.compare() tra ve
        // gi (xem dieu kien "!user || !passwordMatches" ben duoi).
        const passwordHash = user ? user.password_hash : DUMMY_PASSWORD_HASH;
        const passwordMatches = await bcrypt.compare(password, passwordHash);
        if (!user || !passwordMatches) {
            // (Da tryConsume() ca 2 limiter o TRUOC try-block roi - KHONG
            // consume() lai o day, tranh tinh 2 lan cho cung 1 request.)
            // Message/status GIONG HET nhau cho "khong ton tai" va "sai mat
            // khau" - KHONG leak user co ton tai/role/status/pending-revoked.
            return res.status(401).json({ error: 'bad_credentials', message: 'Sai ten dang nhap hoac mat khau.' });
        }
        loginAccountLimiter.reset(username);
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
    const id = parsePositiveIntStrict(req.params.id);
    if (id === null) return res.status(400).json({ error: 'invalid_input' });
    const result = await pool.query(
        `UPDATE users SET status = 'approved' WHERE id = $1 RETURNING id, username, role, status`, [id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'not_found' });
    res.json({ success: true, user: result.rows[0] });
    notifyUser(result.rows[0].username, { type: 'status_changed', status: 'approved' });
});

app.post('/api/admin/users/:id/revoke', authRequired, adminRequired, async (req, res) => {
    const id = parsePositiveIntStrict(req.params.id);
    if (id === null) return res.status(400).json({ error: 'invalid_input' });
    const result = await pool.query(
        `UPDATE users SET status = 'pending' WHERE id = $1 AND role != 'admin' RETURNING id, username, role, status`, [id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'not_found' });
    res.json({ success: true, user: result.rows[0] });
    notifyUser(result.rows[0].username, { type: 'status_changed', status: 'pending' });
});

app.delete('/api/admin/users/:id', authRequired, adminRequired, async (req, res) => {
    const id = parsePositiveIntStrict(req.params.id);
    if (id === null) return res.status(400).json({ error: 'invalid_input' });
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
    // STEP 3.2 §11/§12: replyToId la metadata TUY CHON, khong phai 1 tham so
    // bat buoc dung dinh dang - client gui sai kieu (object/array/chuoi la/so
    // am/thap phan) chi duoc coi nhu "khong reply gi ca" (tra ve null het),
    // TUYET DOI khong duoc lam crash hoac lam sai lech y nghia query.
    const replyToId = parsePositiveIntStrict(rawReplyToId);
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
    // STEP 3.2 §11: validate NGHIEM NGAT bang parsePositiveIntStrict/
    // parseNonNegativeIntStrict thay vi parseInt() long leo - parseInt("-1")===-1
    // (truthy!) va parseInt("1abc")===1 truoc day co the lot qua kiem tra loose.
    // Neu client CO gui beforeId/afterId nhung sai dinh dang, tu choi ro rang
    // bang 400 thay vi am tham suy doan/bo qua.
    if (req.query.limit !== undefined && parsePositiveIntStrict(req.query.limit) === null) {
        return res.status(400).json({ error: 'invalid_input', message: 'limit không hợp lệ.' });
    }
    if (req.query.beforeId !== undefined && parsePositiveIntStrict(req.query.beforeId) === null) {
        return res.status(400).json({ error: 'invalid_input', message: 'beforeId không hợp lệ.' });
    }
    if (req.query.afterId !== undefined && parseNonNegativeIntStrict(req.query.afterId) === null) {
        return res.status(400).json({ error: 'invalid_input', message: 'afterId không hợp lệ.' });
    }
    const rawLimit = parsePositiveIntStrict(req.query.limit);
    const limit = Math.min(rawLimit || 50, 200);
    const beforeId = req.query.beforeId !== undefined ? parsePositiveIntStrict(req.query.beforeId) : null;
    const afterId = req.query.afterId !== undefined ? parseNonNegativeIntStrict(req.query.afterId) : null;
    try {
        let result;
        if (afterId !== null) {
            result = await pool.query(
                `WITH base AS (
                    SELECT id, sender, msg_type, ciphertext, iv, mime_type, byte_size, mentions, created_at,
                           reply_to_id, reply_to_sender, reply_to_preview
                    FROM messages WHERE id > $1 ORDER BY id ASC LIMIT $2
                 )
                 SELECT b.*, COALESCE(
                    json_agg(json_build_object('emoji', r.emoji, 'username', r.username)) FILTER (WHERE r.id IS NOT NULL),
                    '[]'
                 ) AS reactions
                 FROM base b LEFT JOIN message_reactions r ON r.message_id = b.id
                 GROUP BY b.id, b.sender, b.msg_type, b.ciphertext, b.iv, b.mime_type, b.byte_size, b.mentions, b.created_at,
                          b.reply_to_id, b.reply_to_sender, b.reply_to_preview
                 ORDER BY b.id ASC`,
                [afterId, limit]
            );
        } else if (beforeId !== null) {
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
    // STEP 3.3 §7: message spam protection - 2 lop (burst ngan + per-phut),
    // theo USER (khong theo IP - nhieu user co the dung chung mang cong ty/NAT,
    // rate-limit theo IP se phat nham nguoi khac). Kiem tra TRUOC khi lam bat
    // ky viec gi ton kem (encrypt/extract mention/query reply/insert DB).
    const userKey = String(req.user.id);
    const burst = messageUserBurstLimiter.consume(userKey);
    if (!burst.allowed) return sendRateLimited(res, burst.retryAfterSeconds, 'Bạn đang gửi tin nhắn quá nhanh, vui lòng chậm lại.');
    const perMinute = messageUserMinuteLimiter.consume(userKey);
    if (!perMinute.allowed) return sendRateLimited(res, perMinute.retryAfterSeconds, 'Bạn đã gửi quá nhiều tin nhắn trong 1 phút, vui lòng thử lại sau.');
    const { text, replyToId } = req.body || {};
    if (typeof text !== 'string' || !text.trim()) return res.status(400).json({ error: 'invalid_input' });
    if (text.length > MAX_TEXT_CHARS) {
        return res.status(400).json({ error: 'text_too_long', message: `Tin nhắn tối đa ${MAX_TEXT_CHARS} ký tự.` });
    }
    // STEP 3.2 §4/§5: tu choi ky tu dieu khien "vo hinh" (null byte va cac C0
    // control khac \n \r \t) - KHONG anh huong Unicode/emoji/tieng Viet hop le
    // (van cho phep xuong dong \n, tab \t, carriage return \r trong tin nhan
    // nhieu dong), chi chan cac byte co the gay loi hien thi/log injection.
    if (DISALLOWED_CONTROL_CHARS_RE.test(text)) {
        return res.status(400).json({ error: 'invalid_input', message: 'Tin nhắn chứa ký tự không hợp lệ.' });
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
//
// STEP 3.2 §17/§18: ham nay va toan bo magic-byte check cho anh/video thuong
// (looksLikeJpeg/Png/Gif/Webp/IsoBmffContainer/Ebml, IMAGE_SIGNATURE_CHECKS,
// VIDEO_SIGNATURE_CHECKS) gio nam trong input-validation.js (require o dau
// file) de co the unit-test doc lap voi Express/Postgres - xem
// test/input-validation.test.js. Truoc STEP 3.2, server chi kiem tra
// req.file.mimetype (Content-Type do CLIENT tu khai bao trong multipart,
// KHONG dang tin cay) va coi nhu du; attacker co the doi Content-Type field
// thanh "image/jpeg" trong khi noi dung thuc su la file bat ky. Cac ham
// import o tren doc THAT vai byte dau file de xac nhan noi dung THAT SU khop
// voi mimetype da khai bao, ap dung ngay ben duoi trong route upload.
// ===================================================================

// Convert 1 buffer HEIC/HEIF sang JPEG buffer. Thu giam quality 1 lan neu ket
// qua dau tien vuot MAX_IMAGE_BYTES (server khong co pipeline resize day du
// nhu client - canvas - nen chi con don bay quality de co gang lot duoi gioi
// han truoc khi phai reject).
//
// STEP 3.2 §21/§22: heic-convert (libheif-js/WASM) khong expose tuy chon
// timeout/resource-limit truc tiep, va kien truc hien tai (1 process Node don,
// khong worker_threads/child_process rieng cho conversion) KHONG duoc thay doi
// trong STEP nay (spec §22: "khong tu y spawn worker architecture moi chi cho
// STEP 3.2"). Ta bao boc lenh goi bang Promise.race + timeout de dam bao
// REQUEST HANDLER khong bao gio treo vo han cho 1 file HEIC doc hai (se tra
// loi 400 sau khi het HEIC_CONVERT_TIMEOUT_MS thay vi hang mai) - day la lop
// phong thu "best effort" o muc request/response, KHONG dam bao thu hoi duoc
// CPU/memory da tieu ton boi phep tinh WASM dang chay (gioi han co huu cua
// JavaScript don luong); rui ro decompression-bomb ve kich thuoc anh giai ma
// van con ton tai va duoc ghi nhan la known limitation (xem README/report).
const HEIC_CONVERT_TIMEOUT_MS = 15000;
function convertHeicWithTimeout(buf, quality) {
    return Promise.race([
        heicConvert({ buffer: buf, format: 'JPEG', quality }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('heic_convert_timeout')), HEIC_CONVERT_TIMEOUT_MS))
    ]);
}
async function convertHeicToJpeg(buf) {
    let out = await convertHeicWithTimeout(buf, 0.82);
    if (out.length > MAX_IMAGE_BYTES) {
        out = await convertHeicWithTimeout(buf, 0.5);
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

app.post('/api/messages/media', authRequired, approvedRequired, async (req, res) => {
    const ip = getHttpClientIp(req, IP_RESOLVER_OPTIONS);
    const userKey = String(req.user.id);

    // STEP 3.3 §8: upload rate limit (per-user, 2 lop: /phut va /gio) - kiem
    // tra cang SOM cang tot (truoc concurrency guard/storage guard/multer),
    // vi day la buoc RE nhat de tu choi 1 request qua gioi han.
    const perMinute = uploadUserMinuteLimiter.consume(userKey);
    if (!perMinute.allowed) return sendRateLimited(res, perMinute.retryAfterSeconds, 'Bạn tải lên quá nhiều file trong 1 phút, vui lòng thử lại sau.');
    const perHour = uploadUserHourLimiter.consume(userKey);
    if (!perHour.allowed) return sendRateLimited(res, perHour.retryAfterSeconds, 'Bạn đã đạt giới hạn tải lên trong giờ này, vui lòng thử lại sau.');

    // STEP 3.3 §9: concurrent upload guard (per-user VA per-IP). PHAI acquire
    // TRUOC KHI multer bat dau doc/buffer file vao RAM (memoryStorage) - day
    // chinh la tai nguyen can bao ve (spec §9: "attacker co the mo nhieu
    // request song song de tieu RAM truoc khi server kip reject"). PHAI duoc
    // release trong finally/close-handler ben duoi cho MOI duong thoat (thanh
    // cong, loi validation, loi multer, loi HEIC, loi DB, client dong ket noi
    // giua chung) - xem test/rate-limit.test.js cho hanh vi ConcurrencyGuard.
    if (!concurrentUploadsPerUser.tryAcquire(userKey)) {
        return res.status(429).json({ error: 'too_many_concurrent_uploads', message: 'Bạn đang có quá nhiều lượt tải lên cùng lúc, vui lòng đợi rồi thử lại.' });
    }
    if (!concurrentUploadsPerIp.tryAcquire(ip)) {
        concurrentUploadsPerUser.release(userKey);
        return res.status(429).json({ error: 'too_many_concurrent_uploads', message: 'Địa chỉ mạng của bạn đang có quá nhiều lượt tải lên cùng lúc, vui lòng đợi rồi thử lại.' });
    }
    // "releaseOnce" (khong dung truc tiep 2 lenh release() o tren) de dam bao
    // KHONG BAO GIO giam counter 2 LAN cho cung 1 request (finally VA su kien
    // 'close' co the ca 2 cung kich hoat trong 1 so tinh huong đua nhau).
    let released = false;
    function releaseOnce() {
        if (released) return;
        released = true;
        concurrentUploadsPerUser.release(userKey);
        concurrentUploadsPerIp.release(ip);
    }
    // Luoi an toan cho truong hop client NGAT KET NOI GIUA CHUNG khi dang
    // upload (spec §9/§29 yeu cau test rieng truong hop nay): neu socket dong
    // trong luc dang cho multer doc xong file, callback cua multer co the
    // KHONG BAO GIO duoc goi (tuy phien ban Node/busboy) - luc do try/finally
    // ben duoi se khong bao gio chay. Listener nay dam bao counter VAN duoc
    // release ngay ca trong tinh huong do (biet han che: chinh async function
    // nay van co the con "treo" trong bo nho toi khi GC, xem README/known
    // limitations - chap nhan duoc, khong lam engineering phuc tap hon de xu
    // ly triet de vi ngoai pham vi STEP 3.3).
    req.on('close', releaseOnce);

    try {
        const guard = await checkStorageGuard('media');
        if (guard.blocked) return res.status(503).json({ error: 'storage_full', message: guard.message });

        await new Promise((resolve) => {
            upload.single('file')(req, res, (err) => {
                if (err) {
                    if (err.code === 'LIMIT_FILE_SIZE') {
                        res.status(413).json({ error: 'payload_too_large', message: 'File vượt quá giới hạn cho phép.' });
                    } else {
                        res.status(400).json({ error: 'invalid_file', message: 'File không hợp lệ hoặc không được hỗ trợ.' });
                    }
                }
                resolve();
            });
        });
        if (res.headersSent) return; // multer da tra loi (file khong hop le/qua lon) - dung o day

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
            // STEP 4 §10.1: gioi han TOAN CUC so luong HEIC conversion dong thoi
            // (doc lap voi concurrency guard theo user/IP cua STEP 3.3) - HEIC
            // decode qua WASM rat ton CPU, Render Free chi co 1 nhan/luong han
            // che nen 2 conversion chay song song se lam CA HAI cham di ro ret
            // (va co the vuot ca HEIC_CONVERT_TIMEOUT_MS mac du tung cai rieng
            // le van du nhanh). Neu vuot gioi han, tra 503 NGAY (khong xep hang
            // cho, tranh giu request/RAM cho trong khi cho toi luot).
            if (!concurrentHeicConversions.tryAcquire(HEIC_CONCURRENCY_GLOBAL_KEY)) {
                return res.status(503).json({
                    error: 'heic_conversion_busy',
                    message: 'Máy chủ đang xử lý ảnh HEIC khác, vui lòng thử lại sau vài giây.'
                });
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
            } finally {
                // STEP 4 §10.1: PHAI release du thanh cong/that bai/return som
                // (413 do qua lon sau convert) - giong nguyen tac ConcurrencyGuard
                // da ap dung cho STEP 3.3 (concurrentUploadsPerUser/Ip).
                concurrentHeicConversions.release(HEIC_CONCURRENCY_GLOBAL_KEY);
            }
        }

        const isImage = ALLOWED_IMAGE_MIMES.includes(req.file.mimetype);
        const isVideo = ALLOWED_VIDEO_MIMES.includes(req.file.mimetype);
        if (!isImage && !isVideo) return res.status(400).json({ error: 'invalid_mime' });

        // STEP 3.2 §17/§18: KHONG tin Content-Type client tu khai bao - xac nhan
        // noi dung THAT SU cua file khop voi mimetype da khai bao bang magic bytes.
        // (Nhanh HEIC o tren da tu convert xong thanh JPEG that su qua thu vien
        // heic-convert truoc khi toi day, nen khong can kiem tra lai o day.)
        if (!declaredHeic) {
            const check = isImage ? IMAGE_SIGNATURE_CHECKS[req.file.mimetype] : VIDEO_SIGNATURE_CHECKS[req.file.mimetype];
            if (!check || !check(req.file.buffer)) {
                return res.status(400).json({
                    error: 'invalid_file',
                    message: 'Nội dung file không khớp với định dạng đã khai báo.'
                });
            }
        }

        const limit = isImage ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES;
        if (req.file.size > limit) {
            return res.status(413).json({
                error: 'payload_too_large',
                message: isImage ? 'Ảnh vượt quá 500KB.' : 'Video vượt quá 10MB.'
            });
        }

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
        if (!res.headersSent) res.status(500).json({ error: 'server_error' });
    } finally {
        releaseOnce();
        req.removeListener('close', releaseOnce);
    }
});

// Tra noi dung nhi phan da giai ma cho 1 tin nhan anh/video
app.get('/api/messages/:id/media', authRequired, approvedRequired, async (req, res) => {
    const id = parsePositiveIntStrict(req.params.id);
    if (id === null) return res.status(400).end();
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
    const messageId = parsePositiveIntStrict(req.params.id);
    const { emoji } = req.body || {};
    // STEP 3.2 §9: kiem tra type TUONG MINH truoc whitelist (defense in depth) -
    // ALLOWED_REACTIONS.includes(emoji) da an toan voi object/array/so... (khong
    // bao gio match), nhung kiem tra typeof ro rang giup thong bao loi nhat quan
    // va tranh phu thuoc ngam vao hanh vi so sanh cua Array.includes().
    if (messageId === null || typeof emoji !== 'string' || !ALLOWED_REACTIONS.includes(emoji)) {
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
    const id = parsePositiveIntStrict(req.params.id);
    if (id === null) return res.status(400).json({ error: 'invalid_input' });
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
        return jwt.verify(token, EFFECTIVE_JWT_SECRET, { algorithms: ['HS256'] });
    } catch {
        return null;
    }
}

// STEP 3.1: giong het ly do sua authRequired o tren - KHONG chap nhan ket noi
// WS chi vi chu ky JWT hop le. Doc lai role/status THAT TU DATABASE truoc khi
// dong y ket noi, de user vua bi revoke/xoa khong the mo ket noi WS moi bang
// token cu con "nho" trang thai approved.
//
// STEP 3.3 §11/§16: THEM lop chong flood ket noi TRUOC CA buoc xac thuc JWT/DB
// (re nhat, chan som nhat) - dua theo IP:
//   1. wsConnectIpLimiter: gioi han SO LAN THU KET NOI trong 1 cua so thoi
//      gian (vd 10 lan/phut/IP) - chan kieu "connect/disconnect/connect/..."
//      lien tuc du moi lan co the la 1 socket khac nhau.
//   2. concurrentWsConnectionsPerIp: gioi han SO KET NOI DANG MO DONG THOI tu
//      1 IP (vd 5 - chap nhan nhieu tab/thiet bi/NAT o muc hop ly, xem spec
//      §11 "phai can nhac nhieu tab/mobile+desktop/nhieu user sau NAT").
// Ca 2 deu dua theo getWsClientIp(req, IP_RESOLVER_OPTIONS) - "req" o day la
// http.IncomingMessage THO cua buoc upgrade, KHONG di qua Express (khong co
// req.ip). Dung CF-Connecting-IP (neu TRUST_CF_CONNECTING_IP=true) hoac
// socket.remoteAddress - xem giai thich day du trong rate-limit.js.
wss.on('connection', async (ws, req) => {
    const ip = getWsClientIp(req, IP_RESOLVER_OPTIONS);

    const connectAttempt = wsConnectIpLimiter.consume(ip);
    if (!connectAttempt.allowed) {
        console.warn(`[WS] Tu choi ket noi - vuot gioi han so lan thu ket noi/phut tu IP=${ip}`);
        ws.close(4008, 'too_many_connection_attempts');
        return;
    }
    if (!concurrentWsConnectionsPerIp.tryAcquire(ip)) {
        console.warn(`[WS] Tu choi ket noi - vuot gioi han so ket noi dong thoi tu IP=${ip}`);
        ws.close(4009, 'too_many_concurrent_connections');
        return;
    }
    // Tu day tro di, MOI duong thoat (return som vi tu choi auth, hoac dong
    // ket noi binh thuong sau nay) DEU PHAI giai phong dung 1 lan cho IP nay -
    // dung "released" + ws.on('close', ...) o duoi lam luoi an toan chung,
    // giong nguyen tac ConcurrencyGuard o route upload media.
    let wsIpSlotReleased = false;
    function releaseWsIpSlot() {
        if (wsIpSlotReleased) return;
        wsIpSlotReleased = true;
        concurrentWsConnectionsPerIp.release(ip);
    }
    ws.on('close', releaseWsIpSlot);

    const url = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('token');
    const payload = token ? verifyWsToken(token) : null;
    if (!payload || !Number.isInteger(payload.id)) {
        console.warn(`[WS] Tu choi ket noi - token khong hop le/het han (co token: ${!!token})`);
        ws.close(4001, 'unauthorized');
        return;
    }
    let freshUser;
    try {
        const result = await pool.query('SELECT id, username, role, status FROM users WHERE id = $1', [payload.id]);
        if (result.rows.length === 0) {
            console.warn(`[WS] Tu choi ket noi - tai khoan id=${payload.id} khong con ton tai (da bi xoa)`);
            ws.close(4002, 'account_deleted');
            return;
        }
        freshUser = result.rows[0];
    } catch (err) {
        console.error('[WS] Loi doc lai user tu DB khi xac thuc ket noi:', err.message);
        ws.close(1011, 'server_error');
        return;
    }
    // STEP 3.1 §18: pending/revoked user KHONG duoc phep mo ket noi WS (giong het
    // dieu kien approvedRequired ben HTTP) - truoc day bat ky token hop le chu ky
    // nao cung duoc chap nhan connect, chi bi loc o buoc broadcast.
    if (freshUser.role !== 'admin' && freshUser.status !== 'approved') {
        console.warn(`[WS] Tu choi ket noi - user=${freshUser.username} status=${freshUser.status} (chua duyet hoac da bi thu hoi)`);
        ws.close(4003, 'not_approved');
        return;
    }
    console.log(`[WS] Ket noi thanh cong: user=${freshUser.username} role=${freshUser.role} status=${freshUser.status}`);
    ws.userPayload = freshUser; // FRESH tu DB - broadcastToApproved/broadcastToAdmins/notifyUser deu doc tu day
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('close', (code, reason) => {
        console.log(`[WS] Dong ket noi: user=${freshUser.username} code=${code} reason=${reason}`);
    });
    ws.on('error', (err) => {
        console.error(`[WS] Loi ket noi: user=${freshUser.username}`, err.message);
    });

    // STEP 3.3 §13/§14/§15: KIEN TRUC HIEN TAI - client (public/app.js) KHONG
    // BAO GIO tu gui du lieu qua WebSocket (chi nhan qua ws.onmessage; toan bo
    // chat/reaction/upload deu di qua HTTP REST o tren). Vi vay truoc STEP nay,
    // server KHONG CO handler ws.on('message', ...) nao ca - khong phai lo
    // hong, ma la kien truc "server chi push, khong nhan". De THUC SU dam bao
    // "malformed WS message khong lam crash server" ngay ca neu 1 client bi
    // sua/tan cong gui thang frame len (bo qua UI binh thuong), them 1 handler
    // PHONG THU o day: parse JSON an toan (try/catch), gioi han kich thuoc DA
    // duoc "ws" tu chan o tang protocol qua "maxPayload" (xem noi khoi tao
    // wss o tren), rate-limit theo user de tranh flood, va CHU DINH BO QUA
    // moi noi dung (khong co message type nao duoc dinh nghia/xu ly - day la
    // "no-op consumer" cho tuong lai neu can mo rong, KHONG phai tinh nang moi).
    ws.on('message', (data) => {
        const rl = wsMessageUserLimiter.consume(String(freshUser.id));
        if (!rl.allowed) {
            console.warn(`[WS] Rate-limit message tu user=${freshUser.username} - vuot ${WS_MESSAGE_RATE_LIMIT_PER_MINUTE}/phut, dang bo qua.`);
            return; // KHONG dong ket noi chi vi vuot rate-limit message - chi bo qua frame nay
        }
        let parsed;
        try {
            parsed = JSON.parse(data.toString('utf8'));
        } catch {
            // JSON khong hop le - KHONG throw/crash, chi log canh bao va bo qua.
            console.warn(`[WS] Bo qua frame JSON khong hop le tu user=${freshUser.username}`);
            return;
        }
        // Hien tai KHONG co message type nao duoc ho tro tu client -> chi ghi
        // nhan (muc debug) va bo qua, KHONG xu ly/khong phan hoi gi them.
        const msgType = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed.type : undefined;
        console.log(`[WS] Nhan duoc message tu user=${freshUser.username} (type=${JSON.stringify(msgType)}) - kien truc hien tai khong xu ly noi dung nay, da bo qua an toan.`);
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

// STEP 3.1: heartbeat 30s co san (ping/pong lien lac) duoc tan dung THEM de dong
// not "cua so" con lai - 1 socket DA MO SAN truoc khi admin revoke/xoa van giu
// ws.userPayload CACHED tu luc connect. notifyUser() da bao real-time ngay khi
// admin thao tac (client tu logout/chuyen ve pending), nhung day la lop phong
// thu THEM (vd nhieu tab/thiet bi, mat goi tin, client bo qua thong bao...):
// gioi han cua so "socket dang mo nhung da bi thu hoi quyen ma server van coi
// la approved" xuong TOI DA ~30s (chu ky heartbeat) thay vi toi 30 ngay (han
// JWT). Gop 1 query cho toan bo client dang ket noi, khong phai 1 query/client.
setInterval(() => {
    const stillAlive = [];
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        try { ws.ping(); } catch {}
        if (ws.userPayload) stillAlive.push(ws);
    });
    if (stillAlive.length === 0) return;
    const ids = [...new Set(stillAlive.map(ws => ws.userPayload.id))];
    pool.query('SELECT id, username, role, status FROM users WHERE id = ANY($1::int[])', [ids])
        .then((result) => {
            const byId = new Map(result.rows.map(r => [r.id, r]));
            for (const ws of stillAlive) {
                const fresh = byId.get(ws.userPayload.id);
                if (!fresh) {
                    console.warn(`[WS] Dong ket noi (heartbeat) - tai khoan id=${ws.userPayload.id} da bi xoa.`);
                    ws.userPayload = null;
                    ws.close(4002, 'account_deleted');
                } else if (fresh.role !== 'admin' && fresh.status !== 'approved') {
                    console.warn(`[WS] Dong ket noi (heartbeat) - user=${fresh.username} bi thu hoi/chua duyet ` +
                        `(status hien tai: ${fresh.status}) trong khi socket dang mo.`);
                    ws.userPayload = null;
                    ws.close(4003, 'not_approved');
                } else if (fresh.role !== ws.userPayload.role || fresh.status !== ws.userPayload.status) {
                    console.log(`[WS] Lam tuoi trang thai (heartbeat): user=${fresh.username} ` +
                        `${ws.userPayload.status}/${ws.userPayload.role} -> ${fresh.status}/${fresh.role}`);
                    ws.userPayload = fresh;
                }
            }
        })
        .catch((err) => console.error('[WS] Loi lam tuoi trang thai user cho cac ket noi dang mo:', err.message));
}, 30000);

// STEP 4 §14: WebSocket backpressure - neu 1 client cham (mang yeu, tab bi
// treo, hoac dang bi rate-limit o tang TCP) khong kip tieu thu du lieu,
// "ws.send()" van "thanh cong" ve mat API nhung du lieu se duoc XEP HANG noi
// bo trong bo nho cua thu vien "ws" (phan anh qua "ws.bufferedAmount" tang
// dan) - client do cang cham, hang doi cang phinh to, neu khong chan lai se
// gay RAM growth khong gioi han qua thoi gian (nhat la voi broadcast lien tuc
// cho MOI client dang mo). Ham nay kiem tra truoc khi gui: neu 1 client DA
// vuot nguong, bo qua lan gui nay va dong ket noi (client se tu ket noi lai
// qua co che reconnect co san o public/app.js) thay vi tiep tuc don du lieu
// vao cho no.
// STEP 4 §14: predicate THUAN TUY (khong side-effect) tach rieng de co the
// unit-test doc lap (xem test/performance.test.js) - quyet dinh "co nen tu
// choi gui (va dong ket noi) cho 1 client hay khong" chi dua tren
// bufferedAmount hien tai cua no so voi nguong cau hinh.
function isWsClientOverBuffered(bufferedAmount, maxBufferedBytes) {
    return typeof bufferedAmount === 'number' && bufferedAmount > maxBufferedBytes;
}

function sendIfNotOverBuffered(ws, data) {
    if (isWsClientOverBuffered(ws.bufferedAmount, WS_MAX_BUFFERED_BYTES)) {
        console.warn(`[WS] Dong ket noi - client qua cham (bufferedAmount=${ws.bufferedAmount} > ${WS_MAX_BUFFERED_BYTES}), tranh RAM growth khong gioi han.`);
        try { ws.close(1008, 'buffered_amount_exceeded'); } catch { /* socket co the da dong */ }
        return;
    }
    ws.send(data);
}

function broadcastToApproved(obj) {
    const data = JSON.stringify(obj);
    wss.clients.forEach((ws) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        const u = ws.userPayload;
        if (!u) return;
        if (u.role === 'admin' || u.status === 'approved') sendIfNotOverBuffered(ws, data);
    });
}
function broadcastToAdmins(obj) {
    const data = JSON.stringify(obj);
    wss.clients.forEach((ws) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (ws.userPayload && ws.userPayload.role === 'admin') sendIfNotOverBuffered(ws, data);
    });
}
function notifyUser(username, obj) {
    const data = JSON.stringify(obj);
    wss.clients.forEach((ws) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (ws.userPayload && ws.userPayload.username === username) {
            sendIfNotOverBuffered(ws, data);
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

// STEP 3.1: chi khoi dong server tu dong khi file nay duoc chay TRUC TIEP (`node
// server.js`, dung cach Render dang dung) - KHONG thay doi hanh vi production.
// Khi file nay duoc require() tu noi khac (vd test/auth-security.integration.test.js),
// `require.main !== module` nen se KHONG tu ket noi DB/listen port ngay khi import,
// cho phep test tu goi start()/server.listen(0) tren cong ngau nhien rieng biet.
if (require.main === module) {
    start();
}
// STEP 3.2: cac ham validation THUAN TUY (parsePositiveIntStrict, magic-byte
// check...) nay nam trong ./input-validation.js va duoc unit-test truc tiep
// tu do (test/input-validation.test.js require('../input-validation'), KHONG
// can require('../server') - vi vay khong can export lai o day).
// STEP 4: "isWsClientOverBuffered" la predicate THUAN TUY (khong DB/network)
// duoc export THEM de unit-test doc lap trong test/performance.test.js -
// KHONG anh huong gi den viec require() nay van can DATABASE_URL/JWT_SECRET/
// MESSAGE_ENCRYPTION_KEY hop le (dung fake value trong test, giong
// test/security-headers.test.js).
module.exports = { app, server, pool, start, JWT_SECRET: EFFECTIVE_JWT_SECRET, isWsClientOverBuffered };
