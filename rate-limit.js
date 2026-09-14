// ===================================================================
// rate-limit.js
//
// STEP 3.3 - Rate Limiting, Abuse Protection & WebSocket Hardening.
//
// Cung nguyen tac voi storage-policy.js (STEP 2.1) va input-validation.js
// (STEP 3.2): logic THUAN TUY (khong Express, khong Postgres, khong network,
// khong side-effect ngoai bo nho trong-process) duoc tach rieng de:
//   1. Unit-test doc lap (xem test/rate-limit.test.js) ma khong can boot
//      server/Postgres.
//   2. De doc/audit: toan bo "policy" nam o 1 cho, server.js chi goi.
//
// KIEN TRUC - QUAN TRONG (doc truoc khi dung):
// Deployment hien tai (xem README) chay TREN 1 Node process duy nhat tren
// Render (khong co bang chung/cau hinh nao cho multi-instance/horizontal
// scaling trong project nay). Vi vay o STEP 3.3 dung in-memory Map lam store
// cho rate limiter la CHAP NHAN DUOC (dung y spec §3: "khong can them Redis
// chi cho STEP 3.3 neu project hien tai chua dung Redis"). Nhung NEU sau nay
// scale ra nhieu instance dang sau 1 load balancer, cac Map nay la STATE
// RIENG CUA TUNG PROCESS - 1 attacker co the "rai" request qua nhieu instance
// khac nhau de nhan duoc gioi han GAP N LAN so voi cau hinh (N = so instance).
// Day la KNOWN LIMITATION duoc ghi ro trong README/report, KHONG phai loi o
// STEP nay - chi la thu duoc chap nhan cho kien truc 1-process hien tai.
//
// De "de thay the bang Redis/shared store sau nay" (spec §3) MA KHONG PHAI
// rewrite toan bo cho goi RateLimiter/ConcurrencyGuard, ca 2 class deu chi lo
// ra dung 1 be mat API toi thieu (consume/tryAcquire/release/reset/sweep) -
// mot implementation dua tren Redis (vd dung INCR+EXPIRE hoac Lua script cho
// atomicity) co the thay the truc tiep ma KHONG can doi code goi o server.js,
// mien la giu dung cung signature.
// ===================================================================

// ---------------------------------------------------------------------
// RateLimiter: fixed-window counter, O(1) moi request.
//
// Chon fixed-window (thay vi sliding-window/token-bucket) vi don gian, du
// chinh xac cho muc dich chong abuse o quy mo chat noi bo (khong can chinh
// xac tuyet doi tung mili-giay), va KHONG can luu lich su timestamp (moi key
// chi ton 2 so: count + resetAt) - quan trong de tranh memory leak khi co
// nhieu key (nhieu IP/username) truy cap dong thoi (spec §35).
// ---------------------------------------------------------------------
class RateLimiter {
    constructor({ windowMs, max }) {
        if (!(Number.isFinite(windowMs) && windowMs > 0)) throw new Error('RateLimiter: windowMs phai la so duong');
        if (!(Number.isFinite(max) && max > 0)) throw new Error('RateLimiter: max phai la so duong');
        this.windowMs = windowMs;
        this.max = max;
        this.hits = new Map(); // key -> { count, resetAt }
    }

