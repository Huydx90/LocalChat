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

// STEP 2.2 (audit finding): phan tich 1 bien moi truong dang so (ratio,
// integer, byte-limit...) THEO DUNG 3 TRUONG HOP, thay vi pattern cu
// `parseFloat(process.env.X) || default` / `parseInt(process.env.X) || default`
// von lam "nuot" am tham moi gia tri falsy (0, NaN do go sai chinh ta) thanh
// default ma KHONG AI BIET:
//   1) khong cau hinh (undefined/null) hoac chuoi rong/blank sau trim()
//        -> dung defaultValue (co the la null, vd DB_STORAGE_LIMIT_MB tat tinh nang)
//   2) co cau hinh nhung KHONG PHAI so hop le (vd "abc", "12abc")
//        -> throw Error (KHONG am tham fallback) de server.js fail-fast
//   3) co cau hinh, la so hop le, nhung ngoai rang buoc (opts.min/opts.max/
//      opts.integer) - vd DB_STORAGE_LIMIT_MB=0 hoac so am
//        -> throw Error
//   4) hop le -> tra ve gia tri da parse (khong con di qua default nua, ke
//      ca khi gia tri that su la 0 - day chinh la loi STEP 2.1 chua sua: 0
//      la mot gia tri HOP LE can duoc giu nguyen, khong duoc coi la "chua
//      cau hinh").
// Ham nay KHONG console.error/process.exit - giu file nay thuan tuy/de test,
// giong dung nguyen tac cua validateThresholds() o tren. server.js se bat
// Error va tu quyet dinh fail-fast (giong pattern JWT_SECRET/ADMIN_PASSWORD
// da co san).
function parseEnvNumber(name, rawValue, defaultValue, opts = {}) {
    const { integer = false, min = null, max = null } = opts;

    if (rawValue === undefined || rawValue === null || String(rawValue).trim() === '') {
        return defaultValue;
    }

    const trimmed = String(rawValue).trim();
    // Dung Number(), KHONG dung parseInt/parseFloat truc tiep de kiem tra hop
    // le: parseInt("12abc", 10) tra ve 12 (am tham bo phan "abc"), trong khi
    // Number("12abc") tra ve NaN - chinh xac hon cho muc dich validation.
    const strictValue = Number(trimmed);
    if (!Number.isFinite(strictValue)) {
        throw new Error(`${name}="${rawValue}" không phải là số hợp lệ`);
    }
    if (integer && !Number.isInteger(strictValue)) {
        throw new Error(`${name}="${rawValue}" phải là số nguyên`);
    }
    if (min !== null && strictValue < min) {
        throw new Error(`${name}="${rawValue}" phải >= ${min}`);
    }
    if (max !== null && strictValue > max) {
        throw new Error(`${name}="${rawValue}" phải <= ${max}`);
    }
    return strictValue;
}

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

module.exports = { validateThresholds, classifyUsage, formatDiagnostic, parseEnvNumber };
