// test/rate-limit.test.js
//
// STEP 3.3 - Rate Limiting, Abuse Protection & WebSocket Hardening.
//
// UNIT TEST THUAN TUY cho rate-limit.js. KHONG require server.js, KHONG can
// express/pg/ws duoc cai dat, KHONG can Postgres/network - chay duoc ngay ca
// truoc khi `npm install`. Cung nguyen tac voi test/storage-policy.test.js
// va test/input-validation.test.js.
//
// Chay: node --test test/rate-limit.test.js  (hoac: npm test)

const test = require('node:test');
const assert = require('node:assert/strict');

const { RateLimiter, ConcurrencyGuard, getHttpClientIp, getWsClientIp, normalizeIp, isSingleValidIp } = require('../rate-limit');

// ---------------------------------------------------------------------
// RateLimiter
// ---------------------------------------------------------------------

test('STEP 3.3 §4 - RateLimiter: constructor tu choi cau hinh sai (0/am/NaN/Infinity)', () => {
    for (const bad of [0, -1, NaN, Infinity, -Infinity]) {
        assert.throws(() => new RateLimiter({ windowMs: bad, max: 5 }));
        assert.throws(() => new RateLimiter({ windowMs: 1000, max: bad }));
    }
});

test('STEP 3.3 §28 - RateLimiter: duoi nguong -> allowed, vuot nguong -> tu choi', () => {
    const rl = new RateLimiter({ windowMs: 60_000, max: 3 });
    for (let i = 0; i < 3; i++) {
        const r = rl.consume('user-a');
        assert.equal(r.allowed, true, `request thu ${i + 1}/3 phai duoc cho phep`);
    }
    const fourth = rl.consume('user-a');
    assert.equal(fourth.allowed, false, 'request thu 4 (vuot max=3) phai bi tu choi');
    assert.ok(fourth.retryAfterSeconds >= 1, 'retryAfterSeconds phai la so duong hop ly de dung cho Retry-After header');
});

test('STEP 3.3 §28 - RateLimiter: 1 user bi rate-limit KHONG lam user khac bi anh huong (per-key doc lap)', () => {
    const rl = new RateLimiter({ windowMs: 60_000, max: 1 });
    assert.equal(rl.consume('alice').allowed, true);
    assert.equal(rl.consume('alice').allowed, false); // alice da vuot
    assert.equal(rl.consume('bob').allowed, true); // bob khong bi anh huong boi alice
});

test('STEP 3.3 - RateLimiter: sau khi het window, counter tu reset (khong con bi khoa vinh vien)', async () => {
    const rl = new RateLimiter({ windowMs: 50, max: 1 });
    assert.equal(rl.consume('k').allowed, true);
    assert.equal(rl.consume('k').allowed, false);
    await new Promise((r) => setTimeout(r, 70));
    assert.equal(rl.consume('k').allowed, true, 'qua window moi phai duoc cho phep lai');
});

test('STEP 3.3 FIX §1 - RateLimiter.tryConsume(): alias cua consume(), hanh vi giong het (cung tang bo dem)', () => {
    const rl = new RateLimiter({ windowMs: 60_000, max: 2 });
    assert.equal(rl.tryConsume('k').allowed, true);
    assert.equal(rl.tryConsume('k').allowed, true);
    assert.equal(rl.tryConsume('k').allowed, false, 'lan thu 3 vuot max=2 phai bi tu choi - chung to tryConsume() cung 1 bo dem voi consume()');
    // Xac nhan dung chung 1 state: goi consume() truc tiep cung phai thay da vuot.
    assert.equal(rl.consume('k').allowed, false);
});

test('STEP 3.3 FIX §1/§28 - Atomic admission: N "request dong thoi" (goi tryConsume() lien tiep, khong await xen giua) - dung DUNG max request duoc allowed, phan con lai bi tu choi (khong co request "lot qua" thua)', () => {
    // Mo phong "20 login request cung luc" bang cach goi tryConsume() 20 lan
    // LIEN TIEP, KHONG co await nao xen giua (giong dung cach code goi that o
    // route login: tryConsume() truoc, roi moi await DB/bcrypt) - vi JS don
    // luong, day CHINH XAC la kich ban "N request Express handler khac nhau
    // cung goi tryConsume() truoc khi bat ky handler nao kip chay await" - thu
    // tu goi ham dong bo la tat ca nhung gi quan trong, khong phu thuoc
    // scheduling/timing thuc te nen test nay hoan toan deterministic.
    const rl = new RateLimiter({ windowMs: 60_000, max: 5 });
    const results = [];
    for (let i = 0; i < 20; i++) {
        results.push(rl.tryConsume('shared-key').allowed);
    }
    const allowedCount = results.filter(Boolean).length;
    assert.equal(allowedCount, 5, `dung 5/20 "request dong thoi" duoc allowed=true (nhan duoc ${allowedCount})`);
    // 5 cai DAU TIEN phai la nhung cai duoc allowed (fixed-window: request den
    // truoc duoc uu tien), 15 cai sau bi tu choi.
    assert.deepEqual(results, [true, true, true, true, true, ...Array(15).fill(false)]);
});

