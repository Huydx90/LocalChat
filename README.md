# Chat nội bộ công ty

Ứng dụng chat nội bộ: Node.js (Express + `ws`) + PostgreSQL, deploy trên **Render.com**.

## Tính năng

- Đăng ký tự do, nhưng tài khoản mới ở trạng thái **chờ duyệt** — chưa thấy được nội dung/chat.
- **Admin duy nhất**: `do.huy`, tự seed khi khởi động lần đầu. Mật khẩu lấy từ biến môi trường `ADMIN_PASSWORD` — **bắt buộc phải đặt** khi `NODE_ENV=production` (server từ chối khởi động nếu thiếu, giống `JWT_SECRET`/`MESSAGE_ENCRYPTION_KEY`, không còn mật khẩu mặc định công khai trong code).
- Admin duyệt (cấp quyền) user, thu hồi quyền, và **xóa** user.
- Tin nhắn thường **không thể tự xóa/thu hồi bởi người gửi** — chỉ **admin** mới có quyền xóa (`DELETE /api/messages/:id`, xem mục "Reply & Delete" bên dưới). Vẫn không có endpoint sửa nội dung tin nhắn.
- **Reply (trả lời)**: bấm chuột phải / giữ (chuột trái hoặc chạm giữ trên cảm ứng) vào 1 bong bóng chat để mở submenu, chọn "Trả lời" — ô nhập hiện thanh trích dẫn tin nhắn gốc, gửi đi thì bong bóng mới hiển thị phần trích dẫn (người gửi + đoạn preview) phía trên nội dung mới, giống UI trích dẫn của WhatsApp/Messenger.
- **Xem ảnh lớn**: double-click (double-tap) vào ảnh trong bong bóng chat để xem phóng to giữa màn hình (lightbox), bấm ✕ hoặc click ra ngoài để đóng.
- **Video**: trong khung chat chỉ hiển thị khung preview (không có control phát), double-click (double-tap) để mở trình phát video lớn giữa màn hình.
- Gửi/xem **ảnh và video**, có giới hạn dung lượng (xem bên dưới). Hỗ trợ ảnh **HEIC/HEIF** (iPhone) — tự động chuyển sang JPEG.
- **Emotion**: nút 😊 cạnh ô nhập mở bảng emoji theo danh mục — bấm 1 emoji sẽ **gửi ngay như tin nhắn text bình thường** (không tạo API/bảng riêng, tự áp dụng mã hóa + retention 48h có sẵn). Tin nhắn chỉ gồm 1-3 emoji được hiển thị lớn hơn.
- Mỗi bong bóng chat có **nút copy nổi** và **nút thả cảm xúc (reaction)** (👍 ❤️ 😂 😮 😢 😡 🎉) — khác với Emotion: reaction gắn vào 1 tin nhắn có sẵn, lưu ở bảng `message_reactions` riêng, không tạo tin nhắn mới.
- Tin nhắn mới **báo hiệu realtime** cho mọi client qua WebSocket (chấm đỏ + số chưa đọc trong app — **không** đẩy push notification ra hệ điều hành). **Polling fallback**: nếu WebSocket không kết nối được (ví dụ bị mạng/proxy công ty chặn `wss://`), client tự động chuyển sang hỏi định kỳ `GET /api/messages?afterId=...` mỗi ~4 giây qua HTTPS bình thường — vẫn gần-realtime dù không dùng được WS. Tự động quay lại dùng WS ngay khi kết nối lại được (không cần tải lại trang).
- Hỗ trợ **tag @username** trong phòng chat (autocomplete khi gõ `@`).

## Mô hình mã hóa (server-side, KHÔNG phải E2EE)

```
Client  --HTTPS/WSS (TLS)-->  Server  --AES-256-GCM-->  PostgreSQL
```

- Dữ liệu **truyền tải** (giữa trình duyệt và server) được bảo vệ bởi TLS (HTTPS/WSS) — bắt buộc chạy sau domain `https://` (Render tự cấp).
- Dữ liệu **lưu trữ**: server mã hóa nội dung tin nhắn/ảnh/video bằng **AES-256-GCM** trước khi ghi vào PostgreSQL, dùng khóa `MESSAGE_ENCRYPTION_KEY` (biến môi trường, không hard-code, không commit). PostgreSQL **không bao giờ chứa plaintext**.
- **Server có khả năng giải mã** nội dung (để phục vụ hiển thị, tìm @mention, v.v.) — đây là khác biệt quan trọng so với bản trước: **không còn là mã hóa đầu-cuối (E2EE)**. Nếu cần E2EE thật (server không đọc được), đó là một kiến trúc khác và cần STEP riêng.
- `MESSAGE_ENCRYPTION_KEY` phải là chuỗi base64 giải mã ra đúng 32 byte. Tạo bằng:
  ```bash
  openssl rand -base64 32
  ```
  Nếu thiếu biến này khi `NODE_ENV=production`, server **từ chối khởi động** (fail fast) thay vì dùng khóa mặc định không an toàn.

## Giới hạn media

| Loại  | Giới hạn        | Xử lý |
|-------|------------------|-------|
| Ảnh   | ≤ 500 KB (512000 bytes) | Client tự resize/nén (giảm kích thước + chất lượng JPEG lặp lại) trước khi gửi; **server kiểm tra lại**, từ chối (413) nếu vượt |
| Video | ≤ 10 MB (10485760 bytes) | Client chỉ kiểm tra dung lượng (không encode); **server kiểm tra lại**, từ chối (413) nếu vượt |

Ảnh/video được truyền lên bằng `multipart/form-data` (không còn base64 trong JSON) để giảm overhead (~33%) và tránh phải giữ payload khổng lồ trong RAM. Khi hiển thị, client tải nội dung qua endpoint riêng `GET /api/messages/:id/media` (đã xác thực), server giải mã và trả về nhị phân trực tiếp.

### Ảnh HEIC/HEIF (iPhone)

Kiến trúc ưu tiên **client convert trước, server convert là fallback** — database/viewer cuối cùng chỉ bao giờ thấy JPEG/PNG/WebP/GIF, không bao giờ lưu HEIC nguyên bản:

```
Chọn ảnh .heic/.heif
        ↓
Client: thư viện heic2any (CDN) → JPEG
        ↓ (nếu thất bại/không tải được thư viện)
Gửi thẳng file HEIC gốc lên server
        ↓
Client/JPEG đi qua pipeline nén hiện tại (resize + giảm quality) → ≤500KB
        ↓
Server nhận file:
  - Nếu là JPEG/PNG/WebP/GIF hợp lệ → lưu như bình thường (không đổi)
  - Nếu là HEIC/HEIF (nhận diện qua magic bytes "ftyp" box, KHÔNG tin
    mimetype/extension client gửi) → server tự convert bằng `heic-convert`
    (thư viện pure-JS/WASM, không cần biên dịch native) → JPEG
  - Nếu convert thất bại hoặc kết quả vẫn > 500KB sau khi đã thử giảm
    quality → trả lỗi rõ ràng (400/413) cho client, KHÔNG lưu HEIC
    không tương thích vào database
        ↓
Encrypt (AES-256-GCM) → PostgreSQL, giống mọi ảnh khác
```

Không cần cấu hình gì thêm — chỉ cần `npm install` lại để có `heic-convert` trong `node_modules` (server fallback), và server phải có Internet ra ngoài để tải `heic2any` qua CDN trong `index.html` (nếu mạng công ty chặn CDN, tính năng tự rớt xuống fallback server, không lỗi/crash).

## Message retention (48h) + rolling/emergency cleanup + hard-block guard

- **Bình thường**: tin nhắn tự động bị xóa sau `MESSAGE_RETENTION_HOURS` giờ (mặc định **48**). Chạy định kỳ mỗi 10 phút (và ngay lúc khởi động), xóa theo batch (`EMERGENCY_DELETE_BATCH_SIZE`, mặc định 500), thứ tự **tất định** `ORDER BY created_at ASC, id ASC` (không chỉ `created_at` — nhiều tin có thể cùng timestamp, `id` là tiêu chí phụ để thứ tự luôn nhất quán).
- **Rolling/emergency**: nếu dung lượng PostgreSQL vượt ngưỡng, server chủ động xóa **tin nhắn cũ nhất trước** (cùng thứ tự tất định ở trên), kể cả khi chưa đủ 48h, cho tới khi về vùng an toàn. Tính năng này **chỉ hoạt động nếu đặt `DB_STORAGE_LIMIT_MB`** (dung lượng **thực tế** của gói Postgres trên Render — kiểm tra trong Render dashboard, không đoán/mặc định).

### Bảng hành vi theo ngưỡng (khi đã cấu hình `DB_STORAGE_LIMIT_MB`)

| Dung lượng DB | Hành vi |
|---|---|
| `< 80%` | Bình thường |
| `80% – 89.99%` | **Cảnh báo** — log `[STORAGE WARNING]` (log 1 lần khi vừa vào vùng này, không lặp lại mỗi 10 phút nếu vẫn ở nguyên trạng thái) |
| `90% – 94.99%` | Emergency cleanup chạy — xóa cũ-nhất-trước theo batch tới khi về dưới `DB_TARGET_RATIO` (0.75) hoặc hết tin để xóa |
| `95% – 98.99%` | Emergency cleanup vẫn chạy **+** ảnh/video bị từ chối (503) — text vẫn được gửi |
| `99% – 100%` | Ảnh/video **và** text đều bị từ chối (503) |

Các mức này **chồng lấn có chủ đích** — ví dụ 96% nghĩa là: emergency cleanup đang chạy, media bị chặn, nhưng text vẫn được phép (vì text rất nhỏ, ưu tiên giữ chat hoạt động lâu nhất có thể).