    // Ghi nhan 1 (hoac `weight`) request cho `key`. TRA VE object mo ta ket
    // qua - KHONG throw - de code goi tu quyet dinh 429/Retry-After.
    //
    // *** ATOMICITY (STEP 3.3 FIX §1) ***
    // Ham nay la operation "check + increment" DONG BO THUAN TUY (khong co
    // "await" nao ben trong) - vi JavaScript don luong (single-threaded event
    // loop) va ham nay khong bao gio nhuong quyen thuc thi (yield) giua buoc
    // doc "entry.count" va buoc ghi "entry.count += weight", KHONG CO CACH
    // NAO 2 lan goi consume() cho CUNG 1 key lai "dan xen" (interleave) voi
    // nhau - lan goi thu N+1 LUON thay ket qua DA bao gom dung N lan goi
    // truoc do, ke ca khi ca N+1 lan goi đến GAN NHU CUNG LUC tu N request
    // HTTP dong thoi khac nhau (Node.js xu ly callback nay xong roi moi den
    // callback khac, khong bao gio chay chen).
    //
    // DIEU KIEN DE GIU DUOC TINH ATOMIC NAY O PHIA NGUOI GOI: PHAI goi
    // consume() va kiem tra ".allowed" NGAY LAP TUC, KHONG duoc co bat ky
    // "await" nao xen giua luc goi consume() va luc code re nhanh theo ket
    // qua ".allowed". Neu ban goi consume() (hoac te hon, peek() - xem ghi
    // chu duoi) RIENG BIET voi 1 buoc "await" o giua (vd await truy van DB
    // hoac await bcrypt.compare() TRUOC KHI thuc su consume()), thi nhieu
    // request dong thoi CO THE cung "lot qua" buoc kiem tra truoc khi bat ky
    // request nao trong so do THUC SU ghi nhan lan thu cua minh - day chinh
    // la loi rate-limit-bypass-qua-race-condition da tung xay ra o route
    // login (xem lich su sua o server.js). QUY TAC: goi consume() CANG SOM
    // CANG TOT, TRUOC MOI await, cho MOI request/hanh dong can rate-limit.
    consume(key, weight = 1) {
        const now = Date.now();
        let entry = this.hits.get(key);
        if (!entry || now >= entry.resetAt) {
            entry = { count: 0, resetAt: now + this.windowMs };
            this.hits.set(key, entry);
        }
        entry.count += weight;
        const allowed = entry.count <= this.max;
        return {
            allowed,
            remaining: Math.max(0, this.max - entry.count),
            retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
        };
    }

    // Alias cua consume() voi ten tuong minh hon ve muc dich "atomic
    // admission" (dat ten theo thuat ngu pho bien "tryConsume"/"reserve") -
    // CUNG 1 hanh vi, khong co gi khac biet. Dung tai nhung noi ma viec goi
    // dung 1 lan DUY NHAT, DONG BO, TRUOC await la yeu cau bat buoc ve bao
    // mat (vd route login) de code doc ro rang hon y do "day la buoc giu
    // cho (reservation), khong phai chi don thuan dem so".
    tryConsume(key, weight = 1) {
        return this.consume(key, weight);
    }

    // Giong consume() nhung KHONG ghi nhan/tang bo dem - chi doc trang thai
    // hien tai. *** CANH BAO: peek() KHONG PHAI 1 buoc "kiem tra admission"
    // an toan - vi no khong "giu cho" (reserve) gi ca, nhieu request dong
    // thoi goi peek() DEU co the thay "allowed: true" cung luc, roi TAT CA
    // cung di tiep, khong request nao thuc su bi chan cho toi khi co request
    // goi consume() that su. KHONG dung peek() de quyet dinh co cho phep 1
    // hanh dong "ton kem" (vd bcrypt.compare()) chay hay khong - chi dung de
    // hien thi thong tin (vd "con lai bao nhieu luot") KHONG anh huong quyet
    // dinh admission. *** Muc dich ban dau cua ham nay (kiem tra truoc khi
    // "tinh la 1 lan thu" cho truong hop login thanh cong) da duoc thay the
    // bang thiet ke moi: consume() NGAY LAP TUC cho MOI lan thu (thanh cong
    // hay that bai deu tinh), roi reset() rieng cho truong hop thanh cong
    // (xem server.js route login) - xem STEP 3.3 FIX §1.
    peek(key) {
        const now = Date.now();
        const entry = this.hits.get(key);
        if (!entry || now >= entry.resetAt) {
            return { allowed: true, remaining: this.max, retryAfterSeconds: Math.max(1, Math.ceil(this.windowMs / 1000)) };
        }
        const allowed = entry.count < this.max; // "<" (khong phai "<="): chua tinh lan nay vao
        return {
            allowed,
            remaining: Math.max(0, this.max - entry.count),
            retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
        };
    }

