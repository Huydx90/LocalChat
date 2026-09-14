// test/performance.test.js
//
// STEP 4 - Performance & Resource Optimization.
// STEP 4 FIX - Test Isolation & Final Verification.
//
// Gom 2 nhom test cho cac thay doi STEP 4:
//   A. "isWsClientOverBuffered" - predicate THUAN TUY cho WS backpressure
//      (§14) - chi can `npm install` (khong can Postgres that ket noi duoc).
//   B. Pagination/index audit - integration test THAT qua Postgres (§4/§5),
//      can TEST_DATABASE_URL, tu SKIP neu khong co.
//
// *** KIEN TRUC LOAD MODULE (STEP 4 FIX - quan trong, doc truoc khi sua) ***
// "server.js" CHI doc "process.env.DATABASE_URL" DUNG 1 LAN, ngay luc module
// duoc require() lan dau (dong "new Pool({ connectionString, ... })" chay
// NGAY luc do va "dong bang" connection string vao pool). Doi
// "process.env.DATABASE_URL" SAU KHI da require('../server') KHONG co tac
// dung gi len pool da duoc tao - "pool" van tiep tuc tro toi connection
// string CU. Phien ban truoc cua file nay require('../server') 2 LAN (1 lan
// o dau file voi DATABASE_URL gia cho phan pure test, 1 lan nua BEN TRONG
// than test tich hop sau khi gan process.env.DATABASE_URL = TEST_DATABASE_URL)
// - nhung vi Node cache module theo duong dan file, lan require() thu 2 chi
// TRA VE LAI object CACHE cua lan dau (van dung DATABASE_URL gia), khien
// integration test that su thao tac tren 1 pool tro sai database.
//
// Fix: QUYET DINH DATABASE_URL DUNG 1 LAN duy nhat, TRUOC BAT KY require('../server')
// nao trong file nay, dua tren viec TEST_DATABASE_URL co ton tai hay khong -
// va CHI require('../server') MOT LAN DUY NHAT o dau file, dung chung cho ca
// 2 nhom test ben duoi (khong require lai o bat ky dau khac). Day la thiet ke
// don gian nhat de dam bao "load server" luon xay ra SAU KHI da xac dinh xong
// DATABASE_URL can dung - KHONG dung "delete require.cache[...]" (mong manh:
// pool/listener/timer cu cua lan require truoc co the van con song, kho don
// dep chac chan - dung y §4 cua yeu cau sua loi).
//
// Chay:
//   node --test test/performance.test.js                          (chi phan A chay that, phan B SKIP)
//   TEST_DATABASE_URL=postgres://postgres:test@localhost:5433/postgres npm run test:integration

const test = require('node:test');
const assert = require('node:assert/strict');

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

// Buoc 1: QUYET DINH DATABASE_URL cho CA FILE, TRUOC KHI require('../server').
if (TEST_DATABASE_URL) {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
} else {
    // Khong co TEST_DATABASE_URL -> nhom test B (integration) se SKIP hoan
    // toan (xem dieu kien skip ben duoi, chi dua vao "!TEST_DATABASE_URL",
    // KHONG lien quan gia tri DATABASE_URL nay). Gia tri "hop le ve cu phap"
    // duoi day CHI de server.js load duoc (khong throw o buoc "new Pool()")
    // cho nhom test A (pure, khong thuc su ket noi DB) chay duoc.
    process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://user:pass@127.0.0.1:5432/fake_do_not_connect';
}
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-step4-perf-0000000000000000';
process.env.MESSAGE_ENCRYPTION_KEY = process.env.MESSAGE_ENCRYPTION_KEY || require('crypto').randomBytes(32).toString('base64');
const suffix = Date.now();
process.env.ADMIN_USERNAME = process.env.ADMIN_USERNAME || `step4_admin_${suffix}`;
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin-pass-test-123456';
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.PORT = '0';
// Noi rong rate-limit - file nay KHONG kiem tra rate-limit, tranh 429 "gia"
// lam sai lech ket qua khong lien quan (cung pattern voi cac test khac).
process.env.MESSAGE_RATE_LIMIT_BURST_MAX = process.env.MESSAGE_RATE_LIMIT_BURST_MAX || '1000';
process.env.MESSAGE_RATE_LIMIT_PER_MINUTE = process.env.MESSAGE_RATE_LIMIT_PER_MINUTE || '1000';
process.env.LOGIN_RATE_LIMIT_IP_MAX = process.env.LOGIN_RATE_LIMIT_IP_MAX || '1000';
process.env.LOGIN_RATE_LIMIT_ACCOUNT_MAX = process.env.LOGIN_RATE_LIMIT_ACCOUNT_MAX || '1000';
process.env.REGISTER_RATE_LIMIT_MAX = process.env.REGISTER_RATE_LIMIT_MAX || '1000';

