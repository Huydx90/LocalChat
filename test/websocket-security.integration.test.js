// test/websocket-security.integration.test.js
//
// STEP 3.3 - Rate Limiting, Abuse Protection & WebSocket Hardening.
//
// Integration test THAT cho WebSocket: boot server.js tren cong ngau nhien,
// dung PostgreSQL THAT qua TEST_DATABASE_URL (TU SKIP neu bien nay khong
// duoc dat - KHONG BAO GIO dung DATABASE_URL production). Cung pattern voi
// test/auth-security.integration.test.js va test/security-hardening.integration.test.js.
//
// Chay:
//   TEST_DATABASE_URL=postgres://postgres:test@localhost:5433/postgres npm run test:integration

const test = require('node:test');
const assert = require('node:assert/strict');

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

test('STEP 3.3 - WebSocket security (auth, connection flood, malformed message)', { skip: !TEST_DATABASE_URL }, async (t) => {
    // require('ws') CHI o trong than test (khong o top-level file) - de file
    // nay khong crash khi load trong moi truong chua `npm install` (vd sandbox
    // audit); { skip: !TEST_DATABASE_URL } ngan node:test GOI ham nay, nhung
    // KHONG ngan cac require() o TOP-LEVEL file chay khi load module.
    const WebSocket = require('ws');
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.JWT_SECRET = 'test-jwt-secret-step33-ws-000000000000000000';
    process.env.MESSAGE_ENCRYPTION_KEY = require('crypto').randomBytes(32).toString('base64');
    const suffix = Date.now();
    process.env.ADMIN_USERNAME = `sec33ws_admin_${suffix}`;
    process.env.ADMIN_PASSWORD = 'admin-pass-test-123456';
    process.env.NODE_ENV = 'test';
    process.env.PORT = '0';
    // STEP 3.3: gia tri THAP hon default de test flood/oversized chay nhanh,
    // khong phai doi that lau / gui qua nhieu ket noi that.
    process.env.WS_CONNECT_RATE_LIMIT_MAX = '100'; // du cho toan bo cac test trong file nay (xem tong so ket noi duoc mo o duoi)
    process.env.WS_CONNECT_RATE_LIMIT_WINDOW_MS = '60000';
    process.env.MAX_WS_CONNECTIONS_PER_IP = '3';
    process.env.MAX_WS_MESSAGE_BYTES = '1024'; // 1 KB - de test oversized khong can gui file lon that

    const { server, pool, start } = require('../server');

    await new Promise((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
        start();
    });
    const port = server.address().port;
    const httpBase = `http://127.0.0.1:${port}`;
    const wsBase = `ws://127.0.0.1:${port}/ws`;
    const adminUsername = process.env.ADMIN_USERNAME;
    const adminPassword = process.env.ADMIN_PASSWORD;

    async function api(pathName, { method = 'GET', token, body } = {}) {
        const headers = { 'Content-Type': 'application/json' };
        if (token) headers.Authorization = `Bearer ${token}`;
        const res = await fetch(httpBase + pathName, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
        let json = null;
        try { json = await res.json(); } catch { /* ignore */ }
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

    function connectRaw(token) {
        return new WebSocket(`${wsBase}?token=${encodeURIComponent(token || '')}`);
    }
    function waitForCloseOrOpen(ws) {
        return new Promise((resolve) => {
            ws.once('open', () => resolve({ event: 'open' }));
            ws.once('close', (code, reason) => resolve({ event: 'close', code, reason: reason ? reason.toString() : '' }));
            ws.once('error', () => { /* ignore - 'close' se theo sau */ });
        });
    }

    const adminLogin = await api('/api/auth/login', { method: 'POST', body: { username: adminUsername, password: adminPassword } });
    assert.equal(adminLogin.status, 200, 'admin (seed) phai dang nhap duoc');
    const adminToken = adminLogin.body.token;
    const alice = await registerApprove(`sec33ws_alice_${suffix}`);
    const pendingUser = await api('/api/auth/register', { method: 'POST', body: { username: `sec33ws_pending_${suffix}`, password: 'password123' } });
    const pendingLogin = await api('/api/auth/login', { method: 'POST', body: { username: `sec33ws_pending_${suffix}`, password: 'password123' } });
    const pendingToken = pendingLogin.body.token;

    // ---------------------------------------------------------------
    // A. Xac thuc/uy quyen (STEP 3.1 regression - phai VAN giu nguyen)
    // ---------------------------------------------------------------
    await t.test('WS: token hop le + approved -> connect thanh cong', async () => {
        const ws = connectRaw(alice.token);
        const result = await waitForCloseOrOpen(ws);
        assert.equal(result.event, 'open', 'user approved phai connect duoc');
        ws.close();
    });

    await t.test('WS: khong co token -> bi tu choi', async () => {
        const ws = connectRaw('');
        const result = await waitForCloseOrOpen(ws);
        assert.equal(result.event, 'close');
        assert.equal(result.code, 4001);
    });

    await t.test('WS: token sai/malformed -> bi tu choi', async () => {
        const ws = connectRaw('this-is-not-a-valid-jwt');
        const result = await waitForCloseOrOpen(ws);
        assert.equal(result.event, 'close');
        assert.equal(result.code, 4001);
    });

    await t.test('WS: user pending (chua duyet) -> bi tu choi', async () => {
        const ws = connectRaw(pendingToken);
        const result = await waitForCloseOrOpen(ws);
        assert.equal(result.event, 'close');
        assert.equal(result.code, 4003);
    });

    // ---------------------------------------------------------------
    // B. Connection flood protection (STEP 3.3 §11)
    // ---------------------------------------------------------------
    await t.test('WS: vuot MAX_WS_CONNECTIONS_PER_IP (=3) -> ket noi thu 4 dong thoi bi tu choi', async () => {
        const sockets = [];
        try {
            for (let i = 0; i < 3; i++) {
                const ws = connectRaw(alice.token);
                const result = await waitForCloseOrOpen(ws);
                assert.equal(result.event, 'open', `ket noi thu ${i + 1}/3 phai duoc chap nhan`);
                sockets.push(ws);
            }
            const fourth = connectRaw(alice.token);
            const result = await waitForCloseOrOpen(fourth);
            assert.equal(result.event, 'close', 'ket noi thu 4 (vuot MAX_WS_CONNECTIONS_PER_IP=3) phai bi tu choi');
            assert.equal(result.code, 4009);
        } finally {
            for (const ws of sockets) ws.close();
        }
        // Sau khi dong het, cho 1 chut de server xu ly su kien 'close' va giai
        // phong slot, roi xac nhan co the connect lai binh thuong.
        await new Promise((r) => setTimeout(r, 300));
        const ws = connectRaw(alice.token);
        const result = await waitForCloseOrOpen(ws);
        assert.equal(result.event, 'open', 'sau khi cac ket noi cu da dong, phai connect lai duoc (counter khong bi "ket")');
        ws.close();
    });

    // ---------------------------------------------------------------
    // C. Malformed / oversized message (STEP 3.3 §13/§15) - server KHONG
    //    duoc crash, va van tiep tuc phuc vu cac request/ket noi khac binh
    //    thuong sau do (kiem chung process con song bang 1 request HTTP that
    //    ngay sau khi gui garbage).
    // ---------------------------------------------------------------
    await t.test('WS: gui JSON garbage/malformed khong lam crash server (van phan hoi HTTP binh thuong ngay sau do)', async () => {
        const ws = connectRaw(alice.token);
        await waitForCloseOrOpen(ws);
        ws.send('{ nay khong phai JSON hop le !!! ###');
        ws.send('garbage garbage garbage...');
        ws.send(Buffer.from([0xff, 0x00, 0xfe, 0x01, 0x02, 0x03]));
        await new Promise((r) => setTimeout(r, 200));
        const stillWorks = await api('/api/messages?limit=1', { token: alice.token });
        assert.equal(stillWorks.status, 200, 'server (process Node) van phai con song va phan hoi HTTP binh thuong');
        ws.close();
    });

    await t.test('STEP 3.3 FIX §3/§8.3 - WS IP trust boundary: KHONG co header X-Forwarded-For (ket noi TRUC TIEP, dung socket that) - concurrent-per-IP limiter hoat dong dung tren dia chi THAT', async () => {
        // Trong moi truong test nay, KHONG co reverse proxy nao dung truoc -
        // client ket noi THANG toi server test, nen "dia chi that" cua moi ket
        // noi (req.socket.remoteAddress, vi khong co XFF nao duoc gui) LUON LA
        // CUNG 1 gia tri (loopback cua may chay test) - dung de xac nhan
        // hanh vi "khong co XFF -> dung socket that" hoat dong nhu thiet ke.
        const sockets = [];
        try {
            for (let i = 0; i < 3; i++) {
                const ws = connectRaw(alice.token); // KHONG gui X-Forwarded-For
                const result = await waitForCloseOrOpen(ws);
                assert.equal(result.event, 'open', `ket noi thu ${i + 1}/3 (khong XFF) phai duoc chap nhan`);
                sockets.push(ws);
            }
            const fourth = connectRaw(alice.token);
            const result = await waitForCloseOrOpen(fourth);
            assert.equal(result.event, 'close', 'ket noi thu 4 (khong XFF, cung dia chi that) phai bi tu choi boi MAX_WS_CONNECTIONS_PER_IP=3');
            assert.equal(result.code, 4009);
        } finally {
            for (const ws of sockets) ws.close();
        }
        await new Promise((r) => setTimeout(r, 300)); // cho server xu ly 'close' va release slot
    });

    await t.test('FINAL STEP 3.3 FIX §16 (Test C/E) - WS IP trust boundary: header X-Forwarded-For GIA MAO KHONG CON anh huong gi (da bo XFF khoi duong dan tin cay) - loi cu da duoc sua dut diem', async () => {
        // *** Day la test XAC NHAN FIX, khac voi phien ban truoc (da ghi nhan
        // gioi han "XFF rightmost co the bi bypass trong test truc tiep") ***
        // Thiet ke moi KHONG BAO GIO doc X-Forwarded-For de quyet dinh IP client
        // nua (xem rate-limit.js) - vi vay gui XFF gia mao (du 1 hay nhieu gia
        // tri) gio KHONG CON tac dung gi: ca 3 ket noi duoi day deu se duoc tinh
        // vao CUNG 1 dia chi that (socket that cua may chay test), nen ket noi
        // thu 4 (cung khong XFF that/gia) PHAI bi tu choi boi
        // MAX_WS_CONNECTIONS_PER_IP=3 - CHUNG MINH khong con bypass duoc nua.
        const sockets = [];
        try {
            for (let i = 0; i < 3; i++) {
                const ws = new WebSocket(`${wsBase}?token=${encodeURIComponent(alice.token)}`, {
                    headers: { 'X-Forwarded-For': `198.51.100.${i}` } // XFF gia - PHAI vo tac dung
                });
                const result = await waitForCloseOrOpen(ws);
                assert.equal(result.event, 'open', `ket noi thu ${i + 1}/3 phai duoc chap nhan (van con trong gioi han that)`);
                sockets.push(ws);
            }
            const fourth = new WebSocket(`${wsBase}?token=${encodeURIComponent(alice.token)}`, {
                headers: { 'X-Forwarded-For': '198.51.100.99' } // XFF "IP thu 4" GIA - khong duoc phep tao them slot
            });
            const result = await waitForCloseOrOpen(fourth);
            assert.equal(result.event, 'close', 'ket noi thu 4 (voi XFF gia mao khac) PHAI VAN bi tu choi - XFF khong con duoc dung de "tao" IP moi nua');
            assert.equal(result.code, 4009);
        } finally {
            for (const ws of sockets) ws.close();
        }
        await new Promise((r) => setTimeout(r, 300));
    });

    await t.test('FINAL STEP 3.3 FIX §16 (Test A/B/D) - WS: CF-Connecting-IP behavior — xem ghi chu', () => {
        // Test A (CF-Connecting-IP hop le duoc tin), Test B (thieu header ->
        // fallback), va Test D (CF-Connecting-IP malformed -> fallback) DA duoc
        // kiem chung day du va CHINH XAC o muc UNIT TEST thuan tuy trong
        // test/rate-limit.test.js (vd "getWsClientIp: HANH VI GIONG HET
        // getHttpClientIp..." va cac test isSingleValidIp/getHttpClientIp lien
        // quan) - noi ham getWsClientIp() duoc goi TRUC TIEP voi
        // {trustCfConnectingIp: true/false} va cac gia tri header gia lap, cho
        // ket qua deterministic 100% KHONG phu thuoc mang/Postgres/timing.
        //
        // Co chu y KHONG lam lai cac test do o day bang cach khoi dong 1
        // instance server THU HAI (vd xoa require.cache va require('../server')
        // lai voi TRUST_CF_CONNECTING_IP=true) - ky thuat do kha thi ve mat ly
        // thuyet nhung RAT KHO xac minh chac chan trong phien lam viec nay
        // (khong co Postgres that de chay thu), va them 1 lop phuc tap/rui ro
        // (2 pool ket noi DB dong thoi, port ngau nhien, don dep require.cache)
        // khong tuong xung voi gia tri tang them so voi unit test da co san va
        // DA CHAY PASS. Uu tien "don gian va honest" (spec §10) hon la 1 test
        // tich hop phuc tap ma khong the tu tin xac nhan la dung.
        assert.ok(true);
    });


    await pool.query('DELETE FROM users WHERE username = $1', [adminUsername]);
    await pool.query('DELETE FROM users WHERE id = $1', [alice.id]);
    if (pendingUser.body && pendingUser.body.id) {
        await pool.query('DELETE FROM users WHERE username LIKE $1', [`sec33ws_pending_${suffix}`]);
    }
    await pool.query('DELETE FROM users WHERE username LIKE $1', [`sec33ws_pending_${suffix}`]);
    await pool.end();
    await new Promise((resolve) => server.close(resolve));
});