    // Xoa het bo dem cho 1 key - dung khi login THANH CONG de reset failure
    // counter cua account do (spec §5: "login thanh cong phai reset
    // account-level failure counter").
    reset(key) {
        this.hits.delete(key);
    }

    // Don rac cac entry da het han - goi dinh ky tu 1 setInterval rieng
    // (server.js) de Map khong phinh to vo han neu attacker tao rat nhieu key
    // khac nhau (spec §35: "khong de attacker tao vo han key"). Entry het han
    // tu nhien se duoc ghi de o consume() lan sau, nhung neu key do KHONG bao
    // gio duoc dung lai (vd IP ngau nhien 1 lan) thi no se nam lai trong Map
    // mai neu khong co sweep() dinh ky.
    sweep() {
        const now = Date.now();
        for (const [key, entry] of this.hits) {
            if (now >= entry.resetAt) this.hits.delete(key);
        }
    }

    get size() {
        return this.hits.size;
    }
}

// ---------------------------------------------------------------------
// ConcurrencyGuard: dem so "task dang chay" cho 1 key (KHAC RateLimiter -
// day khong phai cua so thoi gian, ma la counter song tang/giam theo
// acquire/release). Dung cho concurrent upload limit (spec §9).
// ---------------------------------------------------------------------
class ConcurrencyGuard {
    constructor({ max }) {
        if (!(Number.isFinite(max) && max > 0)) throw new Error('ConcurrencyGuard: max phai la so duong');
        this.max = max;
        this.counts = new Map();
    }

    // TRA VE true/false - KHONG throw. Neu true, BAT BUOC phai goi release()
    // sau do (dung try/finally o noi goi - xem server.js route upload) de
    // tranh counter bi "ket" mai o gia tri > 0 khi co loi giua chung (multer
    // error, HEIC conversion error, database error, client disconnect...).
    tryAcquire(key) {
        const current = this.counts.get(key) || 0;
        if (current >= this.max) return false;
        this.counts.set(key, current + 1);
        return true;
    }

    release(key) {
        const current = this.counts.get(key) || 0;
        if (current <= 1) this.counts.delete(key); // ve 0 -> xoa han khoi Map, khong de rac lai
        else this.counts.set(key, current - 1);
    }

    get(key) {
        return this.counts.get(key) || 0;
    }

    get size() {
        return this.counts.size;
    }
}