// Buoc 2: require('../server') DUNG 1 LAN DUY NHAT cho toan bo file, SAU KHI
// DATABASE_URL da duoc quyet dinh xong o buoc 1.
let serverModule = null;
let loadError = null;
try {
    serverModule = require('../server');
} catch (err) {
    loadError = err;
}
const canRunPureTests = !!serverModule && !loadError;

// ---------------------------------------------------------------------
// A. isWsClientOverBuffered (STEP 4 §14 - WebSocket backpressure)
// KHONG dung DB - an toan chay voi serverModule da load o tren (bat ke
// DATABASE_URL that hay gia, vi predicate nay khong cham pool/DB).
// ---------------------------------------------------------------------

test('STEP 4 §14 - isWsClientOverBuffered: quyet dinh dung/sai dua tren nguong (under/exactly/over limit)', { skip: !canRunPureTests && `npm install chưa chạy trong môi trường này (${loadError && loadError.code}) - bỏ qua, KHÔNG coi là FAIL.` }, () => {
    const { isWsClientOverBuffered } = serverModule;
    // Under limit
    assert.equal(isWsClientOverBuffered(0, 1000), false, 'chua co gi trong hang doi -> chua vuot');
    assert.equal(isWsClientOverBuffered(999, 1000), false, 'duoi nguong -> chua vuot');
    // Exactly limit - hanh vi HIEN TAI cua production code la dung ">" (khong
    // phai ">="), nen DUNG BANG nguong van duoc coi la "chua vuot" - test nay
    // xac nhan DUNG hanh vi do (khong doi production semantics chi de test).
    assert.equal(isWsClientOverBuffered(1000, 1000), false, 'DUNG bang nguong -> CHUA tinh la vuot (production dung ">" khong phai ">=")');
    // Over limit
    assert.equal(isWsClientOverBuffered(1001, 1000), true, 'vuot 1 byte -> da vuot');
    assert.equal(isWsClientOverBuffered(10_000_000, 1000), true, 'vuot rat nhieu -> da vuot');
});

test('STEP 4 §14 - isWsClientOverBuffered: gia tri bat thuong (undefined/null/NaN/negative/non-number) khong throw, khop dung hanh vi production hien tai', { skip: !canRunPureTests && `npm install chưa chạy trong môi trường này (${loadError && loadError.code}) - bỏ qua, KHÔNG coi là FAIL.` }, () => {
    const { isWsClientOverBuffered } = serverModule;
    // Production code: "typeof bufferedAmount === 'number' && bufferedAmount > maxBufferedBytes"
    // -> bat ky gia tri khong phai "number" nao deu tra ve false (an toan,
    // khong throw, khong vo tinh dong ket noi vi 1 gia tri bat thuong).
    assert.equal(isWsClientOverBuffered(undefined, 1000), false);
    assert.equal(isWsClientOverBuffered(null, 1000), false);
    assert.equal(isWsClientOverBuffered('not-a-number', 1000), false);
    assert.equal(isWsClientOverBuffered({}, 1000), false);
    assert.equal(isWsClientOverBuffered([], 1000), false);
    // NaN: typeof NaN === 'number' la true, nhung "NaN > 1000" luon la false
    // (NaN so sanh voi bat ky so nao cung false) -> ket qua van la false, dung
    // y "an toan, khong vo co dong ket noi".
    assert.equal(isWsClientOverBuffered(NaN, 1000), false);
    // So am (khong hop le ve mat vat ly cho bufferedAmount that, nhung predicate
    // van phai xu ly an toan neu vi ly do nao do nhan duoc gia tri nay).
    assert.equal(isWsClientOverBuffered(-5, 1000), false);
    assert.doesNotThrow(() => isWsClientOverBuffered(Symbol('x'), 1000));
});

// ---------------------------------------------------------------------
// B. Pagination determinism + index audit (STEP 4 §4/§5) - can Postgres that
// ---------------------------------------------------------------------

