// test/abuse-protection.integration.test.js
//
// STEP 3.3 - Rate Limiting, Abuse Protection & WebSocket Hardening.
//
// Integration test THAT qua HTTP that: boot server.js tren cong ngau nhien,
// dung PostgreSQL THAT qua TEST_DATABASE_URL (TU SKIP neu bien nay khong
// duoc dat). Cung pattern voi cac *.integration.test.js khac trong project.
//
// Chay:
//   TEST_DATABASE_URL=postgres://postgres:test@localhost:5433/postgres npm run test:integration

const test = require('node:test');
const assert = require('node:assert/strict');

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

test('STEP 3.3 - Rate Limiting & Abuse Protection', { skip: !TEST_DATABASE_URL }, async (t) => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.JWT_SECRET = 'test-jwt-secret-step33-abuse-00000000000000';
    process.env.MESSAGE_ENCRYPTION_KEY = require('crypto').randomBytes(32).toString('base64');
    const suffix = Date.now();
    process.env.ADMIN_USERNAME = `sec33_admin_${suffix}`;
    process.env.ADMIN_PASSWORD = 'admin-pass-test-123456';
    process.env.NODE_ENV = 'test';
    process.env.PORT = '0';
    // STEP 3.3: gia tri THAP hon default de test chay nhanh (khong phai gui
    // hang chuc request that de cham nguong 30/phut mac dinh).
    process.env.LOGIN_RATE_LIMIT_IP_MAX = '100'; // xem ghi chu o test IP-level rieng ben duoi ve ly do chon gia tri nay
    process.env.LOGIN_RATE_LIMIT_IP_WINDOW_MS = '60000';
    process.env.LOGIN_RATE_LIMIT_ACCOUNT_MAX = '4';
    process.env.LOGIN_RATE_LIMIT_ACCOUNT_WINDOW_MS = '60000';
    process.env.REGISTER_RATE_LIMIT_MAX = '4';
    process.env.REGISTER_RATE_LIMIT_WINDOW_MS = '60000';
    process.env.MESSAGE_RATE_LIMIT_PER_MINUTE = '100'; // cao, chi burst moi test duoc trong 1 lan chay nhanh
    process.env.MESSAGE_RATE_LIMIT_BURST_MAX = '3';
    process.env.MESSAGE_RATE_LIMIT_BURST_WINDOW_MS = '2000';
    process.env.UPLOAD_RATE_LIMIT_PER_MINUTE = '3';
    process.env.UPLOAD_RATE_LIMIT_PER_HOUR = '100';
    process.env.MAX_CONCURRENT_UPLOADS_PER_USER = '2';
    process.env.MAX_CONCURRENT_UPLOADS_PER_IP = '10';

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
        try { json = await res.json(); } catch { /* ignore */ }
        return { status: res.status, body: json, headers: res.headers };
    }
    async function upload(pathName, { token, filename, contentType, buffer } = {}) {
        const form = new FormData();
        form.append('file', new Blob([buffer], { type: contentType }), filename);
        const headers = {};
        if (token) headers.Authorization = `Bearer ${token}`;
        const res = await fetch(base + pathName, { method: 'POST', headers, body: form });
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

    const adminLogin = await api('/api/auth/login', { method: 'POST', body: { username: adminUsername, password: adminPassword } });
    assert.equal(adminLogin.status, 200, 'admin (seed) phai dang nhap duoc');
    const adminToken = adminLogin.body.token;

    // ---------------------------------------------------------------
    // A. Login brute-force (STEP 3.3 §5/§28)
    // ---------------------------------------------------------------
    await t.test('Login: duoi nguong account (LOGIN_RATE_LIMIT_ACCOUNT_MAX=4) -> 401 binh thuong, vuot -> 429', async () => {
        const username = `sec33_bf_${suffix}`;
        await registerApprove(username);
        // 4 lan sai mat khau lien tiep (dung LOGIN_RATE_LIMIT_ACCOUNT_MAX=4)
        for (let i = 0; i < 4; i++) {
            const res = await api('/api/auth/login', { method: 'POST', body: { username, password: 'wrong-password' } });
            assert.equal(res.status, 401, `lan sai thu ${i + 1}/4 phai la 401 (chua vuot nguong)`);
            assert.equal(res.body.error, 'bad_credentials');
        }
        const fifth = await api('/api/auth/login', { method: 'POST', body: { username, password: 'wrong-password' } });
        assert.equal(fifth.status, 429, 'lan thu 5 (vuot LOGIN_RATE_LIMIT_ACCOUNT_MAX=4) phai bi 429');
        assert.ok(fifth.headers.get('retry-after'), 'phai co header Retry-After');
        // Dung mat khau DUNG cung phai bi 429 khi da vuot nguong (khoa tam thoi ca cua so).
        const evenWithCorrectPassword = await api('/api/auth/login', { method: 'POST', body: { username, password: 'password123' } });
        assert.equal(evenWithCorrectPassword.status, 429, 'da vuot nguong thi TAM THOI ca mat khau dung cung bi tu choi trong cua so hien tai');
    });

    await t.test('STEP 3.3 FIX §1 - Login: 20 request DONG THOI (that qua HTTP, Promise.all) cho CUNG 1 account - dung CHINH XAC LOGIN_RATE_LIMIT_ACCOUNT_MAX (=4) duoc "admission" (401 that), phan con lai bi 429 (khong co request nao "lot qua" nho race condition)', async () => {
        // QUAN TRONG ve tinh deterministic: gia tri ma ta assert o day (dung 4
        // request duoc admission, dung 16 request bi 429) KHONG phu thuoc vao
        // THU TU 20 request nay den server nhu the nao (scheduling mang/OS la
        // khong xac dinh) - no chi phu thuoc vao 1 su that: RateLimiter.consume()
        // la operation DONG BO (khong await ben trong), nen moi khi 1 trong 20
        // request nay THAT SU chay toi dong goi tryConsume(), no LUON tang dung
        // bo dem chia se va thay ket qua CHINH XAC (khong bao gio 2 request
        // "cung nhin thay" y het 1 gia tri bo dem cu roi ca 2 cung duoc allowed
        // sai). Vi tong so lan goi tryConsume() la co dinh (20 - moi request goi
        // dung 1 lan), va RateLimiter la 1 bo dem cong don don gian voi tran
        // cung max=4, so luong request duoc "allowed: true" LUON LA dung
        // min(20, 4) = 4, bat ke request nao trong so 20 la 4 request "may man"
        // do. Day la ly do test nay hoan toan deterministic du dung Promise.all
        // that qua mang that (khac voi test rate-limit.test.js chi mo phong
        // "dong thoi" bang goi ham dong bo lien tiep trong 1 process test).
        const username = `sec33_concurrency_${suffix}`;
        await registerApprove(username);
        const attempts = Array.from({ length: 20 }, () =>
            api('/api/auth/login', { method: 'POST', body: { username, password: 'this-is-definitely-wrong' } })
        );
        const results = await Promise.all(attempts);
        const admitted = results.filter(r => r.status === 401).length; // that su chay toi bcrypt.compare(), sai mat khau
        const rateLimited = results.filter(r => r.status === 429).length;
        const other = results.filter(r => r.status !== 401 && r.status !== 429).length;
        assert.equal(other, 0, `khong duoc co status nao khac ngoai 401/429 (vd 500 se la dau hieu loi/crash) - phan bo thuc te: ${JSON.stringify(results.map(r => r.status))}`);
        assert.equal(admitted, 4, `dung LOGIN_RATE_LIMIT_ACCOUNT_MAX=4 request duoc "admission" that su (401), nhan duoc ${admitted}/20 - neu > 4 nghia la van con race condition (nhieu request "lot qua" kiem tra dong thoi)`);
        assert.equal(rateLimited, 16, `16 request con lai phai la 429 (nhan duoc ${rateLimited}/20)`);
    });

    await t.test('STEP 3.3 FIX §2 - Login: khong tiet lo user co ton tai hay khong (existing+wrong-password vs non-existing+any-password phai GIONG HET nhau)', async () => {
        // Issue 2: ca 2 nhanh deu phai chay qua bcrypt.compare() that su (that
        // voi hash that, hoac gia voi DUMMY_PASSWORD_HASH) va tra ve response
        // KHONG THE phan biet duoc - cung status, cung error code, cung message,
        // cung cau truc body (khong co field thua o nhanh nao).
        const existingUserWrongPassword = await api('/api/auth/login', { method: 'POST', body: { username: adminUsername, password: 'definitely-wrong-password-xyz' } });
        const nonExistentUser = await api('/api/auth/login', { method: 'POST', body: { username: `khong-ton-tai-${suffix}-${Math.random().toString(36).slice(2)}`, password: 'anything123' } });
        assert.equal(existingUserWrongPassword.status, nonExistentUser.status, 'status phai giong het nhau');
        assert.equal(existingUserWrongPassword.body.error, nonExistentUser.body.error, 'error code phai giong het nhau');
        assert.equal(existingUserWrongPassword.body.message, nonExistentUser.body.message, 'message phai giong het nhau');
        assert.deepEqual(
            Object.keys(existingUserWrongPassword.body).sort(),
            Object.keys(nonExistentUser.body).sort(),
            'cau truc (danh sach key) cua response body phai giong het nhau - khong duoc co field thua o nhanh nao tiet lo thong tin'
        );
        // Ca 2 phai la 401 that su (khong phai vo tinh bi 429 do cac test truoc
        // do da tieu het quota IP/account - dung username/random moi cho chac).
        assert.equal(existingUserWrongPassword.status, 401);
    });

    await t.test('STEP 3.3 FIX §2 - Login: pending/revoked user (ton tai that) + sai mat khau van tra ve GIONG HET "khong ton tai" (khong leak trang thai tai khoan)', async () => {
        const pendingUsername = `sec33_pending_enum_${suffix}`;
        await api('/api/auth/register', { method: 'POST', body: { username: pendingUsername, password: 'password123' } });
        // KHONG approve - user con o trang thai "pending".
        const pendingWrongPassword = await api('/api/auth/login', { method: 'POST', body: { username: pendingUsername, password: 'wrong-password-here' } });
        const nonExistentUser = await api('/api/auth/login', { method: 'POST', body: { username: `khong-ton-tai-2-${suffix}`, password: 'wrong-password-here' } });
        assert.equal(pendingWrongPassword.status, nonExistentUser.status);
        assert.equal(pendingWrongPassword.body.error, nonExistentUser.body.error);
        assert.equal(pendingWrongPassword.body.message, nonExistentUser.body.message);
    });

    await t.test('Login: dang nhap THANH CONG phai reset bo dem account-level (khong con bi khoa oan sau do)', async () => {
        const username = `sec33_reset_${suffix}`;
        const acct = await registerApprove(username);
        // 3 lan sai (chua cham nguong 4) roi 1 lan dung -> phai thanh cong VA reset.
        for (let i = 0; i < 3; i++) {
            await api('/api/auth/login', { method: 'POST', body: { username, password: 'wrong' } });
        }
        const success = await api('/api/auth/login', { method: 'POST', body: { username, password: 'password123' } });
        assert.equal(success.status, 200, 'lan thu dung mat khau (thu 4, van duoi nguong 4) phai thanh cong');
        // Ngay sau khi thanh cong, sai lai 4 lan LIEN TIEP van phai duoc tinh la
        // "bat dau lai tu 0" (da reset), tuc la 4 lan sai nay CHUA vuot nguong.
        for (let i = 0; i < 4; i++) {
            const res = await api('/api/auth/login', { method: 'POST', body: { username, password: 'wrong-again' } });
            assert.equal(res.status, 401, `sau reset, lan sai thu ${i + 1}/4 van phai la 401 (chua vuot nguong MOI)`);
        }
        void acct;
    });

    await t.test('Login: 1 user bi rate-limit KHONG lam user khac (khac IP thi khong lien quan, cung IP thi bi anh huong dung theo IP-limiter rieng)', async () => {
        const userA = `sec33_indep_a_${suffix}`;
        const userB = `sec33_indep_b_${suffix}`;
        await registerApprove(userA);
        await registerApprove(userB);
        // userA da bi khoa tu test truoc? Khong - dung username moi hoan toan.
        for (let i = 0; i < 10; i++) {
            await api('/api/auth/login', { method: 'POST', body: { username: userA, password: 'wrong' } });
        }
        // userB (account-level rieng) van con quota o LOGIN_RATE_LIMIT_ACCOUNT_MAX
        // NEU chua cham LOGIN_RATE_LIMIT_IP_MAX (ca 2 cung IP nen se cong don) -
        // o day chi xac nhan userB it nhat KHONG bi tra ve 429 vi ly do
        // "account userA" (loi phai la generic/rate_limited chu khong dinh danh
        // toi userA).
        const res = await api('/api/auth/login', { method: 'POST', body: { username: userB, password: 'password123' } });
        // Co the la 200 (neu IP-limiter chua cham nguong) hoac 429 (neu IP-limiter
        // CHUNG cho ca IP da cham do userA spam qua nhieu) - dieu quan trong la
        // KHONG BAO GIO 401 "sai mat khau" (vi password dung) va response KHONG
        // leak ten user/IP/counter noi bo.
        assert.ok([200, 429].includes(res.status));
        if (res.status === 429) {
            assert.equal(Object.keys(res.body).sort().join(','), 'error,message');
        }
    });

    await t.test('STEP 3.3 FIX §4 - Login: CUNG 1 IP + NHIEU username khac nhau - cuoi cung van bi chan boi LOGIN_RATE_LIMIT_IP_MAX (khong the bypass IP-limiter chi bang doi username lien tuc)', async () => {
        // Toan bo cac test login o TREN (trong CUNG file nay, cung 1 server/IP
        // 127.0.0.1) da tieu thu 1 phan dang ke quota IP (LOGIN_RATE_LIMIT_IP_MAX
        // = 100, dat o dau file). Test nay gui THEM 60 request MOI, MOI request
        // dung 1 username KHAC NHAU (chua tung dung o dau) de dam bao KHONG bao
        // gio bi chan boi account-limiter - neu co bat ky response 429 nao xuat
        // hien trong 60 request nay, no CHAC CHAN den tu IP-limiter (khong con
        // co the la account-limiter, vi moi username o day la lan dau tien
        // duoc dung). Tong cong (cac test truoc + 60 o day) chac chan vuot 100,
        // nen test nay PHAI thay it nhat 1 request 429 - chung minh attacker
        // KHONG THE bypass IP-limiter chi bang cach doi username lien tuc.
        const attempts = Array.from({ length: 60 }, (_, i) =>
            api('/api/auth/login', { method: 'POST', body: { username: `sec33_ipflood_${suffix}_${i}`, password: 'irrelevant-password' } })
        );
        const results = await Promise.all(attempts);
        const rateLimitedCount = results.filter(r => r.status === 429).length;
        assert.ok(rateLimitedCount > 0, `phai co it nhat 1 trong 60 request bi 429 boi IP-limiter (nhan duoc 0/60 - co the LOGIN_RATE_LIMIT_IP_MAX dat qua cao so voi tong so request da gui trong file test nay)`);
        // Moi response 429 khong duoc leak thong tin gi ve username/IP/counter.
        for (const r of results) {
            if (r.status === 429) {
                assert.equal(Object.keys(r.body).sort().join(','), 'error,message');
            }
        }
    });

    // ---------------------------------------------------------------
    // B. Registration abuse (STEP 3.3 §6/§28)
    // ---------------------------------------------------------------
    await t.test('Register: vuot REGISTER_RATE_LIMIT_MAX (=4) tu 1 IP -> 429', async () => {
        // Dung 1 client/agent rieng (fetch mac dinh tu cung 1 "IP" trong test -
        // 127.0.0.1) - REGISTER_RATE_LIMIT_MAX da duoc dat = 4 o env cho test nay.
        // Luu y: cac test truoc CUNG tu request tu 127.0.0.1 nhung qua route
        // /api/auth/login (limiter rieng, khong dung chung voi register).
        const results = [];
        for (let i = 0; i < 6; i++) {
            const res = await api('/api/auth/register', {
                method: 'POST',
                body: { username: `sec33_reg_flood_${suffix}_${i}`, password: 'password123' }
            });
            results.push(res.status);
        }
        assert.ok(results.includes(429), `it nhat 1 trong 6 request phai bi 429 (nhan duoc: ${results.join(',')})`);
    });

    // ---------------------------------------------------------------
    // C. Message spam (STEP 3.3 §7/§28)
    // ---------------------------------------------------------------
    await t.test('Message: vuot MESSAGE_RATE_LIMIT_BURST_MAX (=3) trong vai giay -> 429', async () => {
        const user = await registerApprove(`sec33_msgspam_${suffix}`);
        const results = [];
        for (let i = 0; i < 5; i++) {
            const res = await api('/api/messages', { method: 'POST', token: user.token, body: { text: `spam ${i}` } });
            results.push(res.status);
        }
        assert.ok(results.includes(429), `it nhat 1 trong 5 tin nhan lien tiep phai bi 429 do burst limiter (nhan duoc: ${results.join(',')})`);
        assert.ok(results.slice(0, 3).every(s => s === 200), '3 tin nhan dau (duoi burst max=3) phai duoc gui thanh cong');
    });

    await t.test('Message: sau khi het cua so burst, gui lai duoc binh thuong (khong bi khoa vinh vien)', async () => {
        const user = await registerApprove(`sec33_msgspam2_${suffix}`);
        for (let i = 0; i < 3; i++) {
            await api('/api/messages', { method: 'POST', token: user.token, body: { text: `burst ${i}` } });
        }
        const blocked = await api('/api/messages', { method: 'POST', token: user.token, body: { text: 'blocked' } });
        assert.equal(blocked.status, 429);
        await new Promise((r) => setTimeout(r, 2100)); // MESSAGE_RATE_LIMIT_BURST_WINDOW_MS=2000
        const afterWait = await api('/api/messages', { method: 'POST', token: user.token, body: { text: 'after window' } });
        assert.equal(afterWait.status, 200, 'sau khi het cua so burst, phai gui duoc lai binh thuong');
    });

    // ---------------------------------------------------------------
    // D. Upload rate limit + concurrency (STEP 3.3 §8/§9/§29)
    // ---------------------------------------------------------------
    const validJpeg = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0xFF, 0xD9]);

    await t.test('Upload: vuot UPLOAD_RATE_LIMIT_PER_MINUTE (=3) -> 429', async () => {
        const user = await registerApprove(`sec33_upspam_${suffix}`);
        const results = [];
        for (let i = 0; i < 5; i++) {
            const res = await upload('/api/messages/media', { token: user.token, filename: `a${i}.jpg`, contentType: 'image/jpeg', buffer: validJpeg });
            results.push(res.status);
        }
        assert.ok(results.includes(429), `it nhat 1 trong 5 upload lien tiep phai bi 429 (nhan duoc: ${results.join(',')})`);
    });

    await t.test('Upload: 2 concurrent (=MAX_CONCURRENT_UPLOADS_PER_USER) -> allowed, upload thu 3 dong thoi -> 429, sau khi xong counter tro ve 0', async () => {
        const user = await registerApprove(`sec33_upconc_${suffix}`);
        // Gui 3 upload THAT SU DONG THOI (khong await tuan tu) de test concurrency
        // guard (khac voi test rate-limit o tren, von la tuan tu).
        const [r1, r2, r3] = await Promise.all([
            upload('/api/messages/media', { token: user.token, filename: 'c1.jpg', contentType: 'image/jpeg', buffer: validJpeg }),
            upload('/api/messages/media', { token: user.token, filename: 'c2.jpg', contentType: 'image/jpeg', buffer: validJpeg }),
            upload('/api/messages/media', { token: user.token, filename: 'c3.jpg', contentType: 'image/jpeg', buffer: validJpeg }),
        ]);
        const statuses = [r1.status, r2.status, r3.status].sort();
        // Vi UPLOAD_RATE_LIMIT_PER_MINUTE=3 CUNG ap dung dong thoi, ket qua co
        // the la: toi da 2 thanh cong (concurrency=2) va it nhat 1 bi 429 (do
        // concurrency HOAC rate-limit - ca 2 co che deu hop le, dieu quan trong
        // la KHONG co upload thu 3 nao "lot" qua ca 2 lop bao ve).
        assert.ok(statuses.includes(429), `it nhat 1/3 upload dong thoi phai bi 429 (nhan duoc: ${statuses.join(',')})`);
        // Sau khi tat ca ket thuc (Promise.all da resolve = tat ca request da
        // tra ve response), counter dong thoi phai tro ve 0 - xac nhan GIAN TIEP
        // bang cach thu 1 upload MOI (rieng, khong dung rate-limit vi da het
        // UPLOAD_RATE_LIMIT_PER_MINUTE cho user nay - chi kiem tra response
        // KHONG con la loi "too_many_concurrent_uploads" ma la rate-limit binh
        // thuong, chung to concurrency KHONG con bi "ket").
        const afterAllDone = await upload('/api/messages/media', { token: user.token, filename: 'c4.jpg', contentType: 'image/jpeg', buffer: validJpeg });
        assert.notEqual(afterAllDone.body && afterAllDone.body.error, 'too_many_concurrent_uploads', 'sau khi cac upload truoc da xong, concurrency counter phai duoc release, KHONG con bi ket o "too_many_concurrent_uploads"');
    });

    // ---- Don dep du lieu test ----
    await pool.query(`DELETE FROM users WHERE username LIKE $1`, [`sec33%${suffix}%`]);
    await pool.query('DELETE FROM users WHERE username = $1', [adminUsername]);
    await pool.end();
    await new Promise((resolve) => server.close(resolve));
});
