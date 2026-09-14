// test/input-validation.test.js
//
// STEP 3.2 - Input Validation, XSS, Injection & Upload/Media Security.
//
// UNIT TEST THUAN TUY cho input-validation.js (parsePositiveIntStrict,
// parseNonNegativeIntStrict, DISALLOWED_CONTROL_CHARS_RE, cac ham nhan dien
// magic-bytes anh/video, rejectDangerousKeys). File nay KHONG require
// server.js nen KHONG can express/pg/multer/heic-convert duoc cai dat, KHONG
// can DATABASE_URL/JWT_SECRET, KHONG can Postgres hay network - chay duoc
// ngay ca truoc khi `npm install`. Cung nguyen tac voi
// test/storage-policy.test.js (STEP 2.1 §19).
//
// Chay: node --test test/input-validation.test.js  (hoac: npm test)

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    parsePositiveIntStrict, parseNonNegativeIntStrict, DISALLOWED_CONTROL_CHARS_RE,
    looksLikeJpeg, looksLikePng, looksLikeGif, looksLikeWebp,
    looksLikeIsoBmffContainer, looksLikeEbml, looksLikeHeicBuffer,
    rejectDangerousKeys,
} = require('../input-validation');

test('STEP 3.2 §11 - parsePositiveIntStrict: gia tri hop le', () => {
    assert.equal(parsePositiveIntStrict('1'), 1);
    assert.equal(parsePositiveIntStrict('100'), 100);
    assert.equal(parsePositiveIntStrict('999999999999999'), 999999999999999); // 15 chu so, van hop le
    assert.equal(parsePositiveIntStrict(1), 1);
    assert.equal(parsePositiveIntStrict(100), 100);
    // Whitespace THUA o dau/cuoi (vd copy-paste tu URL) duoc trim truoc khi
    // kiem tra - day la chu y THIET KE (khoan dung voi khoang trang vo hai),
    // KHONG lam yeu validation vi phan con lai van phai khop CHINH XAC regex.
    assert.equal(parsePositiveIntStrict(' 1'), 1);
    assert.equal(parsePositiveIntStrict('1 '), 1);
    assert.equal(parsePositiveIntStrict(' 1 '), 1);
});

test('STEP 3.2 §11/§33 - parsePositiveIntStrict: tu choi TOAN BO ma tran gia tri sai dinh dang', () => {
    const bad = [
        '0', '-1', '1.5', '1.0', 'abc', '1abc', 'abc1', '', ' ', '   ', '\t', '\n',
        'NaN', 'Infinity', '-Infinity', null, undefined, {}, [], [1], true, false,
        NaN, Infinity, -Infinity, 1.5, -1, 0,
        '01', '007', '+1', '999999999999999999999999999999',
        '0x1', '1e3', '1,000', '1_000', '१२३', // chu so Unicode khac ASCII cung khong khop regex ASCII [0-9]
    ];
    for (const v of bad) {
        assert.equal(parsePositiveIntStrict(v), null, `expected null cho input: ${JSON.stringify(v)}`);
    }
});

test('STEP 3.2 §11 - parseNonNegativeIntStrict: cho phep them "0" (afterId=0 = "lay tu dau")', () => {
    assert.equal(parseNonNegativeIntStrict('0'), 0);
    assert.equal(parseNonNegativeIntStrict(0), 0);
    assert.equal(parseNonNegativeIntStrict('1'), 1);
    assert.equal(parseNonNegativeIntStrict('-1'), null);
    assert.equal(parseNonNegativeIntStrict('abc'), null);
    assert.equal(parseNonNegativeIntStrict('0.5'), null);
    assert.equal(parseNonNegativeIntStrict('00'), null); // khong phai "0" chinh xac
});

test('STEP 3.2 §4/§5 - DISALLOWED_CONTROL_CHARS_RE: chan null byte/C0 control, cho phep \\n \\t \\r va Unicode/emoji', () => {
    assert.equal(DISALLOWED_CONTROL_CHARS_RE.test('hello'), false);
    assert.equal(DISALLOWED_CONTROL_CHARS_RE.test('xin chào tất cả 👋🎉'), false);
    assert.equal(DISALLOWED_CONTROL_CHARS_RE.test('line1\nline2\ttab\rend'), false);
    assert.equal(DISALLOWED_CONTROL_CHARS_RE.test('null\x00byte'), true);
    assert.equal(DISALLOWED_CONTROL_CHARS_RE.test('bell\x07'), true);
    assert.equal(DISALLOWED_CONTROL_CHARS_RE.test('escape\x1B[31mred\x1B[0m'), true);
    assert.equal(DISALLOWED_CONTROL_CHARS_RE.test('del\x7F'), true);
    assert.equal(DISALLOWED_CONTROL_CHARS_RE.test('vtab\x0Bformfeed\x0C'), true);
});

