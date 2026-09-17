// test/attachment-state.test.js
//
// HEIC upload workflow redesign - attachment state machine.
//
// UNIT TEST THUAN TUY cho public/attachment-state.js - KHONG can trinh
// duyet/jsdom/bundler, KHONG can Postgres/npm install (module nay khong
// require gi khac ngoai Node builtin) - chay duoc ngay ca truoc "npm install".
//
// Chay: node --test test/attachment-state.test.js  (hoac: npm test)

const test = require('node:test');
const assert = require('node:assert/strict');

const AttachmentState = require('../public/attachment-state.js');
const { PHASES } = AttachmentState;

test('AttachmentState: createAttachmentState() tra ve trang thai IDLE ban dau dung dinh dang', () => {
    const s = AttachmentState.createAttachmentState();
    assert.equal(s.phase, PHASES.IDLE);
    assert.equal(s.id, null);
    assert.equal(s.file, null);
    assert.equal(s.previewUrl, null);
    assert.equal(s.hasSharpPreview, false);
    assert.equal(s.progress, null);
    assert.equal(s.error, null);
    assert.deepEqual(s.meta, { name: '', sizeBytes: 0 });
});

test('AttachmentState: generateAttachmentId() luon tra ve gia tri duy nhat, dang chuoi khong rong', () => {
    const ids = new Set();
    for (let i = 0; i < 1000; i++) ids.add(AttachmentState.generateAttachmentId());
    assert.equal(ids.size, 1000, 'khong duoc co id trung lap trong 1000 lan sinh lien tiep');
    for (const id of ids) {
        assert.equal(typeof id, 'string');
        assert.ok(id.length > 0);
    }
});

// ---------------------------------------------------------------------
// isValidTransition - dung DUNG cac luong duoc mo ta trong task (JPG, HEIC
// thanh cong, HEIC that bai/fallback server, huy o moi giai doan, retry).
// ---------------------------------------------------------------------

test('isValidTransition: luong JPG (khong can convert) - ATTACHED -> READY_TO_UPLOAD -> UPLOADING -> COMPLETED', () => {
    assert.equal(AttachmentState.isValidTransition(PHASES.IDLE, PHASES.ATTACHED), true);
    assert.equal(AttachmentState.isValidTransition(PHASES.ATTACHED, PHASES.READY_TO_UPLOAD), true);
    assert.equal(AttachmentState.isValidTransition(PHASES.READY_TO_UPLOAD, PHASES.UPLOADING), true);
    assert.equal(AttachmentState.isValidTransition(PHASES.UPLOADING, PHASES.COMPLETED), true);
    assert.equal(AttachmentState.isValidTransition(PHASES.COMPLETED, PHASES.IDLE), true);
});

test('isValidTransition: luong HEIC convert client THANH CONG - ATTACHED -> CONVERTING -> READY_TO_UPLOAD -> UPLOADING -> COMPLETED', () => {
    assert.equal(AttachmentState.isValidTransition(PHASES.ATTACHED, PHASES.CONVERTING), true);
    assert.equal(AttachmentState.isValidTransition(PHASES.CONVERTING, PHASES.READY_TO_UPLOAD), true);
    assert.equal(AttachmentState.isValidTransition(PHASES.READY_TO_UPLOAD, PHASES.UPLOADING), true);
    assert.equal(AttachmentState.isValidTransition(PHASES.UPLOADING, PHASES.COMPLETED), true);
});

test('isValidTransition: luong HEIC convert client THAT BAI (CSP/timeout/unavailable) van phai toi duoc READY_TO_UPLOAD (fallback HEIC goc len server)', () => {
    // Yeu cau cot loi cua task: "client conversion failure must NOT leave
    // selectedFile/state.selectedFile null indefinitely" - CONVERTING PHAI co
    // duong di toi READY_TO_UPLOAD (fallback) ke ca khi that bai, KHONG chi co
    // duong di toi FAILED.
    assert.equal(AttachmentState.isValidTransition(PHASES.CONVERTING, PHASES.READY_TO_UPLOAD), true, 'CONVERTING that bai van phai fallback duoc sang READY_TO_UPLOAD (gui HEIC goc)');
});