- `DB_WARNING_RATIO=0.80`, `DB_EMERGENCY_RATIO=0.90`, `DB_TARGET_RATIO=0.75`, `DB_HARD_BLOCK_MEDIA_RATIO=0.95`, `DB_HARD_BLOCK_TEXT_RATIO=0.99` — các ngưỡng này được **validate quan hệ logic lúc khởi động** (`0 < TARGET < EMERGENCY`, `0 < WARNING < EMERGENCY`, `EMERGENCY <= HARD_BLOCK_MEDIA <= HARD_BLOCK_TEXT`); nếu cấu hình sai, server **từ chối khởi động** với lỗi rõ ràng thay vì chạy âm thầm với ngưỡng không an toàn.
- **⚠️ Giới hạn thật của PostgreSQL cần biết**: `DELETE` **không** làm `pg_database_size()` giảm ngay lập tức — nó chỉ tạo dead tuples; dung lượng file trên đĩa chỉ thực sự giảm khi `VACUUM FULL`/`pg_repack` rewrite lại bảng (không chạy tự động ở đây vì cần khóa mạnh, block cả bảng). Emergency cleanup vì vậy **luôn đo lại thật** (`pg_database_size()`) sau mỗi batch thay vì giả định con số giảm, và log trung thực nếu tỷ lệ vẫn cao sau khi dọn xong (không giả vờ "finished thành công"). Sau đó chạy thêm `VACUUM (ANALYZE) messages` (an toàn, không phải `VACUUM FULL`) như một nỗ lực best-effort — **không phải cam kết giảm dung lượng ngay**.
- **Đo dung lượng thất bại thì sao?** (ví dụ Postgres tạm mất kết nối): server không bao giờ crash vì việc này. Với **media**, hệ thống fail-closed — tạm từ chối upload (503, "không xác minh được dung lượng") vì upload lớn rủi ro cao hơn. Với **text**, hệ thống fail-open — vẫn cho gửi (không muốn 1 lần đo lỗi tạm thời làm gián đoạn cả phòng chat), lỗi được log lại để admin biết.
- **Cache dung lượng**: tối đa 30 giây để tránh gọi `pg_database_size()` mỗi request. Cache này chỉ an toàn khi còn cách xa ngưỡng hard-block — nếu số liệu cache gần nhất đã nằm trong phạm vi 3 điểm % dưới `DB_HARD_BLOCK_MEDIA_RATIO`, server **bắt buộc đo lại thật** thay vì tin cache, để tránh nhiều upload đồng thời cùng "nhìn thấy" một con số cũ và cùng vượt ngưỡng.
- Cleanup dùng khóa đơn giản trong bộ nhớ (`cleanupRunning`, `try/finally`) để tránh nhiều chu kỳ dọn dẹp chạy chồng nhau — đủ dùng vì Render Free chỉ chạy 1 instance; không cần advisory lock của Postgres.
- Mỗi vòng emergency cleanup có giới hạn cứng `MAX_CLEANUP_ITERATIONS` (mặc định 50) để không bao giờ là vòng lặp vô hạn; lý do dừng (đạt target / hết tin / đo lỗi / hết vòng lặp) luôn được log.
- `message_reactions` có `ON DELETE CASCADE` theo `messages.id` nên xóa tin nhắn không để lại reaction mồ côi.

### ⚠️ Kiểm thử ngưỡng lưu trữ — KHÔNG làm trên database Render production

Không cố tình đẩy database Render thật lên 80/90/95/99% để test. Thay vào đó:

- **Unit test (không cần Postgres, chạy được ngay)**: `npm test` — kiểm tra toàn bộ logic phân loại ngưỡng (`storage-policy.js`) bằng tỷ lệ dung lượng **giả lập** 0%→100%, bao gồm đúng 10 trường hợp bắt buộc (0%, 79%, 80%, 89%, 90%, 94%, 95%, 98%, 99%, 100%) và validate cấu hình ngưỡng.
- **Integration test (cần Postgres thật, KHÔNG dùng DB production)**: `npm run test:integration` — đọc biến `TEST_DATABASE_URL` riêng biệt (không bao giờ trùng với `DATABASE_URL` mà app dùng), dùng bảng tạm rồi tự xóa, tự `SKIP` nếu chưa đặt biến này. Ví dụ chạy với Postgres tạm qua Docker:
  ```
  docker run --rm -e POSTGRES_PASSWORD=test -p 5433:5432 -d postgres:16
  TEST_DATABASE_URL=postgres://postgres:test@localhost:5433/postgres npm run test:integration
  ```
  Các test này xác nhận: thứ tự xóa cũ-nhất-trước tất định, retention 48h, và reaction cascade — bằng SQL thật, không phải mock.

## Cấu trúc

```
server.js               # Express REST API + WebSocket + PostgreSQL + AES-256-GCM + retention
storage-policy.js        # Logic THUẦN TÚY phân loại ngưỡng dung lượng (không Postgres) — dùng chung bởi server.js và unit test
migrations/              # Migration SQL đơn giản, tự chạy khi khởi động (bảng schema_migrations theo dõi)
test/                     # Unit test (storage-policy) + integration test (*.integration.test.js, cần TEST_DATABASE_URL)
public/index.html        # Giao diện SPA (login/register/chat/admin)
public/app.js             # Toàn bộ logic client: auth, nén ảnh, upload, hiển thị, reactions, admin
public/style.css          # Giao diện tối, tông teal/cyan
```

## Chạy local

```bash
npm install
cp .env.example .env   # dien DATABASE_URL, MESSAGE_ENCRYPTION_KEY, v.v.
npm start
```

Mở `http://localhost:3000`.

## Deploy lên Render.com

1. **Đẩy code lên GitHub**: push toàn bộ thư mục này (đã có `.gitignore`).
2. **Tạo PostgreSQL trên Render**: Dashboard → New → PostgreSQL. Copy **Internal Database URL**. Ghi nhớ dung lượng gói (vd Free ~1GB) để điền `DB_STORAGE_LIMIT_MB`.
3. **Tạo Web Service trên Render**: kết nối repo GitHub.
   - Build Command: `npm install`
   - Start Command: `npm start`
4. Tab **Environment**, thêm:
   - `DATABASE_URL` — Internal Database URL ở bước 2
   - `JWT_SECRET` — chuỗi ngẫu nhiên dài, bí mật
   - `MESSAGE_ENCRYPTION_KEY` — tạo bằng `openssl rand -base64 32` (**bắt buộc**, server không khởi động nếu thiếu khi production)
   - `NODE_ENV=production`
   - `ADMIN_USERNAME` — tùy chọn, mặc định `do.huy`
   - `ADMIN_PASSWORD` — **bắt buộc** khi production (server từ chối khởi động nếu thiếu), đặt một mật khẩu mạnh
   - `DB_STORAGE_LIMIT_MB` — dung lượng gói Postgres (MB), để bật rolling cleanup
   - (tùy chọn) `MESSAGE_RETENTION_HOURS`, `DB_WARNING_RATIO`, `DB_EMERGENCY_RATIO`, `DB_TARGET_RATIO`, `EMERGENCY_DELETE_BATCH_SIZE`, `MAX_IMAGE_BYTES`, `MAX_VIDEO_BYTES`
5. Deploy. Render tự cấp `PORT`.
6. Đăng nhập bằng tài khoản admin, đăng ký thử vài tài khoản khác để kiểm tra luồng duyệt.

## STEP 2.1 — Audit & hardening (storage safety)

STEP 2.1 audit lại toàn bộ implementation storage-safety ở trên (không giả định report của bước trước đúng), và sửa các vấn đề tìm được:

- **Cảnh báo 80% chưa từng được log** — `DB_WARNING_RATIO` chỉ được định nghĩa/validate nhưng không có code nào thực sự log cảnh báo khi usage vào vùng 80–90%. Đã thêm `checkStorageAndMaybeCleanup()`, chạy mỗi chu kỳ cleanup (10 phút), log `[STORAGE WARNING]` một lần khi vừa vào vùng cảnh báo (không spam log nếu vẫn ở nguyên trạng thái nhiều giờ).
- **Thứ tự xóa chưa thực sự tất định** — trước đây chỉ `ORDER BY created_at ASC`; nhiều tin có thể trùng `created_at` (gửi liên tiếp), lúc đó Postgres không đảm bảo thứ tự vật lý. Đã sửa thành `ORDER BY created_at ASC, id ASC` ở cả `normalRetentionCleanup` và `emergencyStorageCleanup`.
- **Đo dung lượng thất bại có thể treo request** — `checkStorageGuard()` trước đây `await` thẳng một query có thể throw mà không có try/catch bọc ngoài; nếu `pg_database_size()` lỗi tạm thời, request có thể không bao giờ nhận được response. Đã tách rõ 3 trạng thái (`disabled` / `error` / đo thành công) và xử lý fail-closed cho media, fail-open cho text (xem bảng ngưỡng ở trên).
- **Cache 30 giây có thể bị lợi dụng gần ngưỡng hard-block** — nhiều upload đồng thời trong cửa sổ cache có thể cùng vượt ngưỡng mà không ai bị chặn. Đã thêm quy tắc: trong phạm vi 3 điểm % dưới `DB_HARD_BLOCK_MEDIA_RATIO`, luôn đo lại thật thay vì tin cache.
- **Cấu hình ngưỡng sai chỉ warn, không fail-fast** — đã đổi thành từ chối khởi động (`process.exit(1)`) nếu quan hệ `0 < TARGET < EMERGENCY`, `0 < WARNING < EMERGENCY`, `EMERGENCY <= HARD_BLOCK_MEDIA <= HARD_BLOCK_TEXT` bị vi phạm.
- **`.env.example` chứa mật khẩu admin thật (`14503246`)** — đây cũng là fallback mặc định hard-code trong `server.js`, nghĩa là quên đặt `ADMIN_PASSWORD` trên Render sẽ tạo tài khoản admin với mật khẩu đã lộ trong repo. Đã áp dụng đúng pattern fail-fast sẵn có cho `JWT_SECRET`/`MESSAGE_ENCRYPTION_KEY`: server từ chối khởi động ở production nếu thiếu `ADMIN_PASSWORD`.
- **Logic phân loại ngưỡng không thể unit-test được** — `server.js` gọi `process.exit(1)` ngay khi load nếu thiếu `DATABASE_URL`/`JWT_SECRET`/`MESSAGE_ENCRYPTION_KEY`, nên không thể `require('./server.js')` an toàn trong test. Đã tách logic phân loại thuần túy ra `storage-policy.js` (không Postgres, không side-effect) — xem mục kiểm thử ở trên.

Các phần **không đổi** (đã đúng từ trước, chỉ audit xác nhận): `VACUUM (ANALYZE)` best-effort đúng cách (không phải `VACUUM FULL`, không chạy trong request), `cleanupRunning` + `try/finally` chống chạy chồng, `message_reactions ON DELETE CASCADE`, index `idx_messages_created_at`, hard-block kiểm tra **trước** khi nhận multipart upload, giới hạn ảnh/video 500KB/10MB, kiến trúc mã hóa AES-256-GCM.

## STEP 2.2 — Configuration validation (audit finding sau STEP 2.1)

Audit lại STEP 2.1 phát hiện: dù đã có `validateThresholds()` fail-fast cho *quan hệ* giữa các ngưỡng, việc **đọc** từng biến môi trường vẫn dùng pattern `parseFloat(process.env.X) || default` / `parseInt(process.env.X, 10) || default`. Pattern này âm thầm nuốt mọi giá trị falsy:

