// ===================================================================
// input-validation.js
//
// STEP 3.2 (testability - cung nguyen tac voi storage-policy.js STEP 2.1 §19):
// logic validation THUAN TUY (khong Express, khong Postgres, khong network,
// khong side effect) duoc tach rieng khoi server.js de co the unit-test truc
// tiep bang `node --test test/input-validation.test.js` MA KHONG CAN
// `npm install` (express/pg/...) hay Postgres that. server.js require() cac
// ham nay va dung y het trong tung route handler.
// ===================================================================

// ---------------------------------------------------------------------
// §11 Numeric ID Validation
//
// KHONG dung parseInt()/Number() truc tiep tren input tu client:
//   parseInt("-1", 10)   === -1   (truthy trong JS - "hop le" nham!)
//   parseInt("1abc", 10) === 1    (am tham bo qua phan "abc" - nham!)
// Ca 2 hanh vi tren deu KHONG phai thu ta muon chap nhan tu 1 client. Moi noi
// nhan 1 ID (path param :id, query afterId/beforeId/limit, body replyToId)
// PHAI di qua 1 trong 2 ham duoi day.
// ---------------------------------------------------------------------
const POSITIVE_INT_RE = /^[1-9][0-9]*$/;

function parsePositiveIntStrict(raw) {
    if (typeof raw === 'number') {
        // Number.isInteger(Infinity/NaN) === false nen da tu dong bi chan,
        // khong can kiem tra rieng cho tung truong hop.
        return Number.isInteger(raw) && raw > 0 && Number.isSafeInteger(raw) ? raw : null;
    }
    if (typeof raw !== 'string') return null; // tu choi object/array/boolean/null/undefined...
    const trimmed = raw.trim();
    // Regex chi khop CHINH XAC 1 chuoi toan chu so, khong dau +/-, khong
    // khoang trang xen giua, khong so 0 dung dau.
    if (!POSITIVE_INT_RE.test(trimmed)) return null;
    if (trimmed.length > 15) return null; // chan truoc khi vuot Number.MAX_SAFE_INTEGER (~16 chu so)
    const n = Number(trimmed);
    return Number.isSafeInteger(n) ? n : null;
}

// Giong parsePositiveIntStrict nhung cho phep them gia tri 0 (dung cho
// "afterId=0" nghia la "lay tu dau" - 0 o day la 1 gia tri HOP LE, khac voi
// ID that trong DB luon bat dau tu 1).
function parseNonNegativeIntStrict(raw) {
    if (raw === 0) return 0;
    if (typeof raw === 'string' && raw.trim() === '0') return 0;
    return parsePositiveIntStrict(raw);
}

// ---------------------------------------------------------------------
// §4/§5 Control character filtering cho message text
// Whitelist nguoc: cho phep \n \t \r (tin nhan nhieu dong) va moi Unicode/
// emoji hop le, chi chan cac C0 control character khac (bao gom null byte).
// ---------------------------------------------------------------------
const DISALLOWED_CONTROL_CHARS_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;

// ---------------------------------------------------------------------
// §17/§18 Magic-byte / file-signature detection
//
// KHONG tin Content-Type do client tu khai bao trong multipart - attacker co
// the doi field do thanh "image/jpeg" trong khi noi dung thuc su la file bat
// ky. Cac ham duoi day doc THAT vai byte dau file (khong dung/them thu vien
// parser day du nao) de xac nhan noi dung THAT SU khop voi mimetype da khai
// bao, giong nguyen tac da co san cho HEIC (looksLikeHeicBuffer).
// ---------------------------------------------------------------------
function looksLikeJpeg(buf) {
    return !!buf && buf.length >= 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF;
}
function looksLikePng(buf) {
    const sig = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
    return !!buf && buf.length >= 8 && sig.every((b, i) => buf[i] === b);
}
function looksLikeGif(buf) {
    return !!buf && buf.length >= 6 && /^GIF8[79]a$/.test(buf.toString('ascii', 0, 6));
}
function looksLikeWebp(buf) {
    return !!buf && buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP';
}
// MP4/QuickTime/M4V deu la container ISO-BMFF (cung ho "ftyp" box nhu HEIC,
// chi khac brand). O day khong gioi han danh sach brand cu the (qua nhieu
// brand hop le: isom/mp42/mp41/qt  /M4V...), chi xac nhan DUNG la 1 ISO-BMFF
// container that (co box "ftyp" o dung vi tri).
function looksLikeIsoBmffContainer(buf) {
    return !!buf && buf.length >= 12 && buf.toString('ascii', 4, 8) === 'ftyp';
}
// WebM/Matroska deu dung EBML header o 4 byte dau.
function looksLikeEbml(buf) {
    return !!buf && buf.length >= 4 && buf[0] === 0x1A && buf[1] === 0x45 && buf[2] === 0xDF && buf[3] === 0xA3;
}
// HEIC/HEIF: ISO-BMFF "ftyp" box voi 1 trong cac brand HEIC/HEIF da biet.
const HEIC_BRANDS = ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1', 'heim', 'heis', 'hevm', 'hevs'];
function looksLikeHeicBuffer(buf) {
    if (!buf || buf.length < 12) return false;
    if (buf.toString('ascii', 4, 8) !== 'ftyp') return false;
    const brand = buf.toString('ascii', 8, 12).toLowerCase();
    return HEIC_BRANDS.includes(brand);
}

const IMAGE_SIGNATURE_CHECKS = {
    'image/jpeg': looksLikeJpeg,
    'image/png': looksLikePng,
    'image/gif': looksLikeGif,
    'image/webp': looksLikeWebp,
};
const VIDEO_SIGNATURE_CHECKS = {
    'video/mp4': looksLikeIsoBmffContainer,
    'video/quicktime': looksLikeIsoBmffContainer,
    'video/webm': looksLikeEbml,
    'video/x-matroska': looksLikeEbml,
};

// ---------------------------------------------------------------------
// §13 Prototype pollution defense (Express middleware, THUAN TUY - khong
// truy cap DB/network, chi doc req.body da duoc express.json() parse san).
// ---------------------------------------------------------------------
function rejectDangerousKeys(req, res, next) {
    const body = req.body;
    if (body && typeof body === 'object' && !Array.isArray(body)) {
        for (const key of ['__proto__', 'constructor', 'prototype']) {
            if (Object.prototype.hasOwnProperty.call(body, key)) {
                return res.status(400).json({ error: 'invalid_input' });
            }
        }
    }
    next();
}

module.exports = {
    parsePositiveIntStrict, parseNonNegativeIntStrict,
    DISALLOWED_CONTROL_CHARS_RE,
    looksLikeJpeg, looksLikePng, looksLikeGif, looksLikeWebp,
    looksLikeIsoBmffContainer, looksLikeEbml, looksLikeHeicBuffer,
    IMAGE_SIGNATURE_CHECKS, VIDEO_SIGNATURE_CHECKS,
    rejectDangerousKeys,
};