test('STEP 4 §4/§5 - Pagination cursor-based + index audit', { skip: !TEST_DATABASE_URL }, async (t) => {
    // KHONG require('../server') lai o day - dung DUNG serverModule da load
    // o buoc 2 (voi DATABASE_URL = TEST_DATABASE_URL, dat truoc khi require,
    // xem giai thich kien truc o dau file).
    const { server, pool, start } = serverModule;
    const adminUsername = process.env.ADMIN_USERNAME;
    const adminPassword = process.env.ADMIN_PASSWORD;
    const testUsername = `step4_user_${suffix}`;
    // STEP 4 FINAL FIX: cac bien trang thai nay duoc khai bao TRUOC try/finally
    // (khong phai ben trong try) de finally VAN truy cap duoc chung ke ca khi
    // setup that bai rat som (vd server khong listen duoc) - dam bao cleanup
    // luon co du thong tin can thiet de chay, bat ke try block dung lai o dau.
    let serverListening = false;
    const cleanupErrors = [];

    try {
        await new Promise((resolve, reject) => {
            server.once('listening', resolve);
            server.once('error', reject);
            start();
        });
        serverListening = true;
        const port = server.address().port;
        const base = `http://127.0.0.1:${port}`;

        async function api(pathName, { method = 'GET', token, body } = {}) {
            const headers = { 'Content-Type': 'application/json' };
            if (token) headers.Authorization = `Bearer ${token}`;
            const res = await fetch(base + pathName, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
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
        const user = await registerApprove(testUsername);

        await t.test('DB indexes: cac index quan trong (messages.created_at, messages.reply_to_id, message_reactions unique(message_id, username)) ton tai', async () => {
            const res = await pool.query(`
                SELECT indexname, indexdef FROM pg_indexes
                WHERE tablename IN ('messages', 'message_reactions')
            `);
            const names = res.rows.map(r => r.indexname);
            assert.ok(names.some(n => n.includes('created_at')), `phai co index tren messages.created_at (nhan duoc: ${names.join(', ')})`);
            assert.ok(names.some(n => n.includes('reply_to_id')), `phai co index tren messages.reply_to_id (nhan duoc: ${names.join(', ')})`);
            // UNIQUE(message_id, username) tu dong tao 1 btree index co the dung cho
            // truy van "WHERE message_id = X" (message_id la cot dau tien) - khong
            // can index rieng them cho message_reactions.message_id.
            const reactionsIndexes = res.rows.filter(r => r.indexdef.includes('message_reactions'));
            assert.ok(reactionsIndexes.some(r => r.indexdef.includes('message_id')), 'phai co it nhat 1 index tren message_reactions bao gom message_id');
        });

        await t.test('Pagination: gui 5 tin nhan, doc lai bang afterId/beforeId/khong-cursor phai NHAT QUAN thu tu (id tang dan trong response) va DUNG PHAM VI', async () => {
            const sent = [];
            for (let i = 0; i < 5; i++) {
                const res = await api('/api/messages', { method: 'POST', token: user.token, body: { text: `perf-page-${suffix}-${i}` } });
                assert.equal(res.status, 200);
                sent.push(res.body.message.id);
            }
            // Khong cursor (mac dinh): tra ve moi nhat, nhung SAP XEP TANG DAN theo id
            // trong response (server.js: "ORDER BY b.id ASC" o vong ngoai).
            const noCursor = await api(`/api/messages?limit=5`, { token: user.token });
            assert.equal(noCursor.status, 200);
            const noCursorIds = noCursor.body.messages.map(m => m.id);
            const sortedAsc = [...noCursorIds].sort((a, b) => a - b);
            assert.deepEqual(noCursorIds, sortedAsc, 'response phai sap xep TANG DAN theo id (khong phai thu tu ngau nhien/giam dan)');

            // afterId: lay tin nhan SAU 1 diem moc - phai la 1 tap con LIEN TUC, tang dan.
            const afterRes = await api(`/api/messages?afterId=${sent[1]}&limit=10`, { token: user.token });
            assert.equal(afterRes.status, 200);
            const afterIds = afterRes.body.messages.map(m => m.id);
            assert.ok(afterIds.every(id => id > sent[1]), `moi id tra ve phai > afterId=${sent[1]} (nhan duoc: ${afterIds.join(',')})`);
            assert.deepEqual(afterIds, [...afterIds].sort((a, b) => a - b), 'afterId phai tra ve tang dan');

            // beforeId: lay tin nhan TRUOC 1 diem moc.
            const beforeRes = await api(`/api/messages?beforeId=${sent[3]}&limit=10`, { token: user.token });
            assert.equal(beforeRes.status, 200);
            const beforeIds = beforeRes.body.messages.map(m => m.id);
            assert.ok(beforeIds.every(id => id < sent[3]), `moi id tra ve phai < beforeId=${sent[3]} (nhan duoc: ${beforeIds.join(',')})`);
            assert.deepEqual(beforeIds, [...beforeIds].sort((a, b) => a - b), 'beforeId phai tra ve tang dan');
        });

        await t.test('Pagination: limit=0/qua lon van an toan (da co strict validation tu STEP 3.2, khong lien quan STEP 4 nhung xac nhan khong regress)', async () => {
            const zero = await api(`/api/messages?limit=0`, { token: user.token });
            assert.equal(zero.status, 400); // "0" khong phai positive int hop le (parsePositiveIntStrict)
            const huge = await api(`/api/messages?limit=999999`, { token: user.token });
            assert.equal(huge.status, 200);
            assert.ok(huge.body.messages.length <= 200, 'limit phai bi cap toi da 200 du client xin nhieu hon');
        });
    } finally {
        // STEP 4 FINAL FIX §3-§10: cleanup EXCEPTION-SAFE - chay du setup/
        // assertion o tren THANH CONG hay THAT BAI (bao gom throw giua chung).
        // Moi buoc doc lap trong try/catch RIENG: 1 buoc that bai KHONG duoc
        // ngan cac buoc con lai chay (vd neu DELETE messages loi vi ly do gi
        // do, van phai co gang DELETE users/dong server/dong pool). Loi cleanup
        // (neu co) duoc GOM LAI va chi canh bao qua console.warn - TUYET DOI
        // KHONG throw trong finally, vi throw o day se GHI DE len loi
        // assertion GOC (neu co) khien nguoi doc test thay nham nguyen nhan
        // that bai (spec §8: "Preserve original test failure").
        //
        // Chi xoa DUNG du lieu do CHINH test nay tao (theo testUsername/
        // adminUsername duy nhat theo "suffix") - KHONG dung "DELETE FROM
        // messages;" hay LIKE pattern rong. Reactions (ON DELETE CASCADE) va
        // reply_to_id cua message khac tro toi cac message nay (ON DELETE SET
        // NULL) duoc don dep TU DONG boi schema hien co, khong can xu ly thu cong.
        try {
            await pool.query('DELETE FROM messages WHERE sender = $1', [testUsername]);
        } catch (err) {
            cleanupErrors.push(`DELETE messages (sender=${testUsername}): ${err.message}`);
        }
        try {
            await pool.query('DELETE FROM users WHERE username = $1', [testUsername]);
        } catch (err) {
            cleanupErrors.push(`DELETE user (${testUsername}): ${err.message}`);
        }
        try {
            await pool.query('DELETE FROM users WHERE username = $1', [adminUsername]);
        } catch (err) {
            cleanupErrors.push(`DELETE user (${adminUsername}): ${err.message}`);
        }
        // pool.end() DUNG 1 LAN DUY NHAT o day (khong co duong nao khac trong
        // file nay goi pool.end() - tranh double-close).
        try {
            await pool.end();
        } catch (err) {
            cleanupErrors.push(`pool.end(): ${err.message}`);
        }
        // Chi dong server NEU no THAT SU da listen thanh cong (serverListening) -
        // tranh cho vo han/loi vo ich neu server chua bao gio khoi dong duoc
        // (vd "start()" throw truoc khi kip phat su kien 'listening').
        if (serverListening) {
            try {
                await new Promise((resolve) => server.close(() => resolve()));
            } catch (err) {
                cleanupErrors.push(`server.close(): ${err.message}`);
            }
        }
        if (cleanupErrors.length > 0) {
            console.warn(
                `[performance.test.js] CANH BAO: ${cleanupErrors.length} loi xay ra trong buoc cleanup ` +
                `(KHONG anh huong ket qua PASS/FAIL cua assertion chinh o tren):\n - ${cleanupErrors.join('\n - ')}`
            );
        }
    }
});