- `DB_WARNING_RATIO=0` → `parseFloat("0")` là `0` (falsy) → `0 || 0.80` → **âm thầm thành `0.80`**, `validateThresholds()` không bao giờ thấy giá trị `0` thật sự được cấu hình.
- `DB_WARNING_RATIO=abc` → `parseFloat("abc")` là `NaN` (falsy) → cũng âm thầm thành `0.80`.
- `DB_STORAGE_LIMIT_MB=abc` → `parseInt("abc", 10)` là `NaN` → `if (!DB_STORAGE_LIMIT_MB)` coi như **chưa cấu hình** → tắt luôn rolling cleanup/hard-block mà người vận hành tưởng đã bật.

Đã sửa bằng `parseEnvNumber()` (`storage-policy.js`, hàm thuần túy, có unit test riêng) phân biệt rõ 3 trường hợp:

1. **Chưa cấu hình** (`undefined`/`null`/chuỗi rỗng sau `trim()`) → dùng giá trị mặc định.
2. **Có cấu hình nhưng không phải số hợp lệ** (`"abc"`, `"12abc"`) → `throw Error` → server từ chối khởi động (`process.exit(1)`), không còn âm thầm fallback.
3. **Có cấu hình, là số, nhưng vi phạm ràng buộc** (âm, không nguyên khi cần nguyên, hoặc dưới `min`) → `throw Error` → fail-fast. Riêng `0`/số âm cho các ngưỡng tỉ lệ (`DB_WARNING_RATIO`...) được giữ nguyên giá trị thật và để `validateThresholds()` bắt lỗi (đúng vùng trách nhiệm sẵn có), thay vì bị nuốt trước khi tới bước validate.

Áp dụng cho toàn bộ biến số trong cấu hình: `MESSAGE_RETENTION_HOURS`, `DB_STORAGE_LIMIT_MB` (đặc biệt: `0`/`"abc"` FAIL, chỉ *thực sự không set* mới hợp lệ để tắt tính năng), `DB_WARNING_RATIO`, `DB_EMERGENCY_RATIO`, `DB_TARGET_RATIO`, `DB_HARD_BLOCK_MEDIA_RATIO`, `DB_HARD_BLOCK_TEXT_RATIO`, `EMERGENCY_DELETE_BATCH_SIZE`, `MAX_CLEANUP_ITERATIONS`, `MAX_IMAGE_BYTES`, `MAX_VIDEO_BYTES`.

11 unit test mới trong `test/storage-policy.test.js` (tổng 29/29 PASS) tái hiện đúng các ví dụ audit yêu cầu: `DB_WARNING_RATIO=0`, `DB_WARNING_RATIO=abc`, `DB_EMERGENCY_RATIO=-1`, `DB_STORAGE_LIMIT_MB=abc`, `DB_STORAGE_LIMIT_MB=0`, `MAX_CLEANUP_ITERATIONS=abc` — tất cả đều chứng minh **không** còn âm thầm rơi về default.

## STEP 3.1 — Authentication, Authorization & IDOR Security Hardening

Audit toàn bộ authentication/authorization/IDOR (xem báo cáo chi tiết trong PR/commit liên quan). Phát hiện quan trọng nhất:

**Lỗ hổng: JWT "đóng băng" role/status tại thời điểm đăng nhập, không có cơ chế thu hồi.**
Trước STEP 3.1, `authRequired` (HTTP) và bước xác thực WebSocket chỉ verify **chữ ký** JWT rồi tin thẳng `role`/`status` nằm sẵn trong payload — giá trị này được ký cố định lúc đăng nhập và JWT có hạn tới **30 ngày**. Hệ quả: nếu admin **revoke** hoặc **xóa** một tài khoản, token cũ (vẫn hợp lệ về chữ ký) **tiếp tục được coi là approved/còn tồn tại cho tới khi JWT tự hết hạn** — không phải cho tới khi admin thao tác.

**Fix:** JWT giờ chỉ còn dùng để xác thực **danh tính** (id nào đang gọi, chữ ký hợp lệ). Toàn bộ `role`/`status` dùng cho **authorization** đều được đọc lại **trực tiếp từ database** trên mỗi request (`authRequired`) và mỗi lần mở kết nối WebSocket — không nơi nào trong code còn tin `role`/`status` lấy thẳng từ payload JWT. Chi phí: 1 query nhỏ mỗi request, chấp nhận được với quy mô chat nội bộ, và là cách đơn giản nhất để đóng hoàn toàn "cửa sổ" JWT cũ mà **không cần xây thêm hạ tầng session/token-blacklist/Redis riêng**.

Các điểm khác đã audit & siết chặt cùng STEP này:
- **WebSocket**: pending/revoked user không còn được phép mở kết nối mới (trước đây bất kỳ token hợp lệ chữ ký nào cũng connect được, chỉ bị lọc ở bước broadcast). Đóng bằng mã `4003` (not_approved) / `4002` (account_deleted).
- **Socket đang mở sẵn khi bị revoke/xóa giữa chừng**: heartbeat 30s có sẵn (ping/pong) được tận dụng thêm để làm tươi trạng thái từng kết nối đang mở và chủ động đóng nếu không còn hợp lệ — giới hạn "cửa sổ" còn sót lại xuống tối đa ~30s thay vì tới 30 ngày (đã ghi rõ đây là trade-off được chấp nhận, không xây cơ chế revoke tức thời phức tạp hơn).
- **Đăng ký tài khoản**: xác nhận `role`/`approved`/`status` gửi kèm trong body register đều bị bỏ qua hoàn toàn — không có đường nào để tự nâng quyền qua request.
- **IDOR**: message/media/reply/reaction đều đã dùng đúng model "global chat, mọi approved user đọc được mọi tin" như thiết kế hiện tại — không có endpoint nào lộ dữ liệu ngoài phạm vi này. Identity dùng cho reaction luôn lấy từ token (`req.user.username`), không tin `username`/`userId` gửi trong body.
- Validate chặt hơn cho `afterId`/`beforeId` (loại `0`, số âm, `NaN` khỏi các nhánh query thay vì chỉ dựa vào truthy-check của JS).

Test mới: `test/auth-security.integration.test.js` (bộ test toàn diện nhất, chạy bằng PostgreSQL thật qua `TEST_DATABASE_URL`, tự SKIP nếu chưa cấu hình — xem hướng dẫn chạy ở đầu file) — bao phủ: thiếu/sai/hết hạn/giả mạo chữ ký token, đăng ký không tự nâng quyền được, pending bị chặn, thường dân gọi admin API bị 403, **stale JWT sau revoke/xóa bị từ chối ngay** (2 test cốt lõi chứng minh fix), admin xóa tin nhắn đúng quyền, reaction không tin identity từ body, `afterId` với giá trị bất thường không crash server, và toàn bộ ma trận xác thực WebSocket (thiếu token / sai / hết hạn / pending bị từ chối connect / approved connect được / token của tài khoản đã xóa không mở được kết nối mới).

## STEP 3.2 — Input Validation, XSS, Injection & Upload/Media Security

Audit toàn bộ input từ client (body/query/path param/multipart) và pipeline xử lý media, dựa trên source đã hoàn thành STEP 3.1. Không rewrite `server.js`/`app.js`, không đổi kiến trúc DB/mã hóa/JWT/WebSocket — chỉ sửa những phần cần thiết cho security.

**Phát hiện quan trọng nhất: MIME type của ảnh/video KHÔNG hề được xác minh bằng nội dung file.** Trước STEP này, route upload chỉ kiểm tra `req.file.mimetype` — tức `Content-Type` do **chính client khai báo** trong multipart form — rồi tin thẳng đó là loại file thật (chỉ riêng nhánh HEIC là có kiểm magic-bytes từ trước). Một attacker bỏ qua hoàn toàn frontend, gửi thẳng HTTP request với 1 file bất kỳ (kể cả file thực thi) nhưng khai `Content-Type: image/jpeg`, sẽ được server chấp nhận, mã hóa, lưu vào PostgreSQL và phát lại cho mọi người dùng khác dưới danh nghĩa "ảnh". Đã thêm kiểm tra **magic bytes / file signature** thật sự cho từng mimetype được khai báo (JPEG `FF D8 FF`, PNG `89 50 4E 47...`, GIF `GIF87a`/`GIF89a`, WebP `RIFF....WEBP`, MP4/QuickTime container ISO-BMFF `ftyp`, WebM/MKV header EBML `1A 45 DF A3`) — file nào có Content-Type không khớp nội dung thật bị từ chối `400` trước khi đụng tới bước mã hóa/lưu trữ. Logic này (và các hàm validation khác) được tách sang `input-validation.js` (không phụ thuộc Express/Postgres) để unit-test độc lập, giống đúng pattern đã dùng cho `storage-policy.js` ở STEP 2.1.

Các vấn đề khác đã audit & sửa:

