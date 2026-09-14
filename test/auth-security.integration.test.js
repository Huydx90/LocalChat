// test/auth-security.integration.test.js
//
// STEP 3.1 - Authentication, Authorization & IDOR Security Hardening.
//
// Boot CHINH server.js that (qua module.exports, xem cuoi server.js) tren 1
// cong ngau nhien (PORT=0), goi HTTP That qua `fetch` (Node >=18 co san, khong
// them dependency), va mo WebSocket that qua thu vien `ws` (da la dependency
// cua project). Chay bang PostgreSQL THAT, CHI doc TEST_DATABASE_URL (KHONG
// bao gio DATABASE_URL production) va TU SKIP neu bien do khong duoc dat.
//
// Chay that (vi du voi Docker, xem huong dan day du o dau file
// test/oldest-first.integration.test.js):
//   docker run --rm -e POSTGRES_PASSWORD=test -p 5433:5432 -d postgres:16
//   TEST_DATABASE_URL=postgres://postgres:test@localhost:5433/postgres npm run test:integration
//
// LUU Y: test nay chay toan bo migrations that (000/001/002) len TEST_DATABASE_URL
// (tao bang users/messages/message_reactions that su cua app, KHAC voi 3 file
// integration test kia dung bang tam rieng) - vi muc tieu la test CHINH luong
// authentication/authorization cua app, khong the gia lap bang bang tam. Vi vay
// CHI tro TEST_DATABASE_URL vao 1 Postgres test/scratch rieng, KHONG BAO GIO
// dung chung voi DB production. Cac user test tu tao deu co username hau to
// ngau nhien theo timestamp va duoc don dep (DELETE) o cuoi.

const test = require('node:test');
const assert = require('node:assert/strict');

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

