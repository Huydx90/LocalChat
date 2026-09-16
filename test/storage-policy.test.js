// test/storage-policy.test.js
//
// STEP 2.1 §17/§19: kiem tra logic phan loai trang thai luu tru bang cac ty le
// GIA LAP (0%..100%) - KHONG dung PostgreSQL that, KHONG dung production DB.
// Chay: npm test  (hoac: node --test test/storage-policy.test.js)

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyUsage, validateThresholds, formatDiagnostic, parseConfigNumber } = require('../storage-policy');

// Nguong mac dinh cua project (giong .env.example / default trong server.js)
const THRESHOLDS = {
    target: 0.75,
    warning: 0.80,
    emergency: 0.90,
    hardBlockMedia: 0.95,
    hardBlockText: 0.99,
};

// ---- STEP 2.1 §17: ma tran bat buoc Case A -> J ----
const CASES = [
    { name: 'A: 0%', ratio: 0.00, expect: { normal: true, warning: false, emergencyCleanup: false, mediaBlocked: false, textBlocked: false } },
    { name: 'B: 79%', ratio: 0.79, expect: { normal: true, warning: false, emergencyCleanup: false, mediaBlocked: false, textBlocked: false } },
    { name: 'C: 80%', ratio: 0.80, expect: { normal: false, warning: true, emergencyCleanup: false, mediaBlocked: false, textBlocked: false } },
    { name: 'D: 89%', ratio: 0.89, expect: { normal: false, warning: true, emergencyCleanup: false, mediaBlocked: false, textBlocked: false } },
    { name: 'E: 90%', ratio: 0.90, expect: { normal: false, warning: false, emergencyCleanup: true, mediaBlocked: false, textBlocked: false } },
    { name: 'F: 94%', ratio: 0.94, expect: { normal: false, warning: false, emergencyCleanup: true, mediaBlocked: false, textBlocked: false } },
    { name: 'G: 95%', ratio: 0.95, expect: { normal: false, warning: false, emergencyCleanup: true, mediaBlocked: true, textBlocked: false } },
    { name: 'H: 98%', ratio: 0.98, expect: { normal: false, warning: false, emergencyCleanup: true, mediaBlocked: true, textBlocked: false } },
    { name: 'I: 99%', ratio: 0.99, expect: { normal: false, warning: false, emergencyCleanup: true, mediaBlocked: true, textBlocked: true } },
    { name: 'J: 100%', ratio: 1.00, expect: { normal: false, warning: false, emergencyCleanup: true, mediaBlocked: true, textBlocked: true } },
];

for (const c of CASES) {
    test(`storage state Case ${c.name} -> media allowed=${!c.expect.mediaBlocked}, text allowed=${!c.expect.textBlocked}`, () => {
        const state = classifyUsage(c.ratio, THRESHOLDS);
        assert.equal(state.normal, c.expect.normal, `normal sai cho ${c.name}`);
        assert.equal(state.warning, c.expect.warning, `warning sai cho ${c.name}`);
        assert.equal(state.emergencyCleanup, c.expect.emergencyCleanup, `emergencyCleanup sai cho ${c.name}`);
        assert.equal(state.mediaBlocked, c.expect.mediaBlocked, `mediaBlocked sai cho ${c.name}`);
        assert.equal(state.textBlocked, c.expect.textBlocked, `textBlocked sai cho ${c.name}`);
    });
}

test('96% (giua G/H): emergency cleanup active + media blocked + text VAN duoc phep (spec §8 vi du)', () => {
    const state = classifyUsage(0.96, THRESHOLDS);
    assert.equal(state.emergencyCleanup, true);
    assert.equal(state.mediaBlocked, true);
    assert.equal(state.textBlocked, false);
});

test('exactly at a threshold boundary is inclusive (>=)', () => {
    assert.equal(classifyUsage(0.80, THRESHOLDS).warning, true);
    assert.equal(classifyUsage(0.7999999, THRESHOLDS).warning, false);
    assert.equal(classifyUsage(0.90, THRESHOLDS).emergencyCleanup, true);
    assert.equal(classifyUsage(0.95, THRESHOLDS).mediaBlocked, true);
    assert.equal(classifyUsage(0.99, THRESHOLDS).textBlocked, true);
});

// ---- validateThresholds (STEP 2.1 §22) ----
test('validateThresholds: default project config is valid', () => {
    const res = validateThresholds(THRESHOLDS);
    assert.equal(res.valid, true, res.errors.join('; '));
});

test('validateThresholds: rejects emergency <= warning', () => {
    const res = validateThresholds({ ...THRESHOLDS, warning: 0.95 }); // warning > emergency (0.90) -> invalid
    assert.equal(res.valid, false);
    assert.ok(res.errors.some(e => e.includes('DB_WARNING_RATIO')));
});