- **Validate ID bằng `parseInt()` là "lỏng lẻo nguy hiểm"**: `parseInt("-1", 10) === -1` (truthy trong JS!) và `parseInt("1abc", 10) === 1` (âm thầm cắt bỏ phần chữ) trước đây có thể lọt qua các kiểm tra kiểu `if (!id)`. Đã thêm `parsePositiveIntStrict()`/`parseNonNegativeIntStrict()` (regex khớp CHÍNH XÁC toàn bộ chuỗi số dương, có giới hạn độ dài chống tràn `Number.MAX_SAFE_INTEGER`) và áp dụng cho **mọi** nơi nhận ID từ client: `:id` (media/delete/react/admin approve-revoke-delete), `limit`/`afterId`/`beforeId` (query), `replyToId` (body). Định dạng sai → `400` rõ ràng thay vì suy đoán/âm thầm bỏ qua.
- **Message text có thể chứa control character "vô hình"** (null byte, ANSI escape...) — đã chặn bằng whitelist ngược `DISALLOWED_CONTROL_CHARS_RE` (vẫn cho phép `\n`/`\t`/`\r` và toàn bộ Unicode/emoji hợp lệ).
- **JSON body sai kiểu** (`{"message": {}}`, `{"message": []}`) — route `POST /api/messages` đã có `typeof text !== 'string'` từ trước (audit xác nhận đã đúng), giữ nguyên; bổ sung thêm kiểm tra `typeof emoji !== 'string'` tường minh ở route reaction (trước đó dựa ngầm vào hành vi `Array.includes()`, vẫn an toàn nhưng không tường minh).
- **Prototype pollution**: audit xác nhận source hiện tại **không có** `Object.assign(...)`/`{...req.body}`/`for..in` nào merge trực tiếp `req.body` vào user/admin/config model — rủi ro hiện tại thấp. Vẫn thêm middleware `rejectDangerousKeys` chặn tường minh key `__proto__`/`constructor`/`prototype` ở tầng chung, phòng trường hợp code sau này vô tình thêm 1 chỗ merge object.
- **SQL Injection**: audit toàn bộ `pool.query(...)` trong `server.js` — 100% đã dùng parameterized query (`$1, $2...`), không có bất kỳ string concatenation/template literal nào chèn trực tiếp giá trị từ client vào câu SQL. Không cần sửa.
- **XSS (message/mention/reply)**: audit `public/app.js` — toàn bộ nội dung động (text tin nhắn, mention, reply preview, tên người gửi) đều render qua `textContent`/`escapeHtml()` hoặc `el()` (helper dùng `textContent`), **không** có chỗ nào ghép chuỗi chưa escape vào `innerHTML`. Chỉ có duy nhất 1 nơi dùng `innerHTML` với nội dung động (render tin nhắn + mention), và nội dung đó đã qua `escapeHtml()` trước khi ghép — an toàn. Không cần sửa code, chỉ xác nhận bằng audit + test.
- **`X-Content-Type-Options: nosniff`**: thêm cho **mọi** response (áp dụng cả cho `GET /api/messages/:id/media`), tránh trình duyệt tự suy đoán 1 file do attacker kiểm soát nội dung thành HTML/JS khi hiển thị inline.
- **Filename không bao giờ được lưu/phản chiếu**: audit xác nhận `req.file.originalname` chỉ dùng để kiểm tra đuôi `.heic`/`.heif`, không hề được lưu vào DB hay đưa vào bất kỳ HTTP header nào (route media download không set `Content-Disposition`) — bề mặt tấn công path traversal/header injection qua filename gần như không tồn tại với kiến trúc lưu media trong PostgreSQL `BYTEA` hiện tại (không có filesystem path nào do client kiểm soát).
- **HEIC conversion resource limits**: `heic-convert` (libheif/WASM) không expose timeout/resource-limit trực tiếp, và kiến trúc hiện tại (1 process Node, không worker riêng) **không được thay đổi** trong STEP này (đúng theo giới hạn phạm vi §22). Đã bọc lệnh gọi bằng `Promise.race` + timeout 15s để request handler không bao giờ treo vô hạn với 1 file HEIC độc hại — đây là lớp phòng thủ "best effort" ở mức request/response, **không** đảm bảo thu hồi được CPU/memory đã tiêu tốn bởi phép tính WASM đang chạy (giới hạn cố hữu của JavaScript đơn luồng). Retry đã có sẵn từ trước bị giới hạn tối đa 2 lần (giảm quality), không lặp vô hạn.
- **Decompression bomb (kích thước ảnh sau giải mã)**: server hiện không dùng thư viện xử lý ảnh nào (`sharp`...) có khả năng đọc kích thước trước khi giải mã toàn bộ — thêm 1 thư viện lớn chỉ cho việc này nằm ngoài phạm vi STEP 3.2 (theo đúng nguyên tắc §23: không thêm framework nặng nếu không cần). **Đây là known limitation**, ghi nhận rõ ở mục "Remaining Issues" bên dưới thay vì âm thầm bỏ qua.

Test mới:
- `input-validation.js` — module thuần túy (không Express/Postgres/network), chứa toàn bộ logic validation ở trên.
- `test/input-validation.test.js` — unit test cho `input-validation.js`, chạy bằng `npm test`, **không cần `npm install` xong** vì không phụ thuộc gì ngoài Node built-in (`node:test`, `node:assert`) — bao phủ đúng ma trận STEP 3.2 §33 (ID hợp lệ/không hợp lệ, control character, magic bytes đúng/giả mạo, prototype pollution).
- `test/security-hardening.integration.test.js` — integration test qua HTTP thật (SQLi, XSS payload lưu/trả nguyên vẹn, ID validation trên từng endpoint, JSON body sai kiểu, reaction whitelist, upload MIME giả mạo), chạy bằng PostgreSQL thật qua `TEST_DATABASE_URL`, tự SKIP nếu chưa cấu hình — cùng pattern với `test/auth-security.integration.test.js`.
- 1 assertion trong `test/auth-security.integration.test.js` (`afterId/beforeId bất thường không làm crash server`) được nới từ "chỉ chấp nhận 200/500" thành "chấp nhận 200/400/500", vì hành vi ĐÚNG sau STEP 3.2 là trả `400` rõ ràng cho định dạng sai — vẫn giữ đúng tinh thần bài test gốc (không crash), chỉ phản ánh validation đã chặt hơn.

## STEP 3.3 — Rate Limiting, Abuse Protection & WebSocket Hardening

Bước cuối của STEP 3 — Security Hardening. Audit toàn bộ HTTP/WebSocket attack surface (login, register, message, upload, admin, WS connect/message) trước khi sửa, dựa trên source đã hoàn thành STEP 3.1/3.2. Không đổi kiến trúc DB/mã hóa/JWT, không thêm Redis/CAPTCHA/reverse proxy/WAF (đúng nguyên tắc §41: harden kiến trúc hiện có, không overengineer).

**Kiến trúc rate limiter**: `rate-limit.js` — module thuần túy (không Express/Postgres/network), 2 lớp nguyên thủy:
- `RateLimiter` — bộ đếm fixed-window O(1)/request (`consume`/`peek`/`reset`/`sweep`), dùng cho mọi giới hạn "N lần / cửa sổ thời gian" (login, register, message, upload theo phút/giờ, WS connect attempts, WS message).
- `ConcurrencyGuard` — bộ đếm "task đang chạy" sống (`tryAcquire`/`release`), dùng cho giới hạn đồng thời (concurrent uploads, concurrent WS connections).

Toàn bộ state nằm **trong bộ nhớ 1 process** — chấp nhận được vì deployment hiện tại chỉ chạy 1 Node process trên Render (không có bằng chứng multi-instance trong project). **Known limitation ghi rõ**: nếu sau này scale ra nhiều instance sau 1 load balancer, mỗi instance giữ state rate-limit riêng — 1 attacker rải request qua nhiều instance có thể đạt giới hạn gấp N lần cấu hình. Thiết kế API tối thiểu (`consume/tryAcquire/release/reset/sweep`) để sau này có thể thay bằng Redis-backed implementation mà không cần sửa code gọi ở `server.js`.

**Áp dụng cụ thể** (tất cả ngưỡng có thể chỉnh qua `.env`, fail-fast nếu cấu hình sai — xem `.env.example`):

| Bảo vệ | Cơ chế | Vị trí |
|---|---|---|
| Login brute-force | 2 lớp: IP + account, **atomic admission** (`tryConsume()` gọi ngay lập tức trước mọi `await` — xem "STEP 3.3 FIX" bên dưới), chống timing-based account enumeration bằng dummy bcrypt hash | `POST /api/auth/login` |
| Đăng ký spam | IP: 20 request/giờ (đếm mọi attempt, kể cả bị từ chối validation) | `POST /api/auth/register` |
| Spam tin nhắn | User: burst 5/5s + 30/phút | `POST /api/messages` |
| Spam upload | User: 5/phút + 20/giờ | `POST /api/messages/media` |
| Upload đồng thời | User: 2, IP: 5 (`ConcurrencyGuard`, giải phóng qua `try/finally` + `req.on('close', ...)` an toàn cho mọi đường thoát: lỗi validation/multer/HEIC/DB/client ngắt kết nối giữa chừng) | `POST /api/messages/media` |
| WS connection flood | IP: 10 lần thử/phút + tối đa 5 kết nối đang mở đồng thời/IP (kiểm tra TRƯỚC cả bước xác thực JWT) | `wss.on('connection', ...)` |
| WS frame quá khổ | `maxPayload: 64KB` ở tầng thư viện `ws` — tự đóng kết nối mã 1009 trước khi code ứng dụng đọc được nội dung | khởi tạo `WebSocketServer` |
| WS message flood/malformed | Rate-limit 30/phút/user + `try/catch` JSON.parse an toàn | `ws.on('message', ...)` (mới thêm — xem ghi chú kiến trúc bên dưới) |

**Ghi chú kiến trúc quan trọng — WebSocket message**: audit xác nhận `public/app.js` **không bao giờ tự gửi dữ liệu qua WebSocket** (chỉ nhận qua `ws.onmessage`; toàn bộ chat/reaction/upload đi qua HTTP REST). Trước STEP 3.3, server hoàn toàn không có `ws.on('message', ...)` — không phải lỗ hổng, mà là kiến trúc "server chỉ push". STEP 3.3 thêm 1 handler phòng thủ thuần túy (parse an toàn, rate-limit, không xử lý bất kỳ message type nào) để chứng minh cụ thể "malformed WS message không crash server" bằng test thật, không phải suy luận suông — đây là "no-op consumer", không phải tính năng mới.

**Security headers** (audit trước khi viết CSP — không áp đặt mù quáng): quét `public/index.html`/`app.js`/`style.css` xác nhận **chỉ 1 CDN bên ngoài** (`cdn.jsdelivr.net` cho `heic2any`), không có `<script>`/`<style>` inline, không `eval()`/`new Function()`, không `data:` URI, media hiển thị qua `blob:` (từ `createObjectURL`). Nhờ vậy CSP có thể strict mà không cần `unsafe-inline`/`unsafe-eval`:

```
default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; worker-src 'self' blob:;
style-src 'self'; img-src 'self' blob:; media-src 'self' blob:; connect-src 'self';
object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'
```

**Production fix (2026-09-14)**: sau khi lên production, `heic2any` báo lỗi CSP chặn việc tạo Web Worker (`Creating a worker from 'blob:...' violates ... script-src`). Nguyên nhân: `heic2any` tự tạo Worker từ 1 `blob:` URL (kỹ thuật đóng gói worker code inline trong 1 file `.min.js` duy nhất) — hành vi này nằm **bên trong thư viện CDN**, không phải thứ code của chính app gọi trực tiếp, nên đợt audit ban đầu (chỉ quét `public/*`) không phát hiện ra. CSP kiểm tra việc tạo worker theo directive `worker-src`; vì CSP ban đầu không khai báo `worker-src` riêng, trình duyệt **fallback về `script-src`** (đúng theo spec CSP Level 3) — và `script-src` không cho phép `blob:`, nên worker bị chặn, HEIC client-side conversion thất bại hoàn toàn. Đã thêm `worker-src 'self' blob:` — **tách riêng**, không mở rộng `script-src` (giữ `script-src` hẹp như cũ, chỉ cho phép đúng 1 CDN cần thiết, không mở rộng bề mặt cho `<script>`/injection thường).