// ---------------------------------------------------------------------
// §36 Trust proxy / IP security — THIET KE LAI HOAN TOAN (FINAL STEP 3.3 FIX).
//
// LICH SU AUDIT (2 vong truoc):
//   Vong 1: "getClientIp()" lay entry BEN TRAI CUNG cua X-Forwarded-For -
//     SAI hoan toan (do la gia tri CLIENT TU CHON).
//   Vong 2: sua thanh lay entry BEN PHAI CUNG (rightmost), dua tren gia dinh
//     "Render dat DUNG 1 reverse proxy truoc app". Gia dinh nay tu no la van
//     de: Render la 1 PaaS cong khai, kien truc mang thuc te phia truoc app
//     (co the co them CDN/edge nhu Cloudflare, hoac nhieu lop proxy noi bo
//     khac) KHONG duoc dam bao chi la "dung 1 hop" - gia dinh sai so hop se
//     lam sai ca IP duoc chon dau vao "rightmost" do.
//
// THIET KE LAN NAY (final): KHONG con dua vao "dem so hop trong
// X-Forwarded-For" nua - bo HOAN TOAN X-Forwarded-For khoi duong dan tin cay
// (dung y §7: "don gian nhat la loai bo XFF khoi production client-IP
// resolution" - XFF van co the xuat hien trong header nhung KHONG BAO GIO
// duoc code nay doc/tin de dua ra quyet dinh rate-limit). Thay vao do:
//
//   1. NEU deployment THAT SU dat sau Cloudflare (xac nhan boi nguoi van
//      hanh qua bien moi truong tuong minh TRUST_CF_CONNECTING_IP=true - xem
//      server.js), dung header "CF-Connecting-IP" LAM NGUON DUY NHAT cho IP
//      client - day la header Cloudflare edge tu GHI DE (khong phai append)
//      voi dia chi TCP that cua nguoi ket noi toi Cloudflare, KHONG THE bi
//      client tu thiet lap NEU va CHI NEU request thuc su di qua Cloudflare
//      (Cloudflare edge se ghi de moi "CF-Connecting-IP" client tu gui truoc
//      do). Gia tri nay PHAI duoc validate la 1 dia chi IP DON, HOP LE
//      (dung net.isIP() cua Node - tu choi rong/whitespace/nhieu gia tri
//      cach nhau boi dau phay/rac) truoc khi su dung - xem isSingleValidIp().
//   2. NEU khong bat TRUST_CF_CONNECTING_IP (mac dinh AN TOAN - KHONG tin
//      bat ky header nao ca), hoac header CF-Connecting-IP vang mat/khong
//      hop le, dung THANG "req.socket.remoteAddress" (dia chi TCP thuc su
//      ket noi toi process Node nay - du lieu tang giao thuc, KHONG THE bi
//      client gia mao qua HTTP header). Day la fallback AN TOAN theo huong
//      "that bai dong kin" (fail-closed/fail-strict): neu THAT SU co 1 lop
//      proxy truoc app ma chua bat co CF-Connecting-IP tin cay, ket qua la
//      MOI client deu "trung" 1 dia chi (dia chi cua proxy do) - qua CHAT
//      (co the lam rate-limit chung mot cach khong mong muon, anh huong
//      trai nghiem) nhung KHONG BAO GIO qua LONG (khong the bi client
//      bypass bang cach tu chon IP) - danh doi ro rang, uu tien AN TOAN hon
//      TIEN LOI khi khong chac chan ve kien truc mang thuc te.
//
// *** GIA DINH TRIEN KHAI - GHI RO, KHONG CLAIM QUA MUC ***
// Toan bo hieu qua cua "CF-Connecting-IP" phu thuoc vao 1 dieu KHONG THE tu
// code trong app nay xac minh: app CHI nhan duoc ket noi qua dung Cloudflare
// (khong co duong nao khac de client ket noi THANG toi Render/app ma bo qua
// Cloudflare). Day la trach nhiem cau hinh HA TANG (Cloudflare "Full/Strict"
// origin lock, hoac Render's origin chi chap nhan ket noi tu dai IP cua
// Cloudflare) - KHONG PHAI thu code o day co the tu dam bao. Phien lam viec
// nay KHONG CO ket noi mang de xac minh cau hinh Cloudflare/Render thuc te
// cho deployment nay - vi vay TRUST_CF_CONNECTING_IP mac dinh la "false"
// (KHONG tin), va CHI duoc bat len khi nguoi van hanh DA xac nhan kien truc
// that (xem README). KHONG bao gio viet "CF-Connecting-IP luon dang tin
// cay" hay "Render dam bao..." mot cach tuyet doi trong tai lieu.
// ---------------------------------------------------------------------

const net = require('net');

// Chuan hoa 1 dia chi IP: bo tien to IPv4-mapped-IPv6 "::ffff:" neu co (vd
// "::ffff:127.0.0.1" -> "127.0.0.1") de CUNG 1 client that khong bi tach
// thanh 2 rate-limit key khac nhau chi vi bieu dien IPv4/IPv6 khac nhau giua
// cac tang (socket vs header). CHI cat dung tien to nay - KHONG dung bat ky
// phep cat chuoi tuy tien nao khac, de dia chi IPv6 THAT (vd "2001:db8::1")
// khong bao gio bi bien dang.
function normalizeIp(ip) {
    if (typeof ip !== 'string') return ip;
    const trimmed = ip.trim();
    if (trimmed.toLowerCase().startsWith('::ffff:')) return trimmed.slice(7);
    return trimmed;
}

