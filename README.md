# Chat nội bộ công ty

Ứng dụng chat nội bộ: Node.js (Express + `ws`) + PostgreSQL, deploy trên **Render.com**.

## Tính năng

- Đăng ký tự do, nhưng tài khoản mới ở trạng thái **chờ duyệt** — chưa thấy được nội dung/chat.
- **Admin duy nhất**: `do.huy` (mật khẩu mặc định `14503246`, tự seed khi khởi động lần đầu; nên đổi qua biến môi trường).
- Admin duyệt (cấp quyền) user, thu hồi quyền, và **xóa** user.
- Tin nhắn **không thể xóa/thu hồi** — không có endpoint xóa/sửa tin nhắn.
- Gửi/xem **ảnh và video**, có giới hạn dung lượng (xem bên dưới). Hỗ trợ ảnh **HEIC/HEIF** (iPhone) — tự động chuyển sang JPEG.
- **Emotion**: nút 😊 cạnh ô nhập mở bảng emoji theo danh mục — bấm 1 emoji sẽ **gửi ngay như tin nhắn text bình thường** (không tạo API/bảng riêng, tự áp dụng mã hóa + retention 48h có sẵn). Tin nhắn chỉ gồm 1-3 emoji được hiển thị lớn hơn.
- Mỗi bong bóng chat có **nút copy nổi** và **nút thả cảm xúc (reaction)** (👍 ❤️ 😂 😮 😢 🙏) — khác với Emotion: reaction gắn vào 1 tin nhắn có sẵn, lưu ở bảng `message_reactions` riêng, không tạo tin nhắn mới.
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

- **Bình thường**: tin nhắn tự động bị xóa sau `MESSAGE_RETENTION_HOURS` giờ (mặc định **48**). Chạy định kỳ mỗi 10 phút, xóa theo batch (`EMERGENCY_DELETE_BATCH_SIZE`, mặc định 500) để tránh transaction quá lớn.
- **Rolling/emergency** (giống camera hành trình — vòng lặp dữ liệu): nếu dung lượng PostgreSQL vượt ngưỡng, server chủ động xóa **tin nhắn cũ nhất trước**, kể cả khi chưa đủ 48h, cho tới khi về vùng an toàn.
  - `DB_WARNING_RATIO = 0.80` — bắt đầu cảnh báo.
  - `DB_EMERGENCY_RATIO = 0.90` — bắt đầu xóa cũ-nhất-trước.
  - `DB_TARGET_RATIO = 0.75` — mục tiêu sau khi dọn xong.
  - Tính năng này **chỉ hoạt động nếu đặt `DB_STORAGE_LIMIT_MB`** (dung lượng **thực tế** của gói Postgres bạn đang dùng trên Render — kiểm tra trong Render dashboard, không đoán/mặc định 1024 MB). Lý do: PostgreSQL không có API/SQL portable để biết chính xác quota của Render, nên `usage_ratio = pg_database_size(...) / DB_STORAGE_LIMIT_MB` cần cấu hình thủ công.
- **⚠️ Giới hạn thật của PostgreSQL cần biết**: `DELETE` **không** làm `pg_database_size()` giảm ngay lập tức — nó chỉ tạo dead tuples, dung lượng file trên đĩa chỉ thực sự giảm khi `VACUUM FULL`/`pg_repack` rewrite lại bảng (không chạy tự động ở đây vì cần khóa mạnh, block cả bảng). Vì vậy emergency cleanup có thể xóa rất nhiều tin nhắn mà tỷ lệ dung lượng gần như không giảm ngay — server **log trung thực** điều này (cảnh báo riêng) thay vì giả vờ đã "finished" thành công. Sau mỗi lần emergency cleanup, server chạy thêm `VACUUM (ANALYZE) messages` (an toàn, không phải `VACUUM FULL`, không khóa bảng) như một nỗ lực best-effort giúp Postgres tái sử dụng vùng trống — nhưng **đây không phải cam kết giảm dung lượng ngay**.
- **Hard-block guard (lớp phòng thủ thứ hai, độc lập với cleanup)**: nếu sau khi cleanup mà dung lượng vẫn ở mức nguy hiểm, server **tạm từ chối nhận nội dung mới** thay vì để INSERT tiếp tục đẩy DB đến 100% rồi crash:
  - `DB_HARD_BLOCK_MEDIA_RATIO = 0.95` — ảnh/video bị từ chối (503) trước.
  - `DB_HARD_BLOCK_TEXT_RATIO = 0.99` — text bị từ chối muộn hơn nhiều (ưu tiên chat chữ vẫn hoạt động được lâu nhất có thể vì dung lượng rất nhỏ).
  - Giá trị dung lượng được cache tối đa 30 giây (tránh query `pg_database_size()` mỗi request) và tự làm mới ngay sau khi có video mới được lưu.
- Xóa dùng khóa đơn giản trong bộ nhớ (`cleanupRunning`) để tránh nhiều chu kỳ dọn dẹp chạy chồng nhau — đủ dùng vì Render Free chỉ chạy 1 instance.
- `message_reactions` có `ON DELETE CASCADE` theo `messages.id` nên xóa tin nhắn không để lại reaction mồ côi.

## Cấu trúc

