// test/security-hardening.integration.test.js
//
// STEP 3.2 - Input Validation, XSS, Injection & Upload/Media Security.
//
// Cung pattern voi test/auth-security.integration.test.js: boot CHINH
// server.js tren cong ngau nhien, dung PostgreSQL THAT qua TEST_DATABASE_URL
// (TU SKIP neu bien nay khong duoc dat - KHONG BAO GIO dung DATABASE_URL
// production). Chay:
//   TEST_DATABASE_URL=postgres://postgres:test@localhost:5433/postgres npm run test:integration
//
// Pham vi test nay tap trung vao NHUNG GI HTTP layer co the kiem chung duoc:
//   - SQL injection: payload dang ky/gui tin nhan khong lam crash/loi 500,
//     khong thay doi ngu nghia query (server van hoat dong binh thuong sau do).
//   - Numeric ID validation: cac endpoint nhan :id/query id tu choi dung dinh
//     dang sai (am, thap phan, "1abc", NaN, Infinity...) bang 400 thay vi
//     hanh vi khong xac dinh.
//   - JSON body validation: kieu du lieu sai (object/array thay vi string)
//     bi tu choi 400, khong lam crash.
//   - Reaction whitelist: gia tri ngoai danh sach cho phep (bao gom object/
//     array/chuoi qua kho) bi tu choi.
//   - Message control-character rejection (null byte).
//   - Upload: MIME gia mao (Content-Type noi 1 dang nhung noi dung that la
//     dang khac / khong phai file media) bi tu choi boi magic-byte check.
//
// XSS rendering (escapeHtml/renderMentions/reply-quote) la logic PHIA CLIENT
// (public/app.js) - khong the kiem chung qua HTTP response cua server (server
// tra ve JSON plaintext, khong tra ve HTML da render). Phan do da duoc audit
// thu cong (server.js/app.js) va ghi trong report - khuyen nghi bo sung test
// trinh duyet (Playwright/Puppeteer) o mot STEP rieng neu can tu dong hoa.

const test = require('node:test');
const assert = require('node:assert/strict');

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