test('validateThresholds: rejects mediaHardBlock < emergency', () => {
    const res = validateThresholds({ ...THRESHOLDS, hardBlockMedia: 0.85 }); // < emergency 0.90 -> invalid
    assert.equal(res.valid, false);
    assert.ok(res.errors.some(e => e.includes('DB_EMERGENCY_RATIO')));
});

test('validateThresholds: rejects textHardBlock < mediaHardBlock', () => {
    const res = validateThresholds({ ...THRESHOLDS, hardBlockText: 0.90 }); // < media 0.95 -> invalid
    assert.equal(res.valid, false);
    assert.ok(res.errors.some(e => e.includes('DB_HARD_BLOCK_MEDIA_RATIO')));
});

test('validateThresholds: rejects out-of-range values (<=0, >1, NaN)', () => {
    assert.equal(validateThresholds({ ...THRESHOLDS, target: 0 }).valid, false);
    assert.equal(validateThresholds({ ...THRESHOLDS, emergency: 1.5 }).valid, false);
    assert.equal(validateThresholds({ ...THRESHOLDS, warning: NaN }).valid, false);
});

// ---- formatDiagnostic (STEP 2.1 §21) ----
test('formatDiagnostic matches required format/units', () => {
    const line = formatDiagnostic('[STORAGE]', 700, 1024, 0.68);
    assert.match(line, /^\[STORAGE\] PostgreSQL database usage: \d+ bytes \(\d+\.\d{2} MB \/ \d+\.\d{2} GB\), limit=\d+\.\d{2} GB, ratio=\d+\.\d{2}%$/);
});

// ---- parseConfigNumber (STEP 2.2: sua loi `parseFloat(x) || default` nuot mat 0/NaN) ----
// Day chinh la cac truong hop cu the ma mot review doc lap yeu cau phai
// chung minh KHONG con am tham fallback sang default.
test('parseConfigNumber: blank/undefined -> blank (dùng default là lựa chọn hợp lệ)', () => {
    assert.equal(parseConfigNumber(undefined).blank, true);
    assert.equal(parseConfigNumber(null).blank, true);
    assert.equal(parseConfigNumber('').blank, true);
    assert.equal(parseConfigNumber('   ').blank, true);
});

test('parseConfigNumber: "0" phải được nhận là 0 hợp lệ, KHÔNG bị nuốt thành default', () => {
    const res = parseConfigNumber('0');
    assert.equal(res.blank, false);
    assert.equal(res.valid, true);
    assert.equal(res.value, 0); // truoc STEP 2.2: `parseFloat("0") || 0.80` = 0.80 (SAI) - gio phai la 0
});

test('parseConfigNumber: "abc" (không phải số) phải invalid, KHÔNG được âm thầm dùng default', () => {
    const res = parseConfigNumber('abc');
    assert.equal(res.blank, false);
    assert.equal(res.valid, false);
    assert.ok(res.error);
});

test('parseConfigNumber: "-1" là số âm hợp lệ về mặt PARSE (range/positivity do lớp gọi phía sau tự quyết định)', () => {
    const res = parseConfigNumber('-1');
    assert.equal(res.valid, true);
    assert.equal(res.value, -1);
});

test('parseConfigNumber: chuỗi số + rác ("10abc") phải invalid (Number, không phải parseFloat)', () => {
    // parseFloat("10abc") = 10 (SAI, bo qua phan rac) - Number("10abc") = NaN (dung, tu choi toan bo)
    const res = parseConfigNumber('10abc');
    assert.equal(res.valid, false);
});

test('parseConfigNumber: số thập phân hợp lệ ("0.82") được nhận đúng', () => {
    const res = parseConfigNumber('0.82');
    assert.equal(res.valid, true);
    assert.equal(res.value, 0.82);
});

// ---- Đầu-cuối: DB_WARNING_RATIO=0 và DB_STORAGE_LIMIT_MB=abc phải bị validateThresholds/positivity-check bắt được ----
test('end-to-end: DB_WARNING_RATIO="0" (parse -> classify) phải bị validateThresholds từ chối', () => {
    const parsed = parseConfigNumber('0');
    assert.equal(parsed.valid, true); // parse thanh cong (0 la so hop le)
    const thresholds = { target: 0.75, warning: parsed.value, emergency: 0.90, hardBlockMedia: 0.95, hardBlockText: 0.99 };
    const check = validateThresholds(thresholds);
    assert.equal(check.valid, false, 'DB_WARNING_RATIO=0 phải bị validateThresholds bắt lỗi (0 nằm ngoài (0,1])');
});

test('end-to-end: DB_EMERGENCY_RATIO="-1" phải bị validateThresholds từ chối', () => {
    const parsed = parseConfigNumber('-1');
    assert.equal(parsed.valid, true);
    const thresholds = { target: 0.75, warning: 0.80, emergency: parsed.value, hardBlockMedia: 0.95, hardBlockText: 0.99 };
    const check = validateThresholds(thresholds);
    assert.equal(check.valid, false, 'DB_EMERGENCY_RATIO=-1 phải bị validateThresholds bắt lỗi');
});