Kèm `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` (tắt geolocation/camera/microphone/payment/usb..., **giữ nguyên** clipboard-write vì nút "Copy" đang dùng). **Known limitation**: `cdn.jsdelivr.net` vẫn là dependency ngoài trong `script-src` — nếu mạng công ty chặn CDN này, HEIC client-side conversion thất bại nhưng rơi xuống server-side fallback có sẵn (không vỡ UI). Đề xuất follow-up: vendor hóa `heic2any.min.js` vào `public/vendor/` để siết CSP chặt hơn nữa (chưa làm ở STEP này — ngoài phạm vi). **Bài học rút ra**: khi audit CSP cho 1 thư viện CDN bên thứ ba, không chỉ quét code của chính mình — thư viện có thể có hành vi runtime nội bộ (tạo worker, mở iframe, gọi API khác...) không thấy được qua audit tĩnh; cách chắc chắn nhất vẫn là kiểm thử thực tế trên production/staging trước khi coi CSP là hoàn chỉnh.

**Production fix #2 (2026-09-14, cùng ngày)**: sau khi thêm `worker-src`, lỗi tiếp theo xuất hiện: `Uncaught EvalError: ... 'unsafe-eval' is not an allowed source` — bên trong Worker mà `heic2any` vừa tạo được, thư viện gọi `new Function(...)` (dynamic eval), bị `script-src` chặn (không có `worker-src` riêng cho phép eval — CSP không có cách nào cho phép eval chỉ trong worker mà giữ trang chính chặt). **Quyết định: KHÔNG thêm `'unsafe-eval'` vào CSP** — đây sẽ là làm yếu vĩnh viễn 1 lớp phòng thủ XSS toàn trang chỉ vì hành vi nội bộ của 1 thư viện bên thứ ba, đánh đổi không tương xứng khi server đã có sẵn toàn bộ pipeline convert HEIC dự phòng.

Vấn đề thứ hai phát hiện cùng lúc: log lỗi ghi `"Uncaught EvalError"` (**không** có `"(in promise)"`) — dấu hiệu cho thấy lỗi này xảy ra ở nơi không có gì lắng nghe nó cả, khả năng cao là bên trong Worker mà `heic2any` không tự wire `worker.onerror` để biến thành 1 Promise bị reject đúng cách. Nếu đúng vậy, `await window.heic2any(...)` ở `convertHeicClientSide()` (`public/app.js`) có thể **treo vô hạn** thay vì reject — khiến `try/catch` ở nơi gọi (fallback sang gửi HEIC gốc lên server) **không bao giờ chạy**, và nút "Gửi" bị kẹt im lặng với file HEIC mà không có cảnh báo hay fallback nào.

Fix: bọc `heic2any(...)` bằng `Promise.race()` với 1 giới hạn thời gian chờ tường minh (`HEIC_CLIENT_CONVERT_TIMEOUT_MS = 20000` — cùng nguyên tắc với `HEIC_CONVERT_TIMEOUT_MS` phía server ở STEP 3.2) — nếu quá 20s không có kết quả, chủ động bỏ cuộc và rơi xuống fallback gửi HEIC gốc lên server, **bất kể** nguyên nhân thật sự là promise bị treo vĩnh viễn hay chỉ đơn giản là chậm. Cách này xử lý đúng cả 2 khả năng mà không cần biết chính xác heic2any thất bại theo cơ chế nào. Gắn thêm `.catch(() => {})` vào promise gốc (chỉ để dọn console, không ảnh hưởng luồng xử lý) phòng trường hợp nó settle muộn sau khi đã hết hạn chờ.

**CORS**: audit xác nhận app hiện tại **same-origin thuần túy** (không dùng package `cors`, không set `Access-Control-Allow-Origin` ở đâu cả) — giữ nguyên, không thêm CORS middleware (đúng §18: không đổi CORS nếu project không dùng CORS).

**Error leakage & logging**: audit toàn bộ `console.error(...)` — không log password/JWT/`MESSAGE_ENCRYPTION_KEY`/plaintext message/media content ở bất kỳ đâu; mọi response lỗi cho client chỉ có `{error, message}` chung chung, không leak stack/SQL/filesystem path. Không cần sửa (đã đúng từ trước).

**Dependency audit** (dựa trên kiến thức huấn luyện, KHÔNG tra cứu CVE trực tuyến trong phiên làm việc này — xem "Known limitations"):
- `ws@^8.17.1`: dòng version đã bao gồm bản vá cho lỗ hổng ReDoS qua header (CVE-2024-37890, ảnh hưởng `ws` <8.17.1) — **đã an toàn**, không cần đổi.
- `multer@^1.4.5-lts.1`: đã ở nhánh LTS đã vá lỗi DoS multipart cũ của dòng 1.x (CVE-2022-24434 vá ở 1.4.4-lts.1) — **đã an toàn**. `multer@2.x` là rewrite lớn (breaking API) — không nâng cấp ở STEP này (đúng §26: không tự ý nâng major version).
- `jsonwebtoken@^9.0.2`: dòng hiện tại đã mặc định từ chối `alg: none`. Bổ sung thêm 1 lớp phòng thủ: `jwt.verify()`/`jwt.sign()` giờ **chỉ định tường minh `algorithms: ['HS256']`** thay vì để thư viện tự suy luận từ header token — không đổi hành vi với token hợp lệ hiện tại, chỉ thu hẹp bề mặt chấp nhận cho chắc chắn.
- `express@^4.19.2`, `pg@^8.11.5`, `bcryptjs@^2.4.3`, `heic-convert@^2.1.0`: không phát hiện vấn đề cần hành động ở nhánh version hiện tại.
- Không có `package-lock.json` trong repo — khuyến nghị commit file này để khóa version chính xác, tái lập build nhất quán và dễ audit hơn (không tự thêm ở STEP này vì cần chạy `npm install` thật để sinh ra, không thể giả lập).

Test mới:
- `rate-limit.js` — module thuần túy, `test/rate-limit.test.js` (28 test, không cần `npm install`/DB) kiểm tra `RateLimiter`/`ConcurrencyGuard`/`getHttpClientIp`/`getWsClientIp`/`normalizeIp` (ngưỡng, per-key độc lập, reset, sweep, memory-safety cơ bản, try/finally an toàn khi có exception giữa chừng, atomic admission).
- `test/security-headers.test.js` — kiểm tra header thật qua `http.createServer(app)` riêng của test, **chỉ cần `npm install`, KHÔNG cần Postgres/`TEST_DATABASE_URL`** (chỉ gọi route tĩnh/SPA-fallback không chạm DB) — tự SKIP với thông báo rõ ràng nếu `npm install` chưa chạy.
- `test/websocket-security.integration.test.js` — auth WS (regression STEP 3.1) + connection flood + malformed/oversized message, cần `TEST_DATABASE_URL`.
- `test/abuse-protection.integration.test.js` — login brute-force (2 lớp + reset + anti-enumeration), register flood, message spam (burst + reset sau cửa sổ), upload rate + concurrency (kể cả giải phóng counter sau khi hoàn tất), cần `TEST_DATABASE_URL`.
- Nới rate-limit qua biến môi trường trong `test/auth-security.integration.test.js` và `test/security-hardening.integration.test.js` (STEP 3.1/3.2) vì các test đó gửi nhiều request/kết nối WS liên tiếp rất nhanh cho mục đích khác (không phải test rate-limit) — tránh 429/4008/4009 "giả" làm sai lệch kết quả không liên quan.

### STEP 3.3 FIX — Final Hardening (audit cuối cùng phát hiện thêm 3 vấn đề)

Sau khi hoàn thành bảng trên, 1 vòng audit cuối phát hiện 3 vấn đề cần sửa dứt điểm trước khi chuyển sang STEP 4:

**1. Race condition ở login rate-limit (đã sửa).** Phiên bản trước dùng `peek()` (không tăng bộ đếm) *trước* khi query DB/bcrypt, rồi chỉ `consume()` (tăng bộ đếm thật) *sau* khi biết kết quả — nghĩa là N request đăng nhập đồng thời đều có thể "nhìn thấy" cùng 1 giá trị quota còn trống và cùng được phép chạy `bcrypt.compare()` (rất tốn CPU) trước khi bất kỳ request nào trong số đó thực sự tăng bộ đếm, làm mất tác dụng chống brute-force và mở đường cho CPU DoS. Đã sửa: gọi `tryConsume()` (bí danh của `consume()`, cùng 1 phép toán **đồng bộ hoàn toàn, không có `await` bên trong**) **ngay lập tức** cho cả IP-limiter và account-limiter, **trước** bất kỳ `await` nào (query DB, `bcrypt.compare()`). Vì JavaScript đơn luồng và hàm này không bao giờ nhường quyền thực thi giữa bước đọc và bước tăng bộ đếm, không có cách nào 2 lệnh gọi đồng thời "chen" vào nhau — lệnh gọi thứ N+1 luôn thấy kết quả đã bao gồm đúng N lệnh gọi trước đó. Do "reservation" giờ xảy ra trước khi biết thành công/thất bại, **mọi lần gọi** (thành công lẫn thất bại) đều tính vào bộ đếm; khi login thành công, bộ đếm account-level được `reset()` lại (đúng yêu cầu cũ), bộ đếm IP-level thì không bao giờ reset (chủ ý — tránh attacker "rửa" quota IP chỉ bằng 1 lần đăng nhập đúng xen giữa nhiều lần sai). Test: `test/rate-limit.test.js` có 1 test mô phỏng "20 request đồng thời" bằng cách gọi `tryConsume()` liên tiếp không có `await` xen giữa (chứng minh tính atomic ở mức đơn vị, hoàn toàn deterministic — không phụ thuộc scheduling); `test/abuse-protection.integration.test.js` có 1 test gửi **20 request HTTP thật đồng thời** (`Promise.all`) tới cùng 1 account và khẳng định **chính xác** `LOGIN_RATE_LIMIT_ACCOUNT_MAX` request được "admission" (401 thật) — không hơn — chứng minh ở mức tích hợp thật qua mạng.

**2. Timing-based account enumeration (đã sửa).** Trước đây, nhánh "username không tồn tại" bỏ qua hoàn toàn `bcrypt.compare()`, trong khi nhánh "username tồn tại + sai mật khẩu" luôn chạy nó — chênh lệch hàng chục mili-giây (chi phí tính toán bcrypt cost=10) này là 1 timing side-channel đủ để attacker đo và suy ra username nào tồn tại trong hệ thống, dù response/status đã giống hệt nhau. Đã sửa: thêm hằng số `DUMMY_PASSWORD_HASH` — 1 bcrypt hash **cố định, hợp lệ, tạo sẵn 1 lần** (không phải tạo mới mỗi request, vì vậy sẽ tự gây ra 1 độ trễ CPU khác biệt, phản tác dụng) — dùng làm "mật khẩu giả" để `bcrypt.compare()` luôn thực hiện đủ chi phí CPU dù username có tồn tại hay không. Kết quả so sánh với dummy hash **không bao giờ** được dùng để quyết định thành công/thất bại khi username không tồn tại — luôn là thất bại, bất kể `bcrypt.compare()` trả về gì. Test: `test/abuse-protection.integration.test.js` có test xác nhận status/error/message/cấu trúc body **giống hệt nhau tuyệt đối** giữa "username tồn tại + sai mật khẩu", "username không tồn tại", và cả "username tồn tại nhưng đang pending + sai mật khẩu" (không leak trạng thái tài khoản qua bất kỳ khác biệt nào trong response).