test('STEP 3.2 - Input Validation, XSS, Injection & Upload/Media Security', { skip: !TEST_DATABASE_URL }, async (t) => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.JWT_SECRET = 'test-jwt-secret-step32-000000000000000000';
    process.env.MESSAGE_ENCRYPTION_KEY = require('crypto').randomBytes(32).toString('base64');
    const suffix = Date.now();
    process.env.ADMIN_USERNAME = `sec32_admin_${suffix}`;
    process.env.ADMIN_PASSWORD = 'admin-pass-test-123456';
    process.env.NODE_ENV = 'test';
    process.env.PORT = '0';
    // STEP 3.3: file nay (STEP 3.2) gui nhieu request LIEN TIEP RAT NHANH cho
    // CUNG 1 user chi de kiem tra input validation/XSS/SQLi (khong phai muc
    // dich kiem tra rate-limit) - noi rong gioi han rate-limit STEP 3.3 o day
    // de tranh 429 "gia" lam sai lech ket qua cac test KHONG lien quan toi
    // rate-limit (rate-limit da co bo test rieng: test/abuse-protection.integration.test.js).
    process.env.MESSAGE_RATE_LIMIT_BURST_MAX = '1000';
    process.env.MESSAGE_RATE_LIMIT_PER_MINUTE = '1000';
    process.env.UPLOAD_RATE_LIMIT_PER_MINUTE = '1000';
    process.env.UPLOAD_RATE_LIMIT_PER_HOUR = '1000';
    process.env.MAX_CONCURRENT_UPLOADS_PER_USER = '1000';
    process.env.MAX_CONCURRENT_UPLOADS_PER_IP = '1000';
    process.env.REGISTER_RATE_LIMIT_MAX = '1000';
    process.env.LOGIN_RATE_LIMIT_IP_MAX = '1000';
    process.env.LOGIN_RATE_LIMIT_ACCOUNT_MAX = '1000';

    const { server, pool, start } = require('../server');

    await new Promise((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
        start();
    });
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;
    const adminUsername = process.env.ADMIN_USERNAME;
    const adminPassword = process.env.ADMIN_PASSWORD;

    async function api(pathName, { method = 'GET', token, body } = {}) {
        const headers = { 'Content-Type': 'application/json' };
        if (token) headers.Authorization = `Bearer ${token}`;
        const res = await fetch(base + pathName, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
        let json = null;
        try { json = await res.json(); } catch { /* co the la binary/empty */ }
        return { status: res.status, body: json };
    }
    async function upload(pathName, { token, filename, contentType, buffer } = {}) {
        const form = new FormData();
        form.append('file', new Blob([buffer], { type: contentType }), filename);
        const headers = {};
        if (token) headers.Authorization = `Bearer ${token}`;
        const res = await fetch(base + pathName, { method: 'POST', headers, body: form });
        let json = null;
        try { json = await res.json(); } catch {}
        return { status: res.status, body: json };
    }

    async function registerApprove(username) {
        await api('/api/auth/register', { method: 'POST', body: { username, password: 'password123' } });
        const list = await api('/api/admin/users', { token: adminToken });
        const target = list.body.users.find(u => u.username === username);
        await api(`/api/admin/users/${target.id}/approve`, { method: 'POST', token: adminToken });
        const login = await api('/api/auth/login', { method: 'POST', body: { username, password: 'password123' } });
        return { id: target.id, token: login.body.token };
    }

    const adminLogin = await api('/api/auth/login', { method: 'POST', body: { username: adminUsername, password: adminPassword } });
    assert.equal(adminLogin.status, 200, 'admin (seed) phai dang nhap duoc');
    const adminToken = adminLogin.body.token;
    const { token: userToken } = await registerApprove(`sec32_user_${suffix}`);

    // ---------------------------------------------------------------
    // A. SQL Injection
    // ---------------------------------------------------------------
    await t.test('SQLi: payload trong message text khong crash, luu/tra ve nguyen ban an toan', async () => {
        const payloads = [`' OR '1'='1`, `'; DROP TABLE messages; --`, `1 OR 1=1`];
        for (const p of payloads) {
            const res = await api('/api/messages', { method: 'POST', token: userToken, body: { text: p } });
            assert.equal(res.status, 200, `payload "${p}" khong duoc lam server loi`);
            assert.equal(res.body.message.text, p, 'noi dung phai duoc luu/tra ve NGUYEN VAN (parameterized query, khong bi query lam bien dang)');
        }
        // Xac nhan bang messages VAN CON TON TAI sau cac payload DROP TABLE (chung
        // minh query THAT SU duoc parameterized, khong bi noi chuoi truc tiep).
        const stillWorks = await api('/api/messages?limit=1', { token: userToken });
        assert.equal(stillWorks.status, 200, 'bang messages van con hoat dong binh thuong sau payload SQLi');
    });

    await t.test('SQLi: payload trong username khi dang ky khong crash', async () => {
        const res = await api('/api/auth/register', {
            method: 'POST',
            body: { username: `bad' OR '1'='1`, password: 'password123' }
        });
        // Username khong khop USERNAME_RE -> 400 (tu choi ro rang), KHONG duoc la 500.
        assert.equal(res.status, 400);
    });

    // ---------------------------------------------------------------
    // B. Numeric ID validation
    // ---------------------------------------------------------------
    await t.test('ID validation: GET /api/messages/:id/media voi id sai dinh dang -> 400', async () => {
        for (const badId of ['-1', '1.5', 'abc', '1abc', 'NaN', 'Infinity', '0']) {
            const res = await api(`/api/messages/${encodeURIComponent(badId)}/media`, { token: userToken });
            assert.equal(res.status, 400, `id="${badId}" phai bi tu choi 400`);
        }
    });

    await t.test('ID validation: DELETE /api/messages/:id voi id sai dinh dang -> 400 (admin)', async () => {
        for (const badId of ['-1', '1.5', 'abc', '0']) {
            const res = await api(`/api/messages/${encodeURIComponent(badId)}`, { method: 'DELETE', token: adminToken });
            assert.equal(res.status, 400, `id="${badId}" phai bi tu choi 400`);
        }
    });

    await t.test('ID validation: POST /api/messages/:id/react voi id sai dinh dang -> 400', async () => {
        for (const badId of ['-1', '1.5', 'abc']) {
            const res = await api(`/api/messages/${encodeURIComponent(badId)}/react`, { method: 'POST', token: userToken, body: { emoji: '👍' } });
            assert.equal(res.status, 400, `id="${badId}" phai bi tu choi 400`);
        }
    });

    await t.test('ID validation: admin approve/revoke/delete user voi id sai dinh dang -> 400', async () => {
        for (const badId of ['-1', '1.5', 'abc']) {
            const a = await api(`/api/admin/users/${encodeURIComponent(badId)}/approve`, { method: 'POST', token: adminToken });
            assert.equal(a.status, 400);
            const r = await api(`/api/admin/users/${encodeURIComponent(badId)}/revoke`, { method: 'POST', token: adminToken });
            assert.equal(r.status, 400);
            const d = await api(`/api/admin/users/${encodeURIComponent(badId)}`, { method: 'DELETE', token: adminToken });
            assert.equal(d.status, 400);
        }
    });

    // ---------------------------------------------------------------
    // C. JSON body type validation
    // ---------------------------------------------------------------
    await t.test('JSON body: text la object/array bi tu choi 400, khong crash', async () => {
        for (const badText of [{}, [], 123, true, null]) {
            const res = await api('/api/messages', { method: 'POST', token: userToken, body: { text: badText } });
            assert.equal(res.status, 400, `text=${JSON.stringify(badText)} phai bi tu choi 400`);
        }
    });

    await t.test('JSON body: message chua null byte / control character bi tu choi 400', async () => {
        const res = await api('/api/messages', { method: 'POST', token: userToken, body: { text: 'hello\x00world' } });
        assert.equal(res.status, 400);
    });

    await t.test('JSON body: replyToId sai kieu (object) khong crash, chi bi bo qua (khong reply)', async () => {
        const res = await api('/api/messages', { method: 'POST', token: userToken, body: { text: 'hi', replyToId: { foo: 'bar' } } });
        assert.equal(res.status, 200);
        assert.equal(res.body.message.reply_to_id, null);
    });

    await t.test('Prototype pollution: body chua "__proto__" bi tu choi 400', async () => {
        const res = await api('/api/messages', {
            method: 'POST', token: userToken,
            body: JSON.parse('{"text":"hi","__proto__":{"polluted":true}}')
        });
        assert.equal(res.status, 400);
    });

    // ---------------------------------------------------------------
    // D. Reaction whitelist
    // ---------------------------------------------------------------
    await t.test('Reaction: gia tri ngoai whitelist (string la, object, array, oversized) bi tu choi', async () => {
        const sendRes = await api('/api/messages', { method: 'POST', token: userToken, body: { text: 'react target' } });
        const messageId = sendRes.body.message.id;
        const badEmojis = ['<script>alert(1)</script>', 'notanemoji', {}, [], '👍'.repeat(1000), ''];
        for (const emoji of badEmojis) {
            const res = await api(`/api/messages/${messageId}/react`, { method: 'POST', token: userToken, body: { emoji } });
            assert.equal(res.status, 400, `emoji=${JSON.stringify(emoji)} phai bi tu choi`);
        }
        const ok = await api(`/api/messages/${messageId}/react`, { method: 'POST', token: userToken, body: { emoji: '👍' } });
        assert.equal(ok.status, 200, 'emoji hop le trong whitelist van phai hoat dong binh thuong');
    });

    // ---------------------------------------------------------------
    // E. Mention/XSS payload trong message: server phai luu/tra ve nguyen van
    //    (KHONG tu y bien doi hay strip - viec escape la trach nhiem cua
    //    client khi render, da audit thu cong trong public/app.js).
    // ---------------------------------------------------------------
    await t.test('XSS payload trong message: server khong crash, tra ve nguyen van de client tu escape khi render', async () => {
        const payloads = [
            '<script>alert(1)</script>',
            '<img src=x onerror=alert(1)>',
            '<svg onload=alert(1)>',
            '<a href="javascript:alert(1)">click</a>',
        ];
        for (const p of payloads) {
            const res = await api('/api/messages', { method: 'POST', token: userToken, body: { text: p } });
            assert.equal(res.status, 200);
            assert.equal(res.body.message.text, p);
        }
    });

    // ---------------------------------------------------------------
    // F. Upload: MIME spoofing / magic-byte validation
    // ---------------------------------------------------------------
    await t.test('Upload: file gia mao Content-Type (khong phai anh/video that) bi tu choi', async () => {
        const fakeJpeg = Buffer.from('MZ\x90\x00this is actually an exe, not a jpeg');
        const res = await upload('/api/messages/media', {
            token: userToken, filename: 'evil.jpg', contentType: 'image/jpeg', buffer: fakeJpeg
        });
        assert.equal(res.status, 400, 'noi dung khong khop magic bytes JPEG phai bi tu choi');
    });

    await t.test('Upload: JPEG that (magic bytes hop le) duoc chap nhan', async () => {
        // JPEG toi thieu hop le: SOI + APP0 + EOI (khong can anh day du de qua
        // duoc kiem tra magic-byte cua server, server khong decode toan bo anh).
        const validJpeg = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0xFF, 0xD9]);
        const res = await upload('/api/messages/media', {
            token: userToken, filename: 'real.jpg', contentType: 'image/jpeg', buffer: validJpeg
        });
        assert.equal(res.status, 200);
        assert.equal(res.body.message.msg_type, 'image');
    });

    await t.test('Upload: file rong / khong dung dinh dang bi tu choi (khong crash)', async () => {
        const res = await upload('/api/messages/media', {
            token: userToken, filename: 'noop.bin', contentType: 'application/octet-stream', buffer: Buffer.from('random junk data')
        });
        assert.equal(res.status, 400);
    });

    // ---- Don dep du lieu test ----
    await pool.query(`DELETE FROM users WHERE username LIKE $1`, [`%\\_${suffix}`]);
    await pool.query('DELETE FROM users WHERE username = $1', [adminUsername]);
    await pool.end();
    await new Promise((resolve) => server.close(resolve));
});
