// ===================================================================
// storage-policy.js
//
// STEP 2.1 §19 (testability): logic THUAN TUY quyet dinh trang thai luu tru
// dua tren 1 ty le (ratio) DA DO SAN va cac nguong cau hinh - KHONG ket noi
// PostgreSQL, KHONG doc process.env truc tiep o day, KHONG co side effect nao.
//
// Tach rieng khoi server.js vi server.js lam hang loat viec fail-fast (doc
// DATABASE_URL/JWT_SECRET/MESSAGE_ENCRYPTION_KEY va process.exit(1) ngay khi
// file duoc load) - khong the require('../server.js') an toan trong unit
// test ma khong co that DATABASE_URL/JWT_SECRET/MESSAGE_ENCRYPTION_KEY. File
// nay khong co van de do, nen test/storage-policy.test.js co the require()
// truc tiep va chay toan bo ma tran Case A-J (xem STEP 2.1 §17) ma KHONG can
// Postgres that, KHONG can bien moi truong nao, va KHONG dung production DB.
// ===================================================================

// Kiem tra quan he logic giua cac nguong (STEP 2.1 §22). Tra ve danh sach loi
// (rong = hop le). Khong nem exception o day - de server.js tu quyet dinh
// fail-fast (process.exit) hay khong, giu file nay thuan tuy/de test.
function validateThresholds(t) {
    const errors = [];
    const checkRange = (value, name) => {
        if (typeof value !== 'number' || Number.isNaN(value) || !(value > 0 && value <= 1)) {
            errors.push(`${name} phải là số trong khoảng (0, 1], nhận được: ${value}`);
            return false;
        }
        return true;
    };
    const okTarget = checkRange(t.target, 'DB_TARGET_RATIO');
    const okWarning = checkRange(t.warning, 'DB_WARNING_RATIO');
    const okEmergency = checkRange(t.emergency, 'DB_EMERGENCY_RATIO');
    const okMedia = checkRange(t.hardBlockMedia, 'DB_HARD_BLOCK_MEDIA_RATIO');
    const okText = checkRange(t.hardBlockText, 'DB_HARD_BLOCK_TEXT_RATIO');
    if (!(okTarget && okWarning && okEmergency && okMedia && okText)) {
        return { valid: false, errors };
    }

    // Yeu cau TOI THIEU dung theo STEP 2.1 §22:
    //   0 < TARGET < EMERGENCY < 1
    //   0 < WARNING < EMERGENCY
    //   EMERGENCY <= MEDIA_HARD_BLOCK
    //   MEDIA_HARD_BLOCK <= TEXT_HARD_BLOCK
    if (!(t.target < t.emergency)) {
        errors.push(`DB_TARGET_RATIO (${t.target}) phải nhỏ hơn DB_EMERGENCY_RATIO (${t.emergency})`);
    }
    if (!(t.warning < t.emergency)) {
        errors.push(`DB_WARNING_RATIO (${t.warning}) phải nhỏ hơn DB_EMERGENCY_RATIO (${t.emergency})`);
    }
    if (!(t.emergency <= t.hardBlockMedia)) {
        errors.push(`DB_EMERGENCY_RATIO (${t.emergency}) phải nhỏ hơn hoặc bằng DB_HARD_BLOCK_MEDIA_RATIO (${t.hardBlockMedia})`);
    }
    if (!(t.hardBlockMedia <= t.hardBlockText)) {
        errors.push(`DB_HARD_BLOCK_MEDIA_RATIO (${t.hardBlockMedia}) phải nhỏ hơn hoặc bằng DB_HARD_BLOCK_TEXT_RATIO (${t.hardBlockText})`);
    }
    return { valid: errors.length === 0, errors };
}

// Phan loai trang thai luu tru THUAN TUY tu 1 ty le da do san - day la ham
// duy nhat quyet dinh hanh vi (warning / emergency / hard-block), dung chung
// boi ca server.js (voi ratio that tu pg_database_size) lan unit test (voi
// ratio gia lap 0%..100%, xem STEP 2.1 §17 Case A-J).
function classifyUsage(ratio, t) {
    return {
        ratio,
        normal: ratio < t.warning,
        warning: ratio >= t.warning && ratio < t.emergency,
        emergencyCleanup: ratio >= t.emergency,
        belowTarget: ratio < t.target,
        mediaBlocked: ratio >= t.hardBlockMedia,
        textBlocked: ratio >= t.hardBlockText,
    };
}

// Dinh dang 1 dong log chan doan dung luong nhat quan (STEP 2.1 §21), vi du:
// "[STORAGE] PostgreSQL database usage: 734003200 bytes (700.00 MB / 0.68 GB), limit=1.00 GB, ratio=68.00%"
function formatDiagnostic(prefix, usedMB, limitMB, ratio) {
    const usedBytes = Math.round(usedMB * 1024 * 1024);
    const limitGB = limitMB / 1024;
    return `${prefix} PostgreSQL database usage: ${usedBytes} bytes (${usedMB.toFixed(2)} MB / ${limitGB.toFixed(2)} GB), ` +
        `limit=${limitGB.toFixed(2)} GB, ratio=${(ratio * 100).toFixed(2)}%`;
}

// ===================================================================
// STEP 2.2 (phat hien boi review doc lap): parse bien moi truong SO dung cach.
//
// Loi thuc te truoc day: server.js dung pattern `parseFloat(process.env.X) || default`.
// Trong JS, 0 va NaN deu la falsy, nen pattern nay VO TINH nuot mat 2 truong
// hop nguy hiem ma khong ai biet:
//   X=0    -> parseFloat("0")=0   -> 0 || default   -> AM THAM thanh default (KHONG phai 0 nhu da go)
//   X=abc  -> parseFloat("abc")=NaN -> NaN || default -> AM THAM thanh default (KHONG bao loi gi ca)
// Nguoi van hanh go SAI cau hinh (vd go nham "0" hoac go nham chu) se KHONG
// BAO GIO thay loi - server cu am tham chay voi default nhu khong co chuyen
// gi, dung la vi pham STEP 2.1 §22 "fail fast, khong silently run voi nguong
// khong an toan" ma STEP 2.1 tuong da sua (validateThresholds) nhung chua sua
// triet de, vi validateThresholds KHONG BAO GIO thay duoc gia tri that (0/NaN)
// - no chi thay gia tri default da bi `||` thay the truoc do.
//
// Ham nay phan biet RO RANG 3 truong hop, PURE (khong doc process.env, de test):
//   blank/undefined  -> { blank: true }                        (dung default - day la lua chon HOP LE)
//   khong phai so    -> { blank: false, valid: false }          (FAIL FAST - KHONG am tham dung default)
//   la so hop le      -> { blank: false, valid: true, value }   (dung DUNG gia tri nay, ke ca 0 hoac am - de buoc validate/range-check phia sau tu quyet dinh co hop le khong)
// ===================================================================
function parseConfigNumber(raw) {
    if (raw === undefined || raw === null || String(raw).trim() === '') {
        return { blank: true, valid: true, value: undefined };
    }
    const value = Number(raw); // Number("0")=0 (finite, hop le) khac parseFloat("")=NaN - khong dung parseFloat vi no doc "10abc" thanh 10 ma khong bao loi
    if (!Number.isFinite(value)) {
        return { blank: false, valid: false, value: undefined, error: `giá trị "${raw}" không phải là số hợp lệ` };
    }
    return { blank: false, valid: true, value };
}

module.exports = { validateThresholds, classifyUsage, formatDiagnostic, parseConfigNumber };