**3. WebSocket IP / X-Forwarded-For trust model — SUPERSEDED, xem "FINAL STEP 3.3 FIX" bên dưới.** (Vòng sửa này đổi `getClientIp()` leftmost → `getHttpClientIp()`/`getWsClientIp()` rightmost dựa trên giả định "Render = đúng 1 hop proxy". Audit tiếp theo phát hiện giả định "đúng 1 hop" cho 1 PaaS công khai như Render là không đủ chắc chắn — toàn bộ cách tiếp cận dựa-trên-đếm-hop đã bị **thay thế hoàn toàn**, không chỉ vá thêm, bởi thiết kế CF-Connecting-IP có kiểm soát mô tả trong "FINAL STEP 3.3 FIX".)

**4. Audit lại toàn bộ abuse protection sau khi sửa** — xác nhận (bằng `grep` toàn bộ `server.js`) không còn bất kỳ chỗ nào khác dùng pattern `peek()` trước `await` — login là nơi DUY NHẤT từng có vấn đề này; register/message/upload/WS đều đã dùng `consume()`/`tryAcquire()` đồng bộ ngay đầu handler từ trước. Không phát hiện bypass mới sau khi sửa.

### FINAL STEP 3.3 FIX — Client IP Trust Model (Cloudflare / CF-Connecting-IP)

Vòng audit thứ 3 (cuối cùng trước STEP 4) chỉ ra rằng thiết kế "rightmost X-Forwarded-For, giả định Render = đúng 1 hop proxy" (mục 3 ở trên) tự nó vẫn là 1 giả định rủi ro: Render là 1 PaaS công khai, không có gì đảm bảo kiến trúc mạng thực tế phía trước app luôn là *đúng 1* lớp proxy (có thể có thêm CDN như Cloudflare, hoặc nhiều lớp proxy nội bộ khác) — đếm sai số hop làm sai luôn IP được chọn.

**Thiết kế lại hoàn toàn** (không phải vá thêm — bỏ hẳn cách tiếp cận cũ):

- **Bỏ hoàn toàn `X-Forwarded-For` khỏi đường dẫn tin cậy.** Header này không còn được đọc ở bất kỳ đâu để đưa ra quyết định rate-limit, bất kể leftmost hay rightmost — cách "đếm hop" tự nó không đáng tin khi không biết chắc chắn số hop.
- **`CF-Connecting-IP` (header do chính Cloudflare edge *ghi đè*, không phải *append*) là nguồn IP duy nhất được cân nhắc thay thế**, nhưng **chỉ khi được bật tường minh** qua biến môi trường mới `TRUST_CF_CONNECTING_IP` (mặc định **`false`** — an toàn). Header phải qua validate nghiêm ngặt bằng `net.isIP()` (Node builtin, không cần thêm thư viện) trước khi dùng — từ chối rỗng/whitespace/nhiều giá trị cách nhau bởi dấu phẩy/rác — nếu không hợp lệ, fallback về địa chỉ socket.
- **Mặc định (`TRUST_CF_CONNECTING_IP` chưa bật) — dùng thẳng `req.socket.remoteAddress`** (dữ liệu tầng giao thức TCP, không thể bị client giả mạo qua HTTP header nào cả). Đây là lựa chọn **fail-closed**: có thể quá chặt (nhiều client sau cùng 1 proxy sẽ "trùng" 1 địa chỉ, ảnh hưởng trải nghiệm chứ không phải bảo mật) nhưng không bao giờ bị client bypass.
- `getHttpClientIp(req, options)` và `getWsClientIp(req, options)` giờ dùng **chung một hàm nội bộ** (`resolveTrustedCfConnectingIp`) — đảm bảo HTTP và WS luôn cho ra cùng 1 định danh IP cho cùng 1 client thật (trước đây 2 hàm có logic tách biệt, dễ lệch nhau).
- `app.set('trust proxy', ...)` đổi từ `1` → **`false`** tường minh — Express không còn đọc bất kỳ `X-Forwarded-*` header nào để tính `req.ip`/`req.secure` nữa. Do đó header `Strict-Transport-Security` (thêm ở vòng trước) được sửa để tự đọc `X-Forwarded-Proto` trực tiếp thay vì qua `req.secure` — lựa chọn này an toàn vì hậu quả tệ nhất khi bị đánh lừa chỉ là gửi thêm 1 header vô hại, khác hẳn việc tin sai IP có thể bypass rate-limit.
- `normalizeIp()` giữ nguyên logic cũ (chuẩn hóa `::ffff:x.x.x.x` → `x.x.x.x`, không đụng đến IPv6 thật) — đã đúng từ trước, không cần sửa.

**⚠️ GIỚI HẠN/GIẢ ĐỊNH CÒN LẠI — KHÔNG CLAIM TUYỆT ĐỐI**: hiệu quả của `TRUST_CF_CONNECTING_IP=true` phụ thuộc hoàn toàn vào 1 điều mà **code trong app này không thể tự xác minh**: origin (Render) phải được khóa để **chỉ** nhận kết nối từ dải IP của Cloudflare (không có đường nào khác để client kết nối thẳng tới app bỏ qua Cloudflare). Đây là yêu cầu cấu hình **hạ tầng** (Cloudflare "Full/Strict" + IP allowlist ở origin), không phải thứ ứng dụng tự đảm bảo được. Phiên làm việc này **không xác minh được liệu deployment thực tế của project này có thực sự đặt sau Cloudflare hay không** (không có kết nối mạng để kiểm tra DNS/cấu hình thực tế) — vì vậy:
- Mặc định `TRUST_CF_CONNECTING_IP=false` cho đến khi người vận hành tự xác nhận kiến trúc thật và bật lên.
- README này **không** khẳng định "CF-Connecting-IP luôn đáng tin" hay "Render đảm bảo..." — chỉ mô tả đúng những gì code làm và điều kiện để nó đúng.

Test: `test/rate-limit.test.js` có bộ test đầy đủ cho `isSingleValidIp`/`normalizeIp`/`getHttpClientIp`/`getWsClientIp` (IPv4, IPv4-mapped-IPv6, IPv6, CF-Connecting-IP hợp lệ/không hợp lệ/thiếu, XFF giả mạo không còn tác dụng, HTTP/WS nhất quán) — toàn bộ chạy được và PASS ngay trong sandbox này (không cần DB). `test/websocket-security.integration.test.js` có test xác nhận **lỗi cũ đã được sửa dứt điểm**: gửi `X-Forwarded-For` giả mạo qua kết nối trực tiếp **không còn** cho phép vượt giới hạn concurrent-connection-per-IP (khác hẳn vòng trước, nơi đây từng là 1 giới hạn đã biết).

**Known limitations** (ghi rõ, không giả vờ đã giải quyết hoàn toàn):
1. Rate limiter in-memory chỉ đúng cho kiến trúc 1-process hiện tại — xem ghi chú kiến trúc ở đầu mục này.
2. HEIC conversion timeout (từ STEP 3.2) vẫn là best-effort — **không kill được CPU-bound work đang chạy trong cùng Node.js process**, không phải giải pháp decompression-bomb đầy đủ.
3. Magic-byte validation (STEP 3.2) vẫn không phải full media parser — xác nhận định dạng container, không phân tích toàn bộ cấu trúc file.
4. `multer.memoryStorage()` vẫn cho phép 1 request tối đa ~10MB được buffer vào RAM trước khi bị từ chối — concurrency guard (STEP 3.3) giới hạn SỐ LƯỢNG request đồng thời làm việc này, nhưng không đổi kiến trúc sang disk-based streaming.
5. Khoảng trống lý thuyết trong route upload: nếu client ngắt kết nối đúng lúc `multer` đang đọc dở file (trước khi callback được gọi), `req.on('close', ...)` đảm bảo `ConcurrencyGuard` được giải phóng đúng, nhưng bản thân async function xử lý request đó vẫn có thể còn "treo" trong bộ nhớ đến khi được GC — chấp nhận được cho STEP 3.3, xử lý triệt để hơn cần thay đổi kiến trúc sâu hơn (out of scope).
6. Dependency audit dựa trên kiến thức huấn luyện, KHÔNG tra cứu CVE database trực tuyến trong bất kỳ phiên làm việc nào (môi trường không có mạng) — khuyến nghị chạy `npm audit` thật trước khi deploy production.
7. Các integration test mới (`websocket-security`, `abuse-protection`) được viết và kiểm tra cú pháp/logic cẩn thận nhưng **chưa được thực thi thật trên Postgres** trong bất kỳ phiên làm việc nào (sandbox không có mạng để cài đặt dependency/chạy DB) — cần chạy `TEST_DATABASE_URL=... npm run test:integration` trên môi trường có Postgres trước khi merge.
8. **`TRUST_CF_CONNECTING_IP` là 1 CÔNG TẮC, không phải 1 xác minh tự động** — nếu người vận hành bật nó lên nhưng deployment thực tế KHÔNG thực sự đặt sau Cloudflare (hoặc origin chưa được khóa đúng cách), rate-limit theo IP sẽ bị bypass hoàn toàn. Đây là giới hạn quan trọng nhất còn lại — quyết định bật/tắt biến này nằm ngoài khả năng tự xác minh của source code.
9. Nếu `TRUST_CF_CONNECTING_IP=false` (mặc định) và deployment thực tế CÓ 1 proxy/CDN phía trước app, mọi client đi qua cùng proxy đó sẽ dùng chung 1 "IP" (địa chỉ của proxy) cho mục đích rate-limit — an toàn (không bypass được) nhưng có thể ảnh hưởng trải nghiệm (1 người dùng gây rate-limit có thể ảnh hưởng người khác cùng mạng/proxy).

## STEP 4 — Performance & Resource Optimization

Audit toàn bộ hot path (DB query, upload, WebSocket broadcast, rate limiter) trước khi sửa, ưu tiên P0 (RAM/CPU) → P1 (database) → P2 (client) → P3 (misc) theo đúng thứ tự spec yêu cầu. Không đổi API contract, schema, ngưỡng bảo mật, hay behavior hiện có.