test('STEP 3.2 §33 - XSS payload: van la CHUOI hop le (khong bi validation ham nay chan) - viec escape la trach nhiem client khi render', () => {
    // Ghi chu quan trong: input-validation.js KHONG co trach nhiem chan XSS -
    // do la string binh thuong, hop le ve mat "khong co control character".
    // XSS phai duoc ngan boi escapeHtml()/textContent o public/app.js (da audit
    // thu cong, xem final report muc D).
    const xssPayloads = [
        '<script>alert(1)</script>',
        '<img src=x onerror=alert(1)>',
        '<svg onload=alert(1)>',
    ];
    for (const p of xssPayloads) {
        assert.equal(DISALLOWED_CONTROL_CHARS_RE.test(p), false, `"${p}" khong chua control char, phai duoc chap nhan o tang nay`);
    }
});

test('STEP 3.2 §18/§34 - magic byte detection: nhan dien dung dinh dang that', () => {
    const jpeg = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0, 0, 0, 0]);
    const png = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0]);
    const gif87 = Buffer.from('GIF87a...........');
    const gif89 = Buffer.from('GIF89a...........');
    const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP')]);
    const isoBmff = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftyp'), Buffer.from('isom')]);
    const ebml = Buffer.from([0x1A, 0x45, 0xDF, 0xA3, 0, 0]);
    const heic = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftyp'), Buffer.from('heic')]);

    assert.equal(looksLikeJpeg(jpeg), true);
    assert.equal(looksLikePng(png), true);
    assert.equal(looksLikeGif(gif87), true);
    assert.equal(looksLikeGif(gif89), true);
    assert.equal(looksLikeWebp(webp), true);
    assert.equal(looksLikeIsoBmffContainer(isoBmff), true);
    assert.equal(looksLikeEbml(ebml), true);
    assert.equal(looksLikeHeicBuffer(heic), true);
    assert.equal(looksLikeHeicBuffer(isoBmff), false); // brand "isom" khong nam trong HEIC_BRANDS
});

test('STEP 3.2 §17/§18/§34 - magic byte detection: TU CHOI file gia mao (Content-Type khong khop noi dung that)', () => {
    const jpeg = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0, 0, 0, 0]);
    const png = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0]);
    const notAnImage = Buffer.from('<script>alert(1)</script>');
    const evilExe = Buffer.from([0x4D, 0x5A, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]); // "MZ" - Windows PE header
    const emptyBuf = Buffer.alloc(0);
    const truncated = Buffer.from([0xFF, 0xD8]); // JPEG bi cat cut, thieu byte thu 3

    const checks = [looksLikeJpeg, looksLikePng, looksLikeGif, looksLikeWebp, looksLikeIsoBmffContainer, looksLikeEbml, looksLikeHeicBuffer];
    for (const fn of checks) {
        assert.equal(fn(notAnImage), false, `${fn.name} phai tu choi noi dung la HTML/JS`);
        assert.equal(fn(evilExe), false, `${fn.name} phai tu choi file .exe gia mao`);
        assert.equal(fn(emptyBuf), false, `${fn.name} phai tu choi buffer rong`);
        assert.equal(fn(null), false, `${fn.name} phai tu choi null (khong throw)`);
        assert.equal(fn(undefined), false, `${fn.name} phai tu choi undefined (khong throw)`);
    }
    assert.equal(looksLikeJpeg(truncated), false, 'JPEG bi cat cut (thieu byte thu 3) phai bi tu choi');
    // Cross-check: PNG that khong duoc nhan dien nham la JPEG va nguoc lai.
    assert.equal(looksLikeJpeg(png), false);
    assert.equal(looksLikePng(jpeg), false);
});

test('STEP 3.2 §13 - rejectDangerousKeys: chan __proto__/constructor/prototype trong body, cho qua body binh thuong', () => {
    function callMiddleware(body) {
        let statusCode = null, jsonBody = null, nextCalled = false;
        const req = { body };
        const res = {
            status(code) { statusCode = code; return this; },
            json(payload) { jsonBody = payload; return this; },
        };
        rejectDangerousKeys(req, res, () => { nextCalled = true; });
        return { statusCode, jsonBody, nextCalled };
    }

    const dangerous = [
        JSON.parse('{"text":"hi","__proto__":{"polluted":true}}'),
        JSON.parse('{"constructor":{"polluted":true}}'),
        JSON.parse('{"prototype":{"polluted":true}}'),
    ];
    for (const body of dangerous) {
        const result = callMiddleware(body);
        assert.equal(result.statusCode, 400);
        assert.equal(result.nextCalled, false);
    }

    const safe = callMiddleware({ text: 'hello', replyToId: 5 });
    assert.equal(safe.nextCalled, true);
    assert.equal(safe.statusCode, null);

    // Body la array hoac khong phai object (vd tu express.json() voi payload
    // top-level la array/string/number) khong duoc lam middleware crash.
    for (const body of [[], ['__proto__'], 'string body', 123, null, undefined]) {
        const result = callMiddleware(body);
        assert.equal(result.nextCalled, true, `body=${JSON.stringify(body)} phai duoc next() binh thuong, khong crash`);
    }
});