test('isValidTransition: huy (CANCELLED) hop le tu MOI giai doan dang xu ly (ATTACHED/CONVERTING/READY_TO_UPLOAD/UPLOADING)', () => {
    assert.equal(AttachmentState.isValidTransition(PHASES.ATTACHED, PHASES.CANCELLED), true);
    assert.equal(AttachmentState.isValidTransition(PHASES.CONVERTING, PHASES.CANCELLED), true);
    assert.equal(AttachmentState.isValidTransition(PHASES.READY_TO_UPLOAD, PHASES.CANCELLED), true);
    assert.equal(AttachmentState.isValidTransition(PHASES.UPLOADING, PHASES.CANCELLED), true);
    assert.equal(AttachmentState.isValidTransition(PHASES.CANCELLED, PHASES.IDLE), true);
});

test('isValidTransition: that bai (FAILED) cho phep retry (quay ve ATTACHED/CONVERTING/READY_TO_UPLOAD) hoac ve IDLE/CANCELLED', () => {
    assert.equal(AttachmentState.isValidTransition(PHASES.FAILED, PHASES.ATTACHED), true);
    assert.equal(AttachmentState.isValidTransition(PHASES.FAILED, PHASES.IDLE), true);
    assert.equal(AttachmentState.isValidTransition(PHASES.FAILED, PHASES.CANCELLED), true);
});

test('isValidTransition: TU CHOI cac buoc nhay khong hop le (bo qua giai doan, di nguoc)', () => {
    assert.equal(AttachmentState.isValidTransition(PHASES.IDLE, PHASES.UPLOADING), false, 'khong duoc nhay thang tu IDLE toi UPLOADING');
    assert.equal(AttachmentState.isValidTransition(PHASES.IDLE, PHASES.COMPLETED), false);
    assert.equal(AttachmentState.isValidTransition(PHASES.UPLOADING, PHASES.ATTACHED), false, 'khong duoc lui tu UPLOADING ve ATTACHED');
    assert.equal(AttachmentState.isValidTransition(PHASES.COMPLETED, PHASES.UPLOADING), false, 'da COMPLETED khong the quay lai UPLOADING');
    assert.equal(AttachmentState.isValidTransition(PHASES.CANCELLED, PHASES.UPLOADING), false);
    assert.equal(AttachmentState.isValidTransition('KHONG_TON_TAI', PHASES.IDLE), false, 'phase khong ton tai phai tra ve false, khong throw');
});

// ---------------------------------------------------------------------
// transition() - ap dung thuc te, throw ro rang khi sai, khong mutate input
// ---------------------------------------------------------------------

test('transition(): ap dung dung chuyen doi hop le, tra ve OBJECT MOI (khong mutate input)', () => {
    const s0 = AttachmentState.createAttachmentState();
    const s1 = AttachmentState.transition(s0, PHASES.ATTACHED, { id: 'a1', file: { name: 'x.jpg' }, kind: 'image' });
    assert.equal(s0.phase, PHASES.IDLE, 'state goc KHONG duoc bi mutate');
    assert.equal(s1.phase, PHASES.ATTACHED);
    assert.equal(s1.id, 'a1');
    assert.equal(s1.file.name, 'x.jpg');
});

test('transition(): throw loi ro rang khi chuyen doi KHONG hop le (khong am tham chap nhan)', () => {
    const s0 = AttachmentState.createAttachmentState(); // IDLE
    assert.throws(() => AttachmentState.transition(s0, PHASES.UPLOADING), /Invalid attachment transition/);
    assert.throws(() => AttachmentState.transition(null, PHASES.ATTACHED));
});

test('updateAttachment(): cap nhat truong (vd progress) trong CUNG 1 phase, KHONG mutate input, KHONG doi phase', () => {
    let s = AttachmentState.createAttachmentState();
    s = AttachmentState.transition(s, PHASES.ATTACHED, { id: 'p1' });
    s = AttachmentState.transition(s, PHASES.READY_TO_UPLOAD);
    s = AttachmentState.transition(s, PHASES.UPLOADING, { progress: 0 });
    const before = s;
    s = AttachmentState.updateAttachment(s, { progress: 42 });
    assert.equal(before.progress, 0, 'object truoc do khong bi mutate');
    assert.equal(s.progress, 42);
    assert.equal(s.phase, PHASES.UPLOADING, 'updateAttachment() khong duoc lam doi phase');
});