**Phát hiện quan trọng nhất của vòng audit: phần lớn hot path đã được tối ưu tốt từ các STEP trước**, không phải viết lại từ đầu:
- `GET /api/messages` đã dùng **cursor-based pagination** (`WHERE id > $1 ORDER BY id ASC LIMIT $2`, không phải `OFFSET`), không `SELECT *`, và **1 query JOIN duy nhất** lấy reaction cho cả batch tin nhắn qua `json_agg` — không có N+1.
- WebSocket broadcast (`broadcastToApproved`/`broadcastToAdmins`/`notifyUser`) đã `JSON.stringify()` **đúng 1 lần** rồi tái sử dụng cho mọi client — không serialize lặp lại trong vòng lặp.
- Heartbeat 30s (kiểm tra lại role/status DB cho mọi socket đang mở) đã gộp thành **1 query duy nhất** (`WHERE id = ANY($1::int[])`) cho toàn bộ client, không phải 1 query/client.
- Storage guard (`checkStorageGuard`) đã có cache 30s thông minh (tự động bỏ cache khi gần ngưỡng hard-block) để tránh gọi `pg_database_size()` mỗi request.
- Cleanup/retention đã batch đúng (500 dòng/batch, lặp có giới hạn số vòng), dùng `VACUUM (ANALYZE)` (không phải `FULL`), best-effort.
- `pool.connect()` (chỉ dùng cho migration) đã có `try/finally` release đúng — không leak connection.

**Thay đổi thực hiện ở STEP 4** (những khoảng trống thật sự tìm thấy sau audit):

| # | Vấn đề | Vị trí | Thay đổi |
|---|---|---|---|
| 1 | HEIC conversion (WASM, tốn CPU) không có giới hạn đồng thời **toàn cục** — 2 user khác nhau (mỗi người trong quota riêng của STEP 3.3) vẫn có thể cùng lúc convert HEIC, tranh giành CPU trên Render Free | `server.js` route upload | Thêm `ConcurrencyGuard` toàn cục mới (`concurrentHeicConversions`, key cố định `'global'`), cấu hình qua `MAX_CONCURRENT_HEIC_CONVERSIONS` (mặc định 1). Vượt giới hạn → `503` ngay, không xếp hàng chờ. `try/finally` đảm bảo luôn release. |
| 2 | WebSocket broadcast không có backpressure check — 1 client chậm (mạng yếu, tab treo) có thể khiến `ws.bufferedAmount` phình to vô hạn theo thời gian, gây RAM growth không kiểm soát | `server.js` broadcast functions | Thêm `isWsClientOverBuffered()` (predicate thuần túy, export để unit-test) + `sendIfNotOverBuffered()`: nếu 1 client vượt `WS_MAX_BUFFERED_BYTES` (mặc định 1MB), bỏ qua lần gửi đó và chủ động đóng kết nối (mã 1008) thay vì tiếp tục dồn dữ liệu — client tự reconnect qua cơ chế có sẵn ở `public/app.js`. |
| 3 | PostgreSQL connection pool dùng default **ngầm** của thư viện `pg` (`max`/`idleTimeoutMillis`/`connectionTimeoutMillis` không khai báo tường minh) | `server.js` `new Pool(...)` | Khai báo tường minh qua `DB_POOL_MAX`/`DB_POOL_IDLE_TIMEOUT_MS`/`DB_POOL_CONNECTION_TIMEOUT_MS` — **giá trị mặc định giữ nguyên y hệt default cũ của `pg`** (không đổi behavior nếu không cấu hình gì), chỉ làm rõ ràng + có thể tinh chỉnh cho Render Free. |
| 4 | `express.static` phục vụ static assets không có cache header nào — mỗi lần tải lại trang là 1 request GET mới cho `app.js`/`style.css` | `server.js` | Thêm `maxAge: '10m'` — **cố ý KHÔNG đặt dài hơn** vì project hiện không có cơ chế cache-busting (`index.html` tham chiếu thẳng `/app.js`, không có query-string version/hash) — cache quá dài có thể khiến trình duyệt tiếp tục dùng JS/CSS cũ sau khi deploy bản mới. `ETag` (mặc định của Express) vẫn giữ nguyên, cho phép revalidate qua `304`. |
| 5 | `URL.createObjectURL()` (dùng cho ảnh/video inline trong chat và preview trước khi gửi) **không bao giờ** được `URL.revokeObjectURL()` — leak bộ nhớ phía client theo thời gian phiên làm việc | `public/app.js` | `removeMessageFromDOM()` (gọi khi admin xóa tin nhắn) giờ revoke mọi object URL còn sống trong hàng tin nhắn trước khi gỡ khỏi DOM. `loadImageBitmap()` (ảnh tạm để đọc kích thước khi nén phía client) revoke ngay sau `onload`/`onerror` — an toàn vì ảnh đã decode xong, không cần URL gốc nữa để vẽ lên canvas. |

**Không thay đổi** (audit xác nhận không cần, tránh sửa những gì đã đúng): SQL query shape, index hiện có (đã đủ — `messages.created_at`, `messages.reply_to_id`, `UNIQUE(message_id, username)` của `message_reactions` đã phục vụ tốt các truy vấn hiện tại, không thêm index trùng lặp), retention/cleanup logic, encryption format, JWT format, API response shape, WebSocket message shape, toàn bộ ngưỡng/threshold bảo mật của STEP 3.

**Cân nhắc nhưng KHÔNG làm** (rủi ro/lợi ích không tương xứng, ghi rõ lý do thay vì âm thầm bỏ qua):
- **Giới hạn số lượng tin nhắn hiển thị trong DOM phía client** (§29) — audit xác nhận client hiện giữ *toàn bộ* lịch sử đã tải trong DOM suốt phiên làm việc (không có cap). Đây là rủi ro RAM tăng dần cho phiên rất dài, nhưng cắt giảm DOM một cách an toàn (không phá scroll position, không phá "load older") cần kiểm thử trực tiếp trên trình duyệt thật mà phiên làm việc này không có — **để lại làm follow-up**, không sửa liều lĩnh một tính năng UI phức tạp mà không kiểm chứng được.
- **Tách buffer image/video trước khi `multer` buffer toàn bộ 10MB vào RAM** (§8) — cần thay đổi kiến trúc multipart-parsing (đọc `Content-Type` field trước khi biết đó là ảnh hay video, để áp dụng giới hạn 500KB sớm hơn cho ảnh) — khả thi nhưng rủi ro phá vỡ pipeline validate/magic-byte hiện có nếu làm vội; `ConcurrencyGuard` (STEP 3.3) đã giới hạn số lượng buffer 10MB được cấp phát đồng thời, giảm đáng kể rủi ro RAM spike tổng thể dù chưa tối ưu triệt để từng request đơn lẻ.

Test mới: `test/performance.test.js` — 2 nhóm: (A) `isWsClientOverBuffered` (thuần túy, không cần DB, PASS ngay trong sandbox này), (B) pagination cursor-based + index audit qua Postgres thật (`afterId`/`beforeId`/không-cursor đều trả về đúng thứ tự tăng dần và đúng phạm vi; xác nhận index tồn tại qua `pg_indexes`) — cần `TEST_DATABASE_URL`, SKIP trong sandbox này.

**Known limitations** (không giả vờ đã đo benchmark thật): phiên làm việc này **không benchmark được** (không có môi trường mạng/tải để đo trước/sau) — mọi thay đổi ở trên được lý giải bằng phân tích code (audit), không kèm số liệu "cải thiện X%". Xem mục "STEP 4 RESULT" cho báo cáo đầy đủ.

## Attachment workflow redesign (2026-09-14) — thay thế fetch()-based upload cũ

Sau 2 lần vá CSP cho `heic2any` (thêm `worker-src`, rồi phát hiện `EvalError` sâu hơn từ `new Function()` mà **không thể vá bằng CSP** mà không thêm `unsafe-eval`), workflow đính kèm file được thiết kế lại toàn bộ để bug gốc — "HEIC client-conversion lỗi → state kẹt → nút Gửi không phản hồi" — không thể tái diễn dưới bất kỳ hình thức thất bại nào của `heic2any`, thay vì tiếp tục vá từng triệu chứng CSP.

**Không đổi CSP, không thêm `unsafe-eval`.** Quyết định giữ nguyên từ lần trước: nếu `heic2any` không dùng được (CSP, mạng, hay bất kỳ lý do gì), client tự động dùng lại **HEIC gốc** và để server (`heic-convert`, đã có từ STEP 3.2, không đổi gì) xử lý.

**State machine tường minh** (`public/attachment-state.js`, module thuần túy, dual Node/browser): `IDLE → ATTACHED → CONVERTING → READY_TO_UPLOAD → UPLOADING → COMPLETED`, với `FAILED`/`CANCELLED` là nhánh rẽ hợp lệ từ hầu hết các bước. Mọi chuyển trạng thái đi qua `transition()`, vốn **throw lỗi rõ ràng** nếu bước chuyển không hợp lệ — bug logic bị phát hiện ngay khi phát triển thay vì để UI rơi vào trạng thái không nhất quán lúc chạy thật. File này **không đụng DOM/network/Blob** — chỉ là dữ liệu + logic chuyển trạng thái, nên test được 100% bằng Node (`test/attachment-state.test.js`, 18 test, không cần trình duyệt/DB).

**Then chốt khắc phục bug gốc**: `CONVERTING` **luôn** có đường hợp lệ tới `READY_TO_UPLOAD` — kể cả khi `heic2any` throw, timeout, hay bị CSP chặn. `startAttachmentProcessing()` (`public/app.js`) bọc toàn bộ đường HEIC trong `try/catch`; thất bại ở bất kỳ bước nào đều rơi xuống `setReadyToUpload(id, file, { converterFailed: true })` — gửi file HEIC **gốc**, không bao giờ dừng lại ở `CONVERTING` vô thời hạn. Giữ nguyên timeout 20s (`HEIC_CLIENT_CONVERT_TIMEOUT_MS`, `Promise.race`) từ lần vá trước làm lưới an toàn cuối cùng cho trường hợp promise treo vĩnh viễn.

**Chống race giữa các attachment** (`AttachmentState.isStaleAttachmentResult()`): mỗi lần chọn file được gán 1 `attachmentId` (`crypto.randomUUID()`). Mọi callback bất đồng bộ (convert xong, nén xong, upload progress/xong) kiểm tra `id` của nó còn khớp với attachment **đang hoạt động** hay không trước khi đụng vào DOM/state — nếu người dùng đã xóa file A và chọn file B, kết quả convert của A đến muộn sẽ bị bỏ qua, không ghi đè lên B.