test('STEP 3.3 FIX §1 - Atomic admission: 2 "user" khac nhau goi xen ke nhau (interleaved) van doc lap dung, khong lam lech bo dem cua nhau', () => {
    const rl = new RateLimiter({ windowMs: 60_000, max: 3 });
    const seqA = [], seqB = [];
    // Xen ke A, B, A, B, ... - mo phong 2 request handler khac nhau (2 user
    // khac nhau) dan xen thuc thi (van hoan toan dong bo, khong await).
    for (let i = 0; i < 6; i++) {
        seqA.push(rl.tryConsume('userA').allowed);
        seqB.push(rl.tryConsume('userB').allowed);
    }
    assert.deepEqual(seqA, [true, true, true, false, false, false]);
    assert.deepEqual(seqB, [true, true, true, false, false, false]);
});


test('STEP 3.3 §5 - RateLimiter.peek(): doc trang thai KHONG lam tang bo dem (khac consume())', () => {
    const rl = new RateLimiter({ windowMs: 60_000, max: 2 });
    assert.equal(rl.peek('k').allowed, true);
    assert.equal(rl.peek('k').allowed, true); // goi peek() nhieu lan khong lam tang gi ca
    assert.equal(rl.consume('k').allowed, true); // lan 1: that su tinh
    assert.equal(rl.peek('k').allowed, true); // van con 1 slot (2-1=1)
    assert.equal(rl.consume('k').allowed, true); // lan 2: dung nguong max=2
    assert.equal(rl.peek('k').allowed, false, 'da dat max=2, peek() phai bao false (khong con slot) du chua "tieu thu" them');
});

test('STEP 3.3 §5 - RateLimiter.peek(): key chua tung dung -> luon allowed=true', () => {
    const rl = new RateLimiter({ windowMs: 60_000, max: 1 });
    assert.equal(rl.peek('brand-new-key').allowed, true);
});

test('STEP 3.3 §5 - RateLimiter.reset(): xoa bo dem cho 1 key (dung khi login thanh cong)', () => {
    const rl = new RateLimiter({ windowMs: 60_000, max: 1 });
    assert.equal(rl.consume('someuser').allowed, true);
    assert.equal(rl.consume('someuser').allowed, false);
    rl.reset('someuser');
    assert.equal(rl.consume('someuser').allowed, true, 'sau reset() phai duoc cho phep lai tu dau');
});

test('STEP 3.3 §35 - RateLimiter.sweep(): don entry het han, KHONG dong cham entry con hop le', async () => {
    const rl = new RateLimiter({ windowMs: 30, max: 5 });
    rl.consume('expiring-key');
    rl.consume('another-expiring-key');
    assert.equal(rl.size, 2);
    await new Promise((r) => setTimeout(r, 50));
    // Them 1 key MOI (chua het han) truoc khi sweep, de xac nhan sweep() chi
    // xoa entry HET HAN, khong xoa tat ca.
    rl.consume('fresh-key');
    assert.equal(rl.size, 3);
    rl.sweep();
    assert.equal(rl.size, 1, 'chi con lai key con "song" (fresh-key)');
});

test('STEP 3.3 - RateLimiter: hang nghin key khac nhau khong lam sweep() cham/loi (memory-safety co ban)', () => {
    const rl = new RateLimiter({ windowMs: 60_000, max: 5 });
    for (let i = 0; i < 5000; i++) rl.consume(`ip-${i}`);
    assert.equal(rl.size, 5000);
    rl.sweep(); // chua het han, khong xoa gi (van kiem tra khong throw/treo)
    assert.equal(rl.size, 5000);
});

// ---------------------------------------------------------------------
// ConcurrencyGuard
// ---------------------------------------------------------------------