// Kiem tra 1 gia tri header CO PHAI la DUNG 1 dia chi IP hop le (IPv4 hoac
// IPv6) hay khong - dung Node builtin `net.isIP()` (khong can them thu vien
// nao). Tu choi: khong phai string, rong/toan khoang trang, chua dau phay
// (nhieu gia tri - vd "1.2.3.4, 5.6.7.8" KHONG duoc coi la 1 client IP don),
// chua khoang trang ben trong, hoac khong phai dinh dang IP hop le (rac,
// CRLF con sot lai, v.v.). Day la buoc validation BAT BUOC truoc khi tin bat
// ky header nao lam dinh danh client cho rate-limit (spec §5).
function isSingleValidIp(value) {
    if (typeof value !== 'string') return false;
    const trimmed = value.trim();
    if (!trimmed) return false;
    if (trimmed.includes(',')) return false; // nhieu gia tri cach nhau boi dau phay - khong phai 1 IP don
    if (/\s/.test(trimmed)) return false; // con khoang trang/tab/xuong dong o giua sau khi trim ngoai
    return net.isIP(trimmed) !== 0; // 0 = khong hop le, 4 = IPv4, 6 = IPv6
}

// Doc + validate header "CF-Connecting-IP" tu 1 object headers (dung chung
// cho ca HTTP (req.headers cua Express) va WS upgrade (req.headers cua
// http.IncomingMessage tho) - cung 1 logic validate cho ca 2 duong.
// TRA VE null neu KHONG duoc tin (thieu options.trustCfConnectingIp) hoac
// header khong hop le - KHONG BAO GIO throw.
function resolveTrustedCfConnectingIp(headers, trustCfConnectingIp) {
    if (!trustCfConnectingIp) return null; // mac dinh AN TOAN: khong bat = khong tin bat ky header nao
    const raw = headers && headers['cf-connecting-ip'];
    if (!isSingleValidIp(raw)) return null;
    return normalizeIp(raw.trim());
}

// getHttpClientIp: dung cho request HTTP thuong (Express hoac tuong duong -
// chi can co `.headers` va (tuy chon) `.socket.remoteAddress`).
//
// `options.trustCfConnectingIp` (boolean, mac dinh false) - CHI bat len khi
// nguoi van hanh DA XAC NHAN deployment thuc te dat sau Cloudflare voi origin
// duoc khoa chi nhan traffic tu Cloudflare (xem ghi chu trust-model o tren).
// Gia tri nay duoc truyen tu server.js (doc tu bien moi truong
// TRUST_CF_CONNECTING_IP, fail-fast neu cau hinh sai dinh dang) - rate-limit.js
// KHONG tu doc process.env de giu module nay THUAN TUY/de test doc lap.
function getHttpClientIp(req, options = {}) {
    const trusted = resolveTrustedCfConnectingIp(req && req.headers, options.trustCfConnectingIp);
    if (trusted) return trusted;
    // Fallback AN TOAN: dia chi socket TCP thuc su - KHONG dung req.ip (phu
    // thuoc cau hinh "trust proxy" cua Express, da bo do thiet ke nay khong
    // con dua vao dem-so-hop-XFF nua) va KHONG dung X-Forwarded-For.
    return normalizeIp((req && req.socket && req.socket.remoteAddress) || 'unknown');
}

// getWsClientIp: dung cho `req` la http.IncomingMessage THO cua buoc
// WebSocket upgrade (KHONG di qua Express). CUNG 1 logic voi getHttpClientIp
// (chi khac ten ham de ro rang ve ngu canh su dung, va vi 2 loai request nay
// khong cung 1 kieu object trong toan bo codebase) - dam bao HTTP va WS luon
// cho ra CUNG 1 dinh danh IP cho CUNG 1 client that (spec §9/§13).
function getWsClientIp(req, options = {}) {
    const trusted = resolveTrustedCfConnectingIp(req && req.headers, options.trustCfConnectingIp);
    if (trusted) return trusted;
    return normalizeIp((req && req.socket && req.socket.remoteAddress) || 'unknown');
}

module.exports = { RateLimiter, ConcurrencyGuard, getHttpClientIp, getWsClientIp, normalizeIp, isSingleValidIp };