**Upload progress thật, không giả lập**: `uploadAttachmentWithProgress()` dùng `XMLHttpRequest` (`xhr.upload.onprogress`) thay cho `fetch()` — `fetch()` không có API đáng tin cậy, được hỗ trợ rộng rãi để theo dõi tiến độ upload. Giai đoạn `CONVERTING` (không biết % thật của `heic2any`) hiển thị spinner vô định thay vì bịa số liệu; giai đoạn `UPLOADING` hiển thị % thật từ sự kiện `xhr.upload.onprogress`, vẽ lên progress ring bằng SVG `stroke-dashoffset`.

**UI mới**: 1 card đính kèm cục bộ (`#attachment-card`, phía trên composer — không che input/nút Gửi trên mobile) thay cho dòng text đơn giản cũ. Ảnh preview mờ (`filter: blur(8px)`) trong toàn bộ thời gian chưa được server xác nhận, chuyển nét mượt (`transition: filter .3s`) khi `COMPLETED`. HEIC không tự hiển thị được thì rơi xuống placeholder trung tính (nhãn "HEIC") thay vì báo lỗi — video dùng cùng cơ chế placeholder ("VIDEO", không preview thumbnail, giữ đơn giản + nhẹ cho hiệu năng mobile). Preview này **hoàn toàn cục bộ** — không có message nào được tạo/gửi cho người khác cho tới khi server xác nhận upload thành công.

**Nút Gửi bị khóa đúng lúc**: `isSendBlockedByAttachment()` (thuần túy, unit test riêng) chỉ khóa khi `CONVERTING`/`UPLOADING` — chống double-send và chống bấm Gửi khi chưa có file sẵn sàng, không khóa nhầm ở các trạng thái khác (kể cả `FAILED`, để người dùng vẫn gửi được tin nhắn chữ bình thường sau khi đính kèm lỗi).

**Hủy/xóa đính kèm**: nút X hoặc chọn file mới đều gọi `cancelAttachment()` — abort `XMLHttpRequest` đang chạy (nếu đang `UPLOADING`), revoke object URL, đưa state về `IDLE` sạch sẽ. `logout()` cũng gọi `cancelAttachment()` để tránh rò state/blob URL sang phiên đăng nhập khác trên cùng trình duyệt.

**Không đổi database schema** — tiến độ upload/trạng thái đính kèm hoàn toàn là state phía client tạm thời, không được lưu trữ ở đâu cả; chỉ message/media cuối cùng (đã có từ trước) được lưu theo đúng kiến trúc hiện tại.

**Test**: `test/attachment-state.test.js` (18 test, thuần túy — luồng JPG, luồng HEIC thành công, luồng HEIC thất bại→fallback, hủy ở mọi giai đoạn, retry, chặn Send đúng lúc, chống race giữa 2 attachment) chạy PASS ngay trong môi trường không có trình duyệt/DB. Phần UI (DOM/CSS/animation) **không có test tự động** — dự án hiện chưa có hạ tầng test trình duyệt (Playwright/jsdom...), và việc thêm hạ tầng đó chỉ cho tính năng này là vượt phạm vi (đúng nguyên tắc §23/§25 của yêu cầu: "Do not make tests dependent on an actual browser unless the project already has browser test infrastructure"). **Khuyến nghị**: kiểm thử thủ công trên trình duyệt thật (đặc biệt Android mobile, theo đúng yêu cầu §18) trước khi coi tính năng này là đã xác minh đầy đủ.

**Known limitations**:
- Không có test tự động cho phần UI/DOM (lý do nêu trên) — chỉ state machine logic được test.
- Preview local cho ảnh JPEG/PNG/WebP/GIF dùng file GỐC (chưa nén) — không swap sang bản đã nén sau khi nén xong (khác biệt hình ảnh không đáng kể ở kích thước thumbnail nhỏ, đổi lại tránh thêm 1 object URL không cần thiết).
- Video không có preview thumbnail thật (chỉ placeholder "VIDEO") — đơn giản hóa có chủ đích cho hiệu năng mobile, không phải giới hạn kỹ thuật.
- `heicClientConversionKnownBroken` chỉ tồn tại trong bộ nhớ phiên hiện tại (mất khi tải lại trang) — không lưu vào localStorage, nên sau khi reload trang, lần thử HEIC đầu tiên vẫn sẽ thử `heic2any` lại (chấp nhận được — tránh phức tạp hóa việc lưu trạng thái không quan trọng).

### FIX #2 (2026-09-14, cùng ngày) — Preview quá nhỏ, chuyển COMPLETED quá nhanh, race điều kiện preview HEIC

3 vấn đề phát hiện sau khi dùng thử bản redesign ở trên:

**1. Preview quá nhỏ (64×64, giống icon hơn là preview).** Đổi `.attachment-preview-wrap` sang panel thật: `aspect-ratio: 4/3`, `max-width: 260px` (desktop), `min(100%, 240px)` (mobile, qua media query `max-width: 420px`) — nằm đúng trong khoảng 200–260px rộng / 150–200px cao yêu cầu. Card đổi từ layout ngang (thumbnail + info cạnh nhau) sang dọc (preview lớn phía trên, tên file/trạng thái phía dưới) để giữ đúng tỷ lệ mà không bóp méo. Spinner/progress text phóng to tương ứng (56px, 0.95rem) cho cân đối với panel lớn hơn.

**2. `COMPLETED → IDLE` xảy ra trong cùng 1 tick đồng bộ — hiệu ứng mờ→nét không bao giờ được nhìn thấy.** Trước đó code gọi `setAttachmentPhase(COMPLETED)` rồi `setAttachmentPhase(IDLE)` liên tiếp không có `await` ở giữa — trình duyệt không có cơ hội render frame nào ở trạng thái COMPLETED trước khi card đã bị ẩn. Sửa lại đúng trình tự: `COMPLETED` → đợi 2 lần `requestAnimationFrame` lồng nhau (đảm bảo frame kế tiếp thực sự đã vẽ xong, không chỉ "trước frame này") → render tin nhắn chat thật (bubble độc lập, không cần đợi hiệu ứng CSS của card) → đợi thêm `ATTACHMENT_COMPLETED_VISIBLE_MS = 400ms` (khớp với thời lượng CSS transition 350ms của `.attachment-preview-img`, cộng biên an toàn nhỏ) → **lúc này mới** revoke object URL và chuyển `IDLE` (ẩn card). Object URL không bao giờ bị revoke trước khi hiệu ứng có cơ hội chạy hết. Mỗi bước chờ đều kiểm tra lại `isStaleAttachmentResult()` — nếu người dùng bấm Xóa/chọn file khác trong lúc đang chờ hiệu ứng, `cancelAttachment()` đã tự lo phần dọn dẹp của nó, đoạn code này không đụng vào nữa (tránh dọn dẹp trùng hoặc đè lên attachment mới).

**3. Race điều kiện preview HEIC: probe hiển thị HEIC gốc có thể hoàn tất SAU và ghi đè preview JPEG đã convert xong trước đó.** `attachmentId` (đã có từ bản redesign) chỉ bảo vệ được giữa 2 *attachment* khác nhau, không bảo vệ được giữa 2 *lần set preview* cho CÙNG 1 attachment (ví dụ: probe hiển thị trực tiếp HEIC gốc, và sau đó preview JPEG từ `heic2any` — cả hai đều thuộc về cùng 1 `attachmentId`). Thêm `previewGeneration` (đếm trong `attachment-state.js`, tăng qua `bumpPreviewGeneration()` mỗi khi bắt đầu 1 thao tác set-preview bất đồng bộ mới) và `isPreviewStillCurrent()` (kiểm tra **cả** `attachmentId` **lẫn** `previewGeneration` cùng khớp) — callback nào có generation cũ hơn generation hiện tại của chính attachment đó sẽ tự nhận ra mình đã "lạc hậu", revoke object URL riêng của nó và bỏ qua, không đụng vào preview mới hơn.

Không đổi: kiến trúc upload HEIC, `heic-convert` phía server, CSP (không thêm `unsafe-eval`), authentication/authorization, WebSocket, PostgreSQL, encryption, retention, `xhr.upload.onprogress` (vẫn dùng progress thật, không giả lập), database schema.

Test mới trong `test/attachment-state.test.js` (nay 23 test, +5 so với bản trước): `bumpPreviewGeneration()` tăng đúng và không mutate input; `isPreviewStillCurrent()` đúng cho kịch bản chính xác nêu trong yêu cầu (probe HEIC cũ bị preview JPEG mới hơn "vượt mặt" phải bị từ chối); phân biệt đúng giữa "khác attachment" và "cùng attachment nhưng khác generation". Toàn bộ 23 test PASS trong sandbox này (không cần trình duyệt/DB).

**Known limitation không đổi từ bản trước**: phần UI/DOM/animation (kích thước preview thực tế trên màn hình, thời lượng hiệu ứng mờ→nét có thực sự mượt hay không, layout mobile) **vẫn không có test tự động** — dự án chưa có hạ tầng test trình duyệt và việc thêm hạ tầng đó chỉ cho tính năng này vượt phạm vi yêu cầu. Khuyến nghị kiểm thử thủ công (như đã liệt kê chi tiết trong yêu cầu gốc — JPG, HEIC, race điều kiện bằng mạng chậm, hủy, thay thế file) trên trình duyệt thật, đặc biệt Android, trước khi coi tính năng đã được xác minh đầy đủ.

## Lưu ý quan trọng



- **Đổi `ADMIN_PASSWORD` và `JWT_SECRET`** trước khi dùng thật — server **từ chối khởi động** nếu thiếu `JWT_SECRET` hoặc `MESSAGE_ENCRYPTION_KEY` khi `NODE_ENV=production` (không còn fallback ngầm định).
- **`MESSAGE_ENCRYPTION_KEY` phải được backup an toàn** — mất khóa này đồng nghĩa mất khả năng đọc mọi dữ liệu đã lưu (dù dữ liệu tự xóa sau 48h nên rủi ro thấp).
- Nâng cấp từ bản E2EE trước đó: migration `001_server_side_encryption_media.sql` sẽ **xóa sạch tin nhắn cũ** (vì ciphertext cũ mã hóa bằng passphrase phía client, server không có cách nào giải mã lại trong mô hình mới) rồi đổi cột `ciphertext`/`iv` sang `BYTEA`. Đây là hành động một lần, không thể hoàn tác.
- Trường `mentions` và **cảm xúc thả vào tin nhắn** là metadata lưu riêng (không phải nội dung mã hóa), phục vụ hiển thị/tra cứu.
- Gói Free của Render Postgres có giới hạn dung lượng/thời gian — đặt đúng `DB_STORAGE_LIMIT_MB` để rolling cleanup bảo vệ database khỏi đầy.