test('STEP 3.3 §9 - ConcurrencyGuard: constructor tu choi max sai', () => {
    for (const bad of [0, -1, NaN, Infinity]) {
        assert.throws(() => new ConcurrencyGuard({ max: bad }));
    }
});

test('STEP 3.3 §29 - ConcurrencyGuard: 2 tryAcquire -> true, cai thu 3 (vuot nguong) -> false', () => {
    const guard = new ConcurrencyGuard({ max: 2 });
    assert.equal(guard.tryAcquire('user-1'), true);
    assert.equal(guard.tryAcquire('user-1'), true);
    assert.equal(guard.tryAcquire('user-1'), false, 'cai thu 3 vuot nguong max=2 phai bi tu choi');
    assert.equal(guard.get('user-1'), 2);
});

test('STEP 3.3 §29 - ConcurrencyGuard: sau release(), counter giam va cho phep acquire lai', () => {
    const guard = new ConcurrencyGuard({ max: 2 });
    guard.tryAcquire('u');
    guard.tryAcquire('u');
    assert.equal(guard.tryAcquire('u'), false);
    guard.release('u');
    assert.equal(guard.get('u'), 1);
    assert.equal(guard.tryAcquire('u'), true, 'sau khi 1 upload ket thuc (release), phai co the acquire lai');
});

test('STEP 3.3 §29 - ConcurrencyGuard: release() ve dung 0 phai XOA HAN key khoi Map (khong de rac lai vinh vien)', () => {
    const guard = new ConcurrencyGuard({ max: 5 });
    guard.tryAcquire('temp-user');
    assert.equal(guard.size, 1);
    guard.release('temp-user');
    assert.equal(guard.size, 0, 'key phai duoc xoa het khoi Map khi ve 0 - neu khong, Map se phinh to vo han theo so user tung upload 1 lan');
});

test('STEP 3.3 §29 - ConcurrencyGuard: release() tren key chua tung acquire khong throw, khong lam am (an toan cho finally-block goi thua)', () => {
    const guard = new ConcurrencyGuard({ max: 3 });
    assert.doesNotThrow(() => guard.release('never-acquired'));
    assert.equal(guard.get('never-acquired'), 0);
});

test('STEP 3.3 §29 - ConcurrencyGuard: mo phong loi giua chung (try/finally) - counter luon duoc release dung', () => {
    const guard = new ConcurrencyGuard({ max: 1 });
    function simulateUploadThatThrows(key) {
        if (!guard.tryAcquire(key)) return { accepted: false };
        try {
            throw new Error('gia lap loi HEIC conversion/database/multer giua chung');
        } finally {
            guard.release(key);
        }
    }
    assert.throws(() => simulateUploadThatThrows('u'));
    assert.equal(guard.get('u'), 0, 'du co exception giua chung, finally van phai release dung counter');
    // Vi da duoc release, upload TIEP THEO cua CUNG user phai duoc chap nhan lai (khong bi "ket" o max).
    assert.equal(guard.tryAcquire('u'), true);
});

test('STEP 3.3 §29 - ConcurrencyGuard: 2 key doc lap (per-user va per-IP co the dung 2 instance rieng)', () => {
    const perUser = new ConcurrencyGuard({ max: 2 });
    const perIp = new ConcurrencyGuard({ max: 5 });
    assert.equal(perUser.tryAcquire('alice'), true);
    assert.equal(perIp.tryAcquire('1.2.3.4'), true);
    assert.equal(perUser.get('bob'), 0); // khong bi anh huong boi alice
});

// ---------------------------------------------------------------------
// getHttpClientIp / getWsClientIp / normalizeIp / isSingleValidIp
// (FINAL STEP 3.3 FIX — thiet ke lai hoan toan sau 2 vong audit truoc: bo
// HOAN TOAN X-Forwarded-For khoi duong dan tin cay (khong con "dem so hop"),
// thay bang CF-Connecting-IP CO KIEM SOAT qua co "trustCfConnectingIp"
// tuong minh, mac dinh AN TOAN la KHONG tin gi ca va fallback ve socket
// address. Xem giai thich day du trong rate-limit.js.)
// ---------------------------------------------------------------------

