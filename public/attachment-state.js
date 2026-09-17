/* attachment-state.js
 *
 * State machine THUAN TUY cho luong xu ly 1 file dinh kem (anh/video/HEIC)
 * truoc khi gui - tach rieng khoi app.js de co the unit-test bang Node
 * (`node --test test/attachment-state.test.js`) MA KHONG CAN trinh duyet/
 * jsdom/bundler nao ca (dung y "Do not make tests dependent on an actual
 * browser unless the project already has browser test infrastructure").
 *
 * Module nay duoc load theo CA 2 CACH, tu dong nhan dien moi truong o cuoi
 * file (khong can bundler):
 *   - Trong trinh duyet: <script src="/attachment-state.js"> truoc app.js ->
 *     gan vao "window.AttachmentState".
 *   - Trong Node (test): require('../public/attachment-state.js') -> tra ve
 *     qua "module.exports".
 *
 * KHONG chua bat ky thao tac DOM/network/Blob/File nao - chi la data + logic
 * chuyen trang thai THUAN TUY, de co the test 100% deterministic.
 */
(function (root) {
    'use strict';

    // Cac giai doan hop le cua 1 attachment (xem yeu cau task "REQUIRED
    // UPLOAD STATE MACHINE").
    var PHASES = Object.freeze({
        IDLE: 'IDLE',
        ATTACHED: 'ATTACHED',
        CONVERTING: 'CONVERTING',
        READY_TO_UPLOAD: 'READY_TO_UPLOAD',
        UPLOADING: 'UPLOADING',
        COMPLETED: 'COMPLETED',
        FAILED: 'FAILED',
        CANCELLED: 'CANCELLED',
    });

    // Ban do CHUYEN TRANG THAI hop le: key = tu giai doan nao, value = tap
    // hop cac giai doan DUOC PHEP di toi tiep theo. Bat ky chuyen doi nao
    // KHONG co trong danh sach nay deu bi tu choi boi isValidTransition().
    var TRANSITIONS = {
        IDLE: [PHASES.ATTACHED],
        ATTACHED: [PHASES.CONVERTING, PHASES.READY_TO_UPLOAD, PHASES.CANCELLED, PHASES.FAILED],
        CONVERTING: [PHASES.READY_TO_UPLOAD, PHASES.FAILED, PHASES.CANCELLED],
        READY_TO_UPLOAD: [PHASES.UPLOADING, PHASES.CANCELLED, PHASES.FAILED],
        UPLOADING: [PHASES.COMPLETED, PHASES.FAILED, PHASES.CANCELLED],
        COMPLETED: [PHASES.IDLE], // don dep xong -> san sang cho attachment moi
        FAILED: [PHASES.IDLE, PHASES.ATTACHED, PHASES.CONVERTING, PHASES.READY_TO_UPLOAD, PHASES.CANCELLED], // cho phep retry
        CANCELLED: [PHASES.IDLE],
    };

    function isValidTransition(from, to) {
        var allowed = TRANSITIONS[from];
        if (!allowed) return false;
        return allowed.indexOf(to) !== -1;
    }

    // Cac giai doan ma nut "Gui" PHAI bi vo hieu hoa (dang xu ly/dang tai len -
    // yeu cau task §9: "While attachment is CONVERTING/UPLOADING: disable the
    // Send button"). COMPLETED/CANCELLED/IDLE/FAILED/ATTACHED/READY_TO_UPLOAD
    // deu KHONG chan Send (ATTACHED/READY_TO_UPLOAD la trang thai "san sang",
    // FAILED cho phep nguoi dung thu lai hoac go bo dinh kem roi gui text binh
    // thuong).
    var SEND_BLOCKING_PHASES = [PHASES.CONVERTING, PHASES.UPLOADING];
    function isSendBlockedByAttachment(phase) {
        return SEND_BLOCKING_PHASES.indexOf(phase) !== -1;
    }

    // Sinh 1 id duy nhat cho MOI lan attach file moi - dung de phat hien va
    // loai bo ket qua "cu" tu 1 thao tac bat dong bo (convert/upload) cua 1
    // attachment DA BI THAY THE/HUY boi attachment moi hon (yeu cau task §15:
    // "Old async operation cannot overwrite a newer attachment").
    function generateAttachmentId() {
        var cryptoObj = (typeof root !== 'undefined' && root.crypto) ||
            (typeof globalThis !== 'undefined' && globalThis.crypto) || null;
        if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
            return cryptoObj.randomUUID();
        }
        // Fallback (moi truong khong co crypto.randomUUID - vd trinh duyet rat
        // cu hoac ngu canh khong secure) - van duy nhat trong pham vi 1 phien.
        return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
    }

    // Trang thai KHOI TAO cho 1 attachment moi (chua gan file nao - IDLE).
    // "meta" chua thong tin hien thi (ten file, kich thuoc, loai) va "progress"
    // (0-100, chi co y nghia trong giai doan UPLOADING - null cac giai doan khac).
    function createAttachmentState() {
        return {
            id: null,
            phase: PHASES.IDLE,
            file: null,          // File/Blob SE duoc upload (sau khi convert/nen xong)
            previewUrl: null,    // object URL cho local preview (null neu dung placeholder)
            hasSharpPreview: false, // true neu previewUrl la anh THAT SU decode duoc (khong phai placeholder)
            kind: null,          // 'image' | 'video' | 'heic'
            progress: null,      // 0-100 khi UPLOADING, null cac giai doan khac
            error: null,         // message loi hien thi cho nguoi dung (khi FAILED)
            meta: { name: '', sizeBytes: 0 },
        };
    }

    // Ap dung 1 chuyen doi giai doan MOI vao 1 attachment state hien co, TRA VE
    // OBJECT MOI (khong mutate object cu - de de doi chieu/test va tranh side-
    // effect ngoai y muon o noi goi). Neu chuyen doi KHONG hop le, throw loi ro
    // rang thay vi am tham chap nhan trang thai sai (giup phat hien bug logic
    // som trong qua trinh phat trien/test, thay vi de UI roi vao trang thai
    // khong nhat quan luc chay that).
    function transition(attachmentState, toPhase, patch) {
        if (!attachmentState) throw new Error('attachmentState is required');
        if (!isValidTransition(attachmentState.phase, toPhase)) {
            throw new Error('Invalid attachment transition: ' + attachmentState.phase + ' -> ' + toPhase);
        }
        var next = Object.assign({}, attachmentState, { phase: toPhase }, patch || {});
        return next;
    }

    // Cap nhat cac truong KHONG lien quan phase (vd "progress" tang dan trong
    // luc UPLOADING) MA KHONG doi phase va KHONG di qua validate cua
    // transition() - dung cho cac lan cap nhat lien tuc trong CUNG 1 giai doan
    // (vd moi lan "xhr.upload.onprogress" ban ra). "patch" KHONG duoc phep
    // chua truong "phase" (dung transition() cho viec do).
    function updateAttachment(attachmentState, patch) {
        if (!attachmentState) throw new Error('attachmentState is required');
        if (patch && Object.prototype.hasOwnProperty.call(patch, 'phase')) {
            throw new Error('updateAttachment() khong duoc dung de doi "phase" - dung transition() thay vao do');
        }
        return Object.assign({}, attachmentState, patch || {});
    }

    // True neu "resultAttachmentId" KHONG con khop voi attachment DANG HOAT
    // DONG ("currentAttachmentId") - dung de 1 callback bat dong bo (convert
    // xong / upload progress / upload xong) tu kiem tra TRUOC KHI cap nhat DOM/
    // state, tranh 1 thao tac CU ghi de len 1 attachment MOI hon (task §15).
    function isStaleAttachmentResult(currentAttachmentId, resultAttachmentId) {
        return currentAttachmentId !== resultAttachmentId;
    }

    var AttachmentState = {
        PHASES: PHASES,
        isValidTransition: isValidTransition,
        isSendBlockedByAttachment: isSendBlockedByAttachment,
        generateAttachmentId: generateAttachmentId,
        createAttachmentState: createAttachmentState,
        transition: transition,
        updateAttachment: updateAttachment,
        isStaleAttachmentResult: isStaleAttachmentResult,
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = AttachmentState;
    } else {
        root.AttachmentState = AttachmentState;
    }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
