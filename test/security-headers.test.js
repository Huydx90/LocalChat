// test/security-headers.test.js
//
// STEP 3.3 - Rate Limiting, Abuse Protection & WebSocket Hardening.
//
// Kiem tra cac security header (X-Content-Type-Options, X-Frame-Options,
// Referrer-Policy, Permissions-Policy, Content-Security-Policy) tren MOI
// response. Chi kiem tra header THAT SU DA IMPLEMENT (spec §31: "chi test cac
// header thuc su implement").
//
// QUAN TRONG VE YEU CAU MOI TRUONG (khac voi cac *.integration.test.js khac):
// Test nay KHONG can PostgreSQL/TEST_DATABASE_URL - no chi goi cac route
// KHONG cham DB (static file + SPA fallback, middleware chay TRUOC ca khi
// Express dinh tuyen toi 1 route cu the), boc "app" (Express instance) exported
// tu server.js trong 1 http.Server rieng cua chinh test nay (KHONG goi
// start()/runMigrations()/seedAdmin() - nhung ham do moi that su can Postgres).
// Test nay CHI can `npm install` (express...) da chay xong - neu chua, tu SKIP
// voi thong bao ro rang (khong gia vo PASS).
//
// Chay: node --test test/security-headers.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

let serverModule = null;
let loadError = null;
try {
    process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://user:pass@127.0.0.1:5432/fake_do_not_connect';
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-only-secret-00000000000000000000';
    process.env.MESSAGE_ENCRYPTION_KEY = process.env.MESSAGE_ENCRYPTION_KEY || require('crypto').randomBytes(32).toString('base64');
    process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'unit-test-admin-pass-000000';
    process.env.NODE_ENV = process.env.NODE_ENV || 'test';
    process.env.PORT = '0';
    serverModule = require('../server');
} catch (err) {
    loadError = err;
}

const canRun = !!serverModule && !loadError;

test('STEP 3.3 §17/§31 - Security headers tren moi response', { skip: !canRun && `npm install chưa chạy trong môi trường này (${loadError && loadError.code}) - bỏ qua, KHÔNG coi là FAIL. Chạy lại sau khi 'npm install'.` }, async (t) => {
    const { app } = serverModule;
    const testServer = http.createServer(app);
    await new Promise((resolve) => testServer.listen(0, resolve));
    const port = testServer.address().port;
    const base = `http://127.0.0.1:${port}`;

    t.after(async () => {
        await new Promise((resolve) => testServer.close(resolve));
    });

    async function get(pathName) {
        return fetch(base + pathName);
    }

    await t.test('GET / (SPA fallback, khong cham DB) tra ve du cac header da implement', async () => {
        const res = await get('/');
        assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
        assert.equal(res.headers.get('x-frame-options'), 'DENY');
        assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
        // STEP 3.3 FIX §10: test nay dung http.createServer THUAN (khong TLS),
        // nen req.secure = false - Strict-Transport-Security KHONG duoc gui (dung
        // y thiet ke: khong bao gio gui HSTS tren ket noi khong phai HTTPS).
        assert.equal(res.headers.get('strict-transport-security'), null, 'khong duoc gui HSTS tren ket noi khong phai HTTPS (test nay khong dung TLS)');
        assert.ok(res.headers.get('permissions-policy'), 'phai co Permissions-Policy header');
        assert.equal(res.headers.get('permissions-policy').includes('camera=()'), true);
        assert.equal(res.headers.get('permissions-policy').includes('geolocation=()'), true);
        const csp = res.headers.get('content-security-policy');
        assert.ok(csp, 'phai co Content-Security-Policy header');
        assert.match(csp, /default-src 'self'/);
        assert.match(csp, /script-src[^;]*'self'[^;]*https:\/\/cdn\.jsdelivr\.net/);
        // Production regression (2026-09-14): heic2any tao Web Worker tu 1
        // "blob:" URL - khong co "worker-src" rieng se FALLBACK ve script-src
        // (khong co "blob:" o do), khien trinh duyet CHAN worker va HEIC
        // client-side conversion gay loi that tren production. worker-src
        // PHAI duoc khai bao rieng, cho phep "blob:".
        assert.match(csp, /worker-src[^;]*'self'[^;]*blob:/, 'worker-src phai cho phep blob: (heic2any tao Web Worker tu blob: URL) - thieu directive nay se lam HEIC client-side conversion bi CSP chan tren production');
        assert.match(csp, /frame-ancestors 'none'/);
        assert.match(csp, /object-src 'none'/);
        // KHONG duoc co 'unsafe-inline'/'unsafe-eval' (audit xac nhan app khong
        // can - xem comment trong server.js truoc khi dinh nghia CSP_HEADER).
        assert.equal(csp.includes('unsafe-inline'), false);
        assert.equal(csp.includes('unsafe-eval'), false);
    });

    await t.test('404 (route khong ton tai duoi /api) van co du security header (middleware chay TRUOC dinh tuyen)', async () => {
        const res = await get('/api/this-route-does-not-exist-at-all');
        assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
        assert.ok(res.headers.get('content-security-policy'));
    });

    await t.test('Khong dat Access-Control-Allow-Origin (STEP 3.3 §18: same-origin, khong mo CORS)', async () => {
        const res = await get('/');
        assert.equal(res.headers.get('access-control-allow-origin'), null);
    });
});