test('FINAL STEP 3.3 FIX - isSingleValidIp: chap nhan IPv4/IPv6 hop le', () => {
    assert.equal(isSingleValidIp('203.0.113.5'), true);
    assert.equal(isSingleValidIp('127.0.0.1'), true);
    assert.equal(isSingleValidIp('2001:db8::1234'), true);
    assert.equal(isSingleValidIp('::1'), true);
    assert.equal(isSingleValidIp('  203.0.113.5  '), true, 'khoang trang o dau/cuoi duoc trim truoc khi validate');
});

test('FINAL STEP 3.3 FIX §14 (Test 4) - isSingleValidIp: TU CHOI moi gia tri khong phai 1 IP don hop le', () => {
    const bad = [
        'garbage', '', '   ', '1.2.3.4,5.6.7.8', '1.2.3.4, 5.6.7.8', ',', ',,,',
        '1.2.3\r\n.4', '1.2 .3.4', '1.2.3.4 5.6.7.8', '999.999.999.999',
        '1.2.3', '1.2.3.4.5', 'not-an-ip-at-all', null, undefined, 123, {}, [], true,
    ];
    for (const v of bad) {
        assert.equal(isSingleValidIp(v), false, `expected false cho input: ${JSON.stringify(v)}`);
    }
});

test('FINAL STEP 3.3 FIX §14 (Test 1/2/3) - normalizeIp: IPv4 giu nguyen, IPv4-mapped-IPv6 duoc bo tien to, IPv6 that duoc giu nguyen', () => {
    // Test 1 — normalize IPv4
    assert.equal(normalizeIp('192.168.1.100'), '192.168.1.100');
    // Test 2 — normalize IPv4-mapped IPv6
    assert.equal(normalizeIp('::ffff:192.168.1.100'), '192.168.1.100');
    assert.equal(normalizeIp('::FFFF:192.168.1.100'), '192.168.1.100'); // khong phan biet hoa/thuong
    // Test 3 — preserve IPv6 that (KHONG co tien to ::ffff:)
    assert.equal(normalizeIp('2001:db8::1234'), '2001:db8::1234');
    assert.equal(normalizeIp('::1'), '::1');
});

test('FINAL STEP 3.3 FIX §15 (Test 1) - getHttpClientIp: TIN CF-Connecting-IP khi trustCfConnectingIp=true VA header hop le', () => {
    const req = { headers: { 'cf-connecting-ip': '203.0.113.42' }, socket: { remoteAddress: '10.0.0.5' } };
    assert.equal(getHttpClientIp(req, { trustCfConnectingIp: true }), '203.0.113.42');
});

test('FINAL STEP 3.3 FIX §15 (Test 2) - getHttpClientIp: THIEU CF-Connecting-IP -> fallback an toan ve socket', () => {
    const req = { headers: {}, socket: { remoteAddress: '10.0.0.5' } };
    assert.equal(getHttpClientIp(req, { trustCfConnectingIp: true }), '10.0.0.5');
});

test('FINAL STEP 3.3 FIX §15 (Test 3) - getHttpClientIp: CF-Connecting-IP KHONG HOP LE -> fallback an toan ve socket, KHONG dung gia tri rac', () => {
    const badValues = ['garbage', '', '   ', '1.2.3.4,5.6.7.8', '\r\nmalicious'];
    for (const bad of badValues) {
        const req = { headers: { 'cf-connecting-ip': bad }, socket: { remoteAddress: '10.0.0.9' } };
        assert.equal(getHttpClientIp(req, { trustCfConnectingIp: true }), '10.0.0.9', `header CF-Connecting-IP="${bad}" khong hop le, phai fallback ve socket`);
    }
});

test('FINAL STEP 3.3 FIX §15 (Test 4) - getHttpClientIp: ket noi truc tiep (khong header nao) -> dung socket', () => {
    const req = { headers: {}, socket: { remoteAddress: '198.51.100.1' } };
    assert.equal(getHttpClientIp(req, { trustCfConnectingIp: false }), '198.51.100.1');
    assert.equal(getHttpClientIp(req), '198.51.100.1', 'mac dinh (khong truyen options) phai la KHONG tin CF-Connecting-IP');
});

