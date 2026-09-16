# Chat nội bộ công ty

Ứng dụng chat nội bộ: Node.js (Express + `ws`) + PostgreSQL, deploy trên **Render.com**.

## Tính năng

- Đăng ký tự do, nhưng tài khoản mới ở trạng thái **chờ duyệt** — chưa thấy được nội dung/chat.
- **Admin duy nhất**: `do.huy`, tự seed khi khởi động lần đầu. Mật khẩu lấy từ biến môi trường `ADMIN_PASSWORD` — **bắt buộc phải đặt** khi `NODE_ENV=production` (server từ chối khởi động nếu thiếu, giống `JWT_SECRET`/`MESSAGE_ENCRYPTION_KEY`, không còn mật khẩu mặc định công khai trong code).
- Admin duyệt (cấp quyền) user, thu hồi quyền, và **xóa** user.
- Tin nhắn **không thể xóa/thu hồi** — không có endpoint xóa/sửa tin nhắn.
- Gửi/xem **ảnh và video**, có giới hạn dung lượng (xem bên dưới). Hỗ trợ ảnh **HEIC/HEIF** (iPhone) — tự động chuyển sang JPEG.
- **Emotion**: nút 😊 cạnh ô nhập mở bảng emoji theo danh mục — bấm 1 emoji sẽ **gửi ngay như tin nhắn text bình thường** (không tạo API/bảng riêng, tự áp dụng mã hóa + retention 48h có sẵn). Tin nhắn chỉ gồm 1-3 emoji được hiển thị lớn hơn.
- Mỗi bong bóng chat có **nút copy nổi** và **nút thả cảm xúc (reaction)** (👍 ❤️ 😂 😮 😢 😡 🎉) — khác với Emotion: reaction gắn vào 1 tin nhắn có sẵn, lưu ở bảng `message_reactions` riêng, không tạo tin nhắn mới.
- Tin nhắn mới **báo hiệu realtime** cho mọi client qua WebSocket (chấm đỏ + số chưa đọc trong app — **không** đẩy push notification ra hệ điều hành).
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
2. **Tạo PostgreSQL trên Render**: Dashboard → New → PostgreSQL. Copy **Internal Database URL**. Mở tab thông tin gói của chính database đó trên Render dashboard để lấy dung lượng **chính xác** (KHÔNG đoán, KHÔNG dùng số ví dụ trong tài liệu này — các gói/chính sách của Render có thể thay đổi) rồi điền vào `DB_STORAGE_LIMIT_MB`.
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

## STEP 2.2 — Configuration parsing (phát hiện bởi review độc lập)

Một review độc lập phát hiện: toàn bộ STEP 2.1 dùng pattern `parseFloat(process.env.X) || default`. Trong JavaScript, `0` và `NaN` đều là falsy, nên pattern này **âm thầm nuốt mất 2 trường hợp nguy hiểm** mà `validateThresholds()` không bao giờ có cơ hội thấy được giá trị thật:

- `DB_WARNING_RATIO=0` → `parseFloat("0") || 0.80` → **âm thầm thành `0.80`** (không phải 0, không có lỗi nào được báo)
- `DB_WARNING_RATIO=abc` (gõ nhầm) → `parseFloat("abc") || 0.80` → **âm thầm thành `0.80`** (không có lỗi nào được báo)
- Tương tự cho mọi biến số khác dùng cùng pattern: `DB_EMERGENCY_RATIO`, `DB_TARGET_RATIO`, `DB_HARD_BLOCK_MEDIA_RATIO`, `DB_HARD_BLOCK_TEXT_RATIO`, `DB_STORAGE_LIMIT_MB`, `MAX_CLEANUP_ITERATIONS`, `EMERGENCY_DELETE_BATCH_SIZE`, `MESSAGE_RETENTION_HOURS`

Đây là vi phạm trực tiếp yêu cầu §22 "fail fast, không silently run với ngưỡng không an toàn" mà STEP 2.1 tưởng đã làm xong nhưng chưa triệt để.

**Đã sửa**: thêm `parseConfigNumber()` (thuần túy, `storage-policy.js`) phân biệt rõ 3 trường hợp — **để trống/chưa cấu hình** (dùng default, hợp lệ) khác với **có cấu hình nhưng không phải số hợp lệ** (fail-fast, `process.exit(1)`) khác với **số hợp lệ** (dùng đúng giá trị, kể cả 0 hoặc âm — để bước validate phía sau tự quyết định có hợp lệ về mặt logic hay không). `server.js` dùng hàm `loadNumberEnv()` bọc quanh nó cho mọi biến số, cộng thêm kiểm tra "phải là số dương" cho các biến không phải tỷ lệ (`MESSAGE_RETENTION_HOURS`, `EMERGENCY_DELETE_BATCH_SIZE`, `MAX_CLEANUP_ITERATIONS`, `DB_STORAGE_LIMIT_MB`).

Đã thêm unit test cho đúng các trường hợp review yêu cầu chứng minh (`DB_WARNING_RATIO=0`, `=abc`, `DB_EMERGENCY_RATIO=-1`, chuỗi số+rác `"10abc"`...) — chạy thật bằng `npm test`, không phải code review suông.

**Giới hạn còn lại**: chưa spawn được `node server.js` thật với các biến môi trường lỗi này để xác nhận toàn bộ tiến trình khởi động thực sự thoát với `process.exit(1)` (môi trường review không có `node_modules`/mạng để `npm install`) — chỉ xác nhận được logic lõi (`parseConfigNumber`/`validateThresholds`) bằng unit test thật. `loadNumberEnv()` trong `server.js` chỉ là một wrapper mỏng (đọc `process.env` rồi gọi hàm đã test) nên rủi ro còn lại là thấp, nhưng đây vẫn là một khoảng trống kiểm thử thành thật cần ghi nhận.

## Lưu ý quan trọng

- **Đổi `ADMIN_PASSWORD` và `JWT_SECRET`** trước khi dùng thật — server **từ chối khởi động** nếu thiếu `JWT_SECRET` hoặc `MESSAGE_ENCRYPTION_KEY` khi `NODE_ENV=production` (không còn fallback ngầm định).
- **`MESSAGE_ENCRYPTION_KEY` phải được backup an toàn** — mất khóa này đồng nghĩa mất khả năng đọc mọi dữ liệu đã lưu (dù dữ liệu tự xóa sau 48h nên rủi ro thấp).
- Nâng cấp từ bản E2EE trước đó: migration `001_server_side_encryption_media.sql` sẽ **xóa sạch tin nhắn cũ** (vì ciphertext cũ mã hóa bằng passphrase phía client, server không có cách nào giải mã lại trong mô hình mới) rồi đổi cột `ciphertext`/`iv` sang `BYTEA`. Đây là hành động một lần, không thể hoàn tác.
- Trường `mentions` và **cảm xúc thả vào tin nhắn** là metadata lưu riêng (không phải nội dung mã hóa), phục vụ hiển thị/tra cứu.
- Gói Free của Render Postgres có giới hạn dung lượng/thời gian — đặt đúng `DB_STORAGE_LIMIT_MB` để rolling cleanup bảo vệ database khỏi đầy.