```
server.js              # Express REST API + WebSocket + PostgreSQL + AES-256-GCM + retention
migrations/             # Migration SQL đơn giản, tự chạy khi khởi động (bảng schema_migrations theo dõi)
public/index.html       # Giao diện SPA (login/register/chat/admin)
public/app.js            # Toàn bộ logic client: auth, nén ảnh, upload, hiển thị, reactions, admin
public/style.css         # Giao diện tối, tông teal/cyan
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
   - `ADMIN_USERNAME` / `ADMIN_PASSWORD` — tùy chọn, mặc định `do.huy` / `14503246`
   - `DB_STORAGE_LIMIT_MB` — dung lượng gói Postgres (MB), để bật rolling cleanup
   - (tùy chọn) `MESSAGE_RETENTION_HOURS`, `DB_WARNING_RATIO`, `DB_EMERGENCY_RATIO`, `DB_TARGET_RATIO`, `EMERGENCY_DELETE_BATCH_SIZE`, `MAX_IMAGE_BYTES`, `MAX_VIDEO_BYTES`
5. Deploy. Render tự cấp `PORT`.
6. Đăng nhập bằng tài khoản admin, đăng ký thử vài tài khoản khác để kiểm tra luồng duyệt.

## Đối chiếu code với checklist test (Encryption / Retention / Rolling cleanup / Hard-block)

Đã đọc lại toàn bộ `server.js` để xác nhận logic khớp với checklist test đã thống nhất. Các mục dưới đây là **kết quả review code**, không phải kết quả chạy test thật trên Render (cần Postgres thật + mạng, không có trong môi trường review này) — vẫn cần tự chạy Test 4.1–4.3, 5, 6, 7 trực tiếp trên Render/staging như checklist mô tả trước khi tin tưởng hoàn toàn:

- **Test 4 (encryption)**: cột `ciphertext`/`iv` là `BYTEA`, ghi bằng `encryptBuffer`/`encryptText` (AES-256-GCM), không có đường nào ghi plaintext trực tiếp vào bảng `messages`. Khóa đọc 1 lần từ `MESSAGE_ENCRYPTION_KEY` lúc khởi động (`loadEncryptionKey()`) — không tạo khóa mới mỗi lần deploy nếu biến môi trường được set cố định trên Render. Nếu thiếu biến này khi `NODE_ENV=production`, server từ chối khởi động (không tự tạo khóa ngẫu nhiên) — đúng yêu cầu "không được tạo key mới mỗi lần deploy".
- **Test 5 (48h retention)**: `MESSAGE_RETENTION_HOURS` đọc từ env, `normalRetentionCleanup()` xóa theo `created_at < cutoff`, chạy mỗi 10 phút (`CLEANUP_INTERVAL_MS`) và ngay lúc khởi động (`runCleanupCycle()` gọi trong `start()`). `message_reactions` có `ON DELETE CASCADE` nên xóa message tự xóa theo reaction, không mồ côi. Test bằng cách set `MESSAGE_RETENTION_HOURS=1` như checklist đề xuất là đúng hướng.
- **Test 6 (rolling/emergency cleanup)**: `emergencyStorageCleanup()` xóa theo batch (`EMERGENCY_DELETE_BATCH_SIZE`), luôn `ORDER BY created_at ASC` (cũ nhất trước) — không xóa ngẫu nhiên. Code đã tự xử lý đúng vấn đề MVCC được nêu trong checklist: không giả định `pg_database_size()` giảm ngay sau `DELETE`, luôn đo lại thật (`getDbUsage()`) sau mỗi batch, và chạy `VACUUM (ANALYZE)` best-effort sau cùng (không phải `VACUUM FULL`, an toàn để chạy online).
- **Test hard-block**: `checkStorageGuard('media')` dùng `DB_HARD_BLOCK_MEDIA_RATIO` (mặc định 0.95), `checkStorageGuard('text')` dùng `DB_HARD_BLOCK_TEXT_RATIO` (mặc định 0.99) — đúng thứ tự media bị chặn sớm hơn text như checklist yêu cầu.

## Lưu ý quan trọng

- **Đổi `ADMIN_PASSWORD` và `JWT_SECRET`** trước khi dùng thật — server **từ chối khởi động** nếu thiếu `JWT_SECRET` hoặc `MESSAGE_ENCRYPTION_KEY` khi `NODE_ENV=production` (không còn fallback ngầm định).
- **`MESSAGE_ENCRYPTION_KEY` phải được backup an toàn** — mất khóa này đồng nghĩa mất khả năng đọc mọi dữ liệu đã lưu (dù dữ liệu tự xóa sau 48h nên rủi ro thấp).
- Nâng cấp từ bản E2EE trước đó: migration `001_server_side_encryption_media.sql` sẽ **xóa sạch tin nhắn cũ** (vì ciphertext cũ mã hóa bằng passphrase phía client, server không có cách nào giải mã lại trong mô hình mới) rồi đổi cột `ciphertext`/`iv` sang `BYTEA`. Đây là hành động một lần, không thể hoàn tác.
- Trường `mentions` và **cảm xúc thả vào tin nhắn** là metadata lưu riêng (không phải nội dung mã hóa), phục vụ hiển thị/tra cứu.
- Gói Free của Render Postgres có giới hạn dung lượng/thời gian — đặt đúng `DB_STORAGE_LIMIT_MB` để rolling cleanup bảo vệ database khỏi đầy.