test('FINAL STEP 3.3 FIX §15 (Test 5/6) - getHttpClientIp: X-Forwarded-For gia mao/nhieu gia tri KHONG con anh huong gi (da bo hoan toan khoi duong dan tin cay)', () => {
    const req1 = { headers: { 'x-forwarded-for': '1.2.3.4' }, socket: { remoteAddress: '10.0.0.5' } };
    assert.equal(getHttpClientIp(req1, { trustCfConnectingIp: true }), '10.0.0.5', 'XFF khong con duoc doc du trustCfConnectingIp=true (chi CF-Connecting-IP moi duoc xem xet)');
    const req2 = { headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8, 9.10.11.12' }, socket: { remoteAddress: '10.0.0.5' } };
    assert.equal(getHttpClientIp(req2), '10.0.0.5');
});

test('FINAL STEP 3.3 FIX - getHttpClientIp: TU CHOI CF-Connecting-IP tu client KHONG duoc tin cay (trustCfConnectingIp=false, mac dinh) du header hop le', () => {
    // Day la kich ban CHINH cua Issue 3/§3 - client tu ket noi TRUC TIEP va tu
    // gui header CF-Connecting-IP HOP LE VE MAT DINH DANG (khong phai rac) -
    // NEU khong bat trustCfConnectingIp, header nay TUYET DOI khong duoc tin,
    // bat ke no "trong giong that" toi dau.
    const req = { headers: { 'cf-connecting-ip': '1.2.3.4' }, socket: { remoteAddress: '10.0.0.5' } };
    assert.equal(getHttpClientIp(req, { trustCfConnectingIp: false }), '10.0.0.5', 'mac dinh KHONG tin CF-Connecting-IP - client tu ket noi truc tiep khong the tu chon IP dung de rate-limit');
});

test('FINAL STEP 3.3 FIX - getHttpClientIp: khong throw voi input thieu/rong bat thuong', () => {
    assert.equal(getHttpClientIp({}), 'unknown');
    assert.doesNotThrow(() => getHttpClientIp(null));
    assert.doesNotThrow(() => getHttpClientIp(undefined));
    assert.doesNotThrow(() => getHttpClientIp({ headers: { 'cf-connecting-ip': 123 } }, { trustCfConnectingIp: true }));
});

test('FINAL STEP 3.3 FIX §16 - getWsClientIp: HANH VI GIONG HET getHttpClientIp cho CUNG 1 input (dam bao HTTP/WS khong cho ra IP khac nhau cho cung 1 client)', () => {
    const trustedReq = { headers: { 'cf-connecting-ip': '203.0.113.42' }, socket: { remoteAddress: '10.0.0.5' } };
    assert.equal(getWsClientIp(trustedReq, { trustCfConnectingIp: true }), getHttpClientIp(trustedReq, { trustCfConnectingIp: true }));

    const missingReq = { headers: {}, socket: { remoteAddress: '10.0.0.5' } };
    assert.equal(getWsClientIp(missingReq, { trustCfConnectingIp: true }), '10.0.0.5'); // (Test A/B §16)

    const spoofedXffReq = { headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' }, socket: { remoteAddress: '10.0.0.5' } };
    assert.equal(getWsClientIp(spoofedXffReq, { trustCfConnectingIp: true }), '10.0.0.5', 'XFF (du nhieu entry) khong duoc dien giai la client identity (Test C/E §16)');

    const malformedCfReq = { headers: { 'cf-connecting-ip': '1.2.3.4,5.6.7.8' }, socket: { remoteAddress: '10.0.0.5' } };
    assert.equal(getWsClientIp(malformedCfReq, { trustCfConnectingIp: true }), '10.0.0.5', 'CF-Connecting-IP malformed -> fallback an toan (Test D §16)');
});

test('FINAL STEP 3.3 FIX §16 - getWsClientIp: khong throw voi input thieu/rong/malformed bat thuong', () => {
    assert.equal(getWsClientIp({}), 'unknown');
    assert.equal(getWsClientIp({ headers: {} }), 'unknown');
    assert.doesNotThrow(() => getWsClientIp(null));
    assert.doesNotThrow(() => getWsClientIp(undefined));
});

test('FINAL STEP 3.3 FIX §13 - getHttpClientIp/getWsClientIp: cung 1 client that (IPv4 vs bieu dien IPv4-mapped-IPv6) phai cho ra CUNG 1 rate-limit key', () => {
    const reqPlain = { headers: {}, socket: { remoteAddress: '192.168.1.1' } };
    const reqMapped = { headers: {}, socket: { remoteAddress: '::ffff:192.168.1.1' } };
    assert.equal(getHttpClientIp(reqPlain), getHttpClientIp(reqMapped));
    assert.equal(getWsClientIp(reqPlain), getWsClientIp(reqMapped));
});


