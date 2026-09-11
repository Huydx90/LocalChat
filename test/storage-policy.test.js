// test/storage-policy.test.js
//
// STEP 2.1 §17/§19: kiem tra logic phan loai trang thai luu tru bang cac ty le
// GIA LAP (0%..100%) - KHONG dung PostgreSQL that, KHONG dung production DB.
// Chay: npm test  (hoac: node --test test/storage-policy.test.js)

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyUsage, validateThresholds, formatDiagnostic, parseEnvNumber } = require('../storage-policy');

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

// ---- STEP 2.2 (audit finding): parseEnvNumber phai phan biet "chua cau hinh"
// voi "co cau hinh nhung sai", thay vi am tham nuot 0/NaN thanh default nhu
// pattern cu `parseFloat(x) || default`.
test('parseEnvNumber: unset (undefined) -> dung default', () => {
    assert.equal(parseEnvNumber('DB_WARNING_RATIO', undefined, 0.80), 0.80);
});

test('parseEnvNumber: blank string / chi co khoang trang -> dung default', () => {
    assert.equal(parseEnvNumber('DB_WARNING_RATIO', '', 0.80), 0.80);
    assert.equal(parseEnvNumber('DB_WARNING_RATIO', '   ', 0.80), 0.80);
});

test('parseEnvNumber: "0" la gia tri HOP LE va phai duoc GIU NGUYEN, khong bi nuot thanh default', () => {
    // Day chinh la bug STEP 2.1: parseFloat("0") || 0.80 -> 0.80 (SAI).
    assert.equal(parseEnvNumber('DB_WARNING_RATIO', '0', 0.80), 0);
    assert.equal(parseEnvNumber('DB_EMERGENCY_RATIO', '0', 0.90), 0);
});

test('parseEnvNumber: chuoi khong phai so ("abc") -> throw, KHONG am tham fallback ve default', () => {
    assert.throws(() => parseEnvNumber('DB_WARNING_RATIO', 'abc', 0.80), /DB_WARNING_RATIO/);
    assert.throws(() => parseEnvNumber('MAX_CLEANUP_ITERATIONS', 'abc', 50, { integer: true, min: 1 }));
});

test('parseEnvNumber: so am -> throw khi co rang buoc min', () => {
    assert.throws(() => parseEnvNumber('DB_EMERGENCY_RATIO', '-1', 0.90, { min: 0 }), /DB_EMERGENCY_RATIO/);
});

test('parseEnvNumber: DB_STORAGE_LIMIT_MB="abc" -> throw (truoc day bi hieu nham la "chua cau hinh" va tat tinh nang am tham)', () => {
    assert.throws(() => parseEnvNumber('DB_STORAGE_LIMIT_MB', 'abc', null, { integer: true, min: 1 }), /DB_STORAGE_LIMIT_MB/);
});

test('parseEnvNumber: DB_STORAGE_LIMIT_MB="0" -> throw (0 MB khong hop le, khac voi "chua cau hinh")', () => {
    assert.throws(() => parseEnvNumber('DB_STORAGE_LIMIT_MB', '0', null, { integer: true, min: 1 }), /DB_STORAGE_LIMIT_MB/);
});

test('parseEnvNumber: DB_STORAGE_LIMIT_MB khong set -> null (tinh nang tat, day la truong hop HOP LE duy nhat cho null)', () => {
    assert.equal(parseEnvNumber('DB_STORAGE_LIMIT_MB', undefined, null, { integer: true, min: 1 }), null);
});

test('parseEnvNumber: gia tri hop le duoc giu nguyen chinh xac (khong lam tron/bien dang)', () => {
    assert.equal(parseEnvNumber('DB_WARNING_RATIO', '0.72', 0.80), 0.72);
    assert.equal(parseEnvNumber('DB_STORAGE_LIMIT_MB', '2048', null, { integer: true, min: 1 }), 2048);
});

test('parseEnvNumber: integer:true tu choi so thap phan (vd MAX_CLEANUP_ITERATIONS=1.5)', () => {
    assert.throws(() => parseEnvNumber('MAX_CLEANUP_ITERATIONS', '1.5', 50, { integer: true, min: 1 }), /MAX_CLEANUP_ITERATIONS/);
});

test('parseEnvNumber: "12abc" bi tu choi (Number() khac parseInt() - parseInt am tham cat "abc")', () => {
    // parseInt("12abc", 10) === 12 (SAI, am tham cat phan rac). Number("12abc") === NaN (DUNG).
    assert.throws(() => parseEnvNumber('MAX_CLEANUP_ITERATIONS', '12abc', 50, { integer: true, min: 1 }));
});