test('updateAttachment(): tu choi neu patch co chua "phase" (phai dung transition() cho viec do)', () => {
    const s = AttachmentState.createAttachmentState();
    assert.throws(() => AttachmentState.updateAttachment(s, { phase: PHASES.ATTACHED }), /khong duoc dung de doi "phase"/);
});

test('transition(): mo phong DAY DU 1 luong HEIC that bai roi fallback thanh cong len den COMPLETED', () => {
    let s = AttachmentState.createAttachmentState();
    s = AttachmentState.transition(s, PHASES.ATTACHED, { id: 'x1', kind: 'heic', meta: { name: 'photo.heic', sizeBytes: 2000000 } });
    s = AttachmentState.transition(s, PHASES.CONVERTING);
    // heic2any that bai/timeout -> fallback: van chuyen sang READY_TO_UPLOAD
    // nhung dung file HEIC GOC (khong phai JPEG da convert).
    s = AttachmentState.transition(s, PHASES.READY_TO_UPLOAD, { file: { name: 'photo.heic' }, error: null });
    assert.equal(s.file.name, 'photo.heic', 'fallback phai giu file HEIC GOC de gui len server');
    s = AttachmentState.transition(s, PHASES.UPLOADING, { progress: 0 });
    s = AttachmentState.updateAttachment(s, { progress: 55 }); // cap nhat progress giua chung, KHONG doi phase
    s = AttachmentState.transition(s, PHASES.COMPLETED, { progress: 100 });
    assert.equal(s.phase, PHASES.COMPLETED);
});

// ---------------------------------------------------------------------
// isSendBlockedByAttachment - nut "Gui" chi bi khoa dung luc CONVERTING/UPLOADING
// ---------------------------------------------------------------------

test('isSendBlockedByAttachment: CHI khoa Send trong luc CONVERTING hoac UPLOADING', () => {
    assert.equal(AttachmentState.isSendBlockedByAttachment(PHASES.CONVERTING), true);
    assert.equal(AttachmentState.isSendBlockedByAttachment(PHASES.UPLOADING), true);
});

test('isSendBlockedByAttachment: KHONG khoa Send o cac giai doan khac (IDLE/ATTACHED/READY_TO_UPLOAD/COMPLETED/FAILED/CANCELLED)', () => {
    assert.equal(AttachmentState.isSendBlockedByAttachment(PHASES.IDLE), false);
    assert.equal(AttachmentState.isSendBlockedByAttachment(PHASES.ATTACHED), false);
    assert.equal(AttachmentState.isSendBlockedByAttachment(PHASES.READY_TO_UPLOAD), false);
    assert.equal(AttachmentState.isSendBlockedByAttachment(PHASES.COMPLETED), false);
    assert.equal(AttachmentState.isSendBlockedByAttachment(PHASES.FAILED), false);
    assert.equal(AttachmentState.isSendBlockedByAttachment(PHASES.CANCELLED), false);
});

// ---------------------------------------------------------------------
// isStaleAttachmentResult - chong "async cu ghi de attachment moi" (task §15)
// ---------------------------------------------------------------------

test('isStaleAttachmentResult: ket qua cua CHINH attachment dang hoat dong -> KHONG stale', () => {
    assert.equal(AttachmentState.isStaleAttachmentResult('att-1', 'att-1'), false);
});

test('isStaleAttachmentResult: ket qua cua 1 attachment CU (da bi thay the) -> LA stale, phai bo qua', () => {
    // Kich ban trong task: attach A -> bat dau convert -> nguoi dung xoa A,
    // attach B -> convert cua A xong SAU do. Ket qua cua A (attachmentId="A")
    // khong con khop voi attachment dang hoat dong ("B") -> phai bi loai bo.
    assert.equal(AttachmentState.isStaleAttachmentResult('att-B', 'att-A'), true);
});

test('isStaleAttachmentResult: attachment hien tai la null (da bi xoa/reset ve IDLE) -> moi ket qua cu deu la stale', () => {
    assert.equal(AttachmentState.isStaleAttachmentResult(null, 'att-A'), true);
});