test('STEP 3.1 - Authentication / Authorization / IDOR', { skip: !TEST_DATABASE_URL }, async (t) => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.JWT_SECRET = 'test-jwt-secret-chi-dung-trong-unit-test-000000';
    process.env.MESSAGE_ENCRYPTION_KEY = require('crypto').randomBytes(32).toString('base64');
    const suffix = Date.now();
    process.env.ADMIN_USERNAME = `sec_admin_${suffix}`;
    process.env.ADMIN_PASSWORD = 'admin-pass-test-123456';
    process.env.NODE_ENV = 'test';
    process.env.PORT = '0';
    // STEP 3.3: file nay (STEP 3.1) tu no gui nhieu request/ket noi WS lien
    // tiep chi de kiem tra authentication/authorization/IDOR (khong phai muc
    // dich kiem tra rate-limit STEP 3.3) - noi rong gioi han o day de tranh
    // 429/4008/4009 "gia" lam sai lech ket qua (rate-limit da co bo test rieng:
    // test/abuse-protection.integration.test.js va test/websocket-security.integration.test.js).
    process.env.LOGIN_RATE_LIMIT_IP_MAX = '1000';
    process.env.LOGIN_RATE_LIMIT_ACCOUNT_MAX = '1000';
    process.env.REGISTER_RATE_LIMIT_MAX = '1000';
    process.env.MESSAGE_RATE_LIMIT_BURST_MAX = '1000';
    process.env.MESSAGE_RATE_LIMIT_PER_MINUTE = '1000';
    process.env.WS_CONNECT_RATE_LIMIT_MAX = '1000';
    process.env.MAX_WS_CONNECTIONS_PER_IP = '1000';

    const jwt = require('jsonwebtoken');
    const WebSocket = require('ws');
    const { server, pool, start, JWT_SECRET } = require('../server');

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
        const res = await fetch(base + pathName, { method, headers, body: body ? JSON.stringify(body) : undefined });
        let json = null;
        try { json = await res.json(); } catch { /* endpoint media tra binary, bo qua parse JSON */ }
        return { status: res.status, body: json };
    }

    function tryWsConnect(token) {
        return new Promise((resolve) => {
            const url = `ws://127.0.0.1:${port}/ws` + (token ? `?token=${encodeURIComponent(token)}` : '');
            const client = new WebSocket(url);
            client.on('open', () => resolve({ opened: true, client }));
            client.on('close', (code) => resolve({ opened: false, code }));
            client.on('error', () => {});
        });
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

    await t.test('Authentication: khong co token -> 401', async () => {
        const res = await api('/api/messages');
        assert.equal(res.status, 401);
    });

    await t.test('Authentication: token malformed -> 401', async () => {
        const res = await api('/api/messages', { token: 'not-a-valid-jwt' });
        assert.equal(res.status, 401);
    });

    await t.test('Authentication: token het han -> 401', async () => {
        const expired = jwt.sign({ id: 1 }, JWT_SECRET, { expiresIn: '-10s' });
        const res = await api('/api/messages', { token: expired });
        assert.equal(res.status, 401);
    });

    await t.test('Authentication: token ky bang secret sai -> 401', async () => {
        const forged = jwt.sign({ id: 1, role: 'admin', status: 'approved' }, 'wrong-secret-hoan-toan-khac-000000');
        const res = await api('/api/messages', { token: forged });
        assert.equal(res.status, 401);
    });

    await t.test('Register: khong the tu nang quyen qua body (role/approved bi bo qua)', async () => {
        const uname = `escalate_${suffix}`;
        const reg = await api('/api/auth/register', {
            method: 'POST',
            body: { username: uname, password: 'password123', role: 'admin', approved: true, status: 'approved' }
        });
        assert.equal(reg.status, 200);
        const login = await api('/api/auth/login', { method: 'POST', body: { username: uname, password: 'password123' } });
        assert.equal(login.body.user.role, 'user', 'role gui kem trong body register phai bi bo qua hoan toan');
        assert.equal(login.body.user.status, 'pending', 'user moi dang ky phai o trang thai pending, khong the tu approve');
    });

    await t.test('Authorization: pending user bi chan khoi chat', async () => {
        const uname = `pending_${suffix}`;
        await api('/api/auth/register', { method: 'POST', body: { username: uname, password: 'password123' } });
        const login = await api('/api/auth/login', { method: 'POST', body: { username: uname, password: 'password123' } });
        const res = await api('/api/messages', { token: login.body.token });
        assert.equal(res.status, 403);
        assert.equal(res.body.error, 'not_approved');
    });

    await t.test('Privilege escalation: normal approved user khong goi duoc admin API', async () => {
        const { id, token } = await registerApprove(`normal_${suffix}`);
        const list = await api('/api/admin/users', { token });
        assert.equal(list.status, 403);
        const approve = await api(`/api/admin/users/${id}/approve`, { method: 'POST', token });
        assert.equal(approve.status, 403);
        const del = await api(`/api/admin/users/${id}`, { method: 'DELETE', token });
        assert.equal(del.status, 403);
    });

    await t.test('CORE FIX: token cu (stale) sau khi REVOKE khong con duoc coi la approved', async () => {
        const uname = `revoke_${suffix}`;
        const { id, token: staleToken } = await registerApprove(uname);

        const before = await api('/api/messages', { token: staleToken });
        assert.equal(before.status, 200, 'truoc khi revoke phai truy cap binh thuong duoc');

        await api(`/api/admin/users/${id}/revoke`, { method: 'POST', token: adminToken });

        // KHONG dang nhap lai - dung lai DUNG token cu (van "nho" status=approved luc ky).
        const after = await api('/api/messages', { token: staleToken });
        assert.equal(after.status, 403, 'token cu phai bi tu choi NGAY sau khi revoke (khong doi den khi JWT het han 30 ngay)');
        assert.equal(after.body.error, 'not_approved');
    });

    await t.test('CORE FIX: token cu (stale) sau khi XOA TAI KHOAN khong con truy cap duoc', async () => {
        const uname = `delacc_${suffix}`;
        const { id, token: staleToken } = await registerApprove(uname);

        await api(`/api/admin/users/${id}`, { method: 'DELETE', token: adminToken });

        const after = await api('/api/messages', { token: staleToken });
        assert.equal(after.status, 401, 'token cua tai khoan da bi xoa phai bi tu choi');
        assert.equal(after.body.error, 'account_deleted');
    });

    await t.test('IDOR: reply toi ID khong ton tai khong crash, chi bi bo qua', async () => {
        const { token } = await registerApprove(`reply_${suffix}`);
        const res = await api('/api/messages', { method: 'POST', token, body: { text: 'hello', replyToId: 999999999 } });
        assert.equal(res.status, 200);
        assert.equal(res.body.message.reply_to_id, null);
    });

    await t.test('Admin delete message: tu choi anonymous/chinh chu tin nhan, cho phep admin', async () => {
        const { token: ownerToken } = await registerApprove(`msgowner_${suffix}`);
        const sendRes = await api('/api/messages', { method: 'POST', token: ownerToken, body: { text: 'tin nhan test xoa' } });
        assert.equal(sendRes.status, 200);
        const messageId = sendRes.body.message.id;

        const anon = await api(`/api/messages/${messageId}`, { method: 'DELETE' });
        assert.equal(anon.status, 401);

        const byOwner = await api(`/api/messages/${messageId}`, { method: 'DELETE', token: ownerToken });
        assert.equal(byOwner.status, 403, 'chinh nguoi gui (khong phai admin) khong duoc xoa tin nhan cua minh');

        const byAdmin = await api(`/api/messages/${messageId}`, { method: 'DELETE', token: adminToken });
        assert.equal(byAdmin.status, 200);

        const again = await api(`/api/messages/${messageId}`, { method: 'DELETE', token: adminToken });
        assert.equal(again.status, 404, 'xoa lai tin da xoa khong duoc crash, tra ve 404 hop ly');
    });

    await t.test('Reaction: identity lay tu server (khong tin userId tu body)', async () => {
        const { token: senderToken } = await registerApprove(`reactsender_${suffix}`);
        const { token: reactorToken } = await registerApprove(`reactor_${suffix}`);
        const sendRes = await api('/api/messages', { method: 'POST', token: senderToken, body: { text: 'react test' } });
        const messageId = sendRes.body.message.id;

        const react = await api(`/api/messages/${messageId}/react`, {
            method: 'POST', token: reactorToken, body: { emoji: '👍', username: adminUsername }
        });
        assert.equal(react.status, 200);
        const mine = react.body.reactions.find(r => r.emoji === '👍');
        assert.ok(mine, 'reaction phai duoc ghi nhan');
        assert.notEqual(mine.username, adminUsername, 'username trong body PHAI bi bo qua - identity lay tu token');
    });

    await t.test('afterId/beforeId bat thuong khong lam crash server', async () => {
        // STEP 3.2 §11: sau khi them parsePositiveIntStrict/parseNonNegativeIntStrict,
        // cac gia tri sai dinh dang (khac "0") gio tra ve 400 ro rang thay vi bi
        // am tham suy doan - day la CAI THIEN so voi STEP 3.1 (chi yeu cau "khong
        // crash"), nen 400 van la 1 ket qua HOP LE can chap nhan o day.
        for (const v of ['0', '-1', 'abc', '999999999999999999']) {
            const res = await api(`/api/messages?afterId=${encodeURIComponent(v)}`, { token: adminToken });
            assert.ok([200, 400, 500].includes(res.status), `afterId=${v} phai la response hop le (200/400/500), khong crash`);
        }
    });

    await t.test('WebSocket: khong token / token sai / het han deu bi tu choi', async () => {
        const noToken = await tryWsConnect(null);
        assert.equal(noToken.opened, false);

        const badToken = await tryWsConnect('not-a-jwt');
        assert.equal(badToken.opened, false);

        const expired = jwt.sign({ id: 1 }, JWT_SECRET, { expiresIn: '-10s' });
        const expiredConn = await tryWsConnect(expired);
        assert.equal(expiredConn.opened, false);
    });

    await t.test('WebSocket: pending user bi tu choi connect, approved thi connect duoc', async () => {
        const uname = `wspending_${suffix}`;
        await api('/api/auth/register', { method: 'POST', body: { username: uname, password: 'password123' } });
        const loginPending = await api('/api/auth/login', { method: 'POST', body: { username: uname, password: 'password123' } });
        const pendingConn = await tryWsConnect(loginPending.body.token);
        assert.equal(pendingConn.opened, false, 'pending user khong duoc phep mo ket noi WS');
        assert.equal(pendingConn.code, 4003);

        const list = await api('/api/admin/users', { token: adminToken });
        const target = list.body.users.find(u => u.username === uname);
        await api(`/api/admin/users/${target.id}/approve`, { method: 'POST', token: adminToken });
        const loginApproved = await api('/api/auth/login', { method: 'POST', body: { username: uname, password: 'password123' } });
        const approvedConn = await tryWsConnect(loginApproved.body.token);
        assert.equal(approvedConn.opened, true, 'approved user phai connect WS duoc');
        if (approvedConn.client) approvedConn.client.close();
    });

    await t.test('WebSocket: token cu sau khi bi XOA tai khoan khong the mo ket noi moi', async () => {
        const uname = `wsdel_${suffix}`;
        const { id, token } = await registerApprove(uname);
        await api(`/api/admin/users/${id}`, { method: 'DELETE', token: adminToken });
        const conn = await tryWsConnect(token);
        assert.equal(conn.opened, false);
        assert.equal(conn.code, 4002);
    });

    // ---- Don dep du lieu test (KHONG dung xoa CASCADE cho du lieu ngoai pham vi test nay) ----
    await pool.query(`DELETE FROM users WHERE username LIKE $1`, [`%\\_${suffix}`]);
    await pool.query('DELETE FROM users WHERE username = $1', [adminUsername]);
    await pool.end();
    await new Promise((resolve) => server.close(resolve));
});
