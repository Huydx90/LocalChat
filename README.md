# Chat nội bộ công ty

Ứng dụng chat nội bộ: Node.js (Express + `ws`) + PostgreSQL, deploy trên **Render.com**.

## Tính năng

- Đăng ký tự do, nhưng tài khoản mới ở trạng thái **chờ duyệt** — chưa thấy được nội dung/chat.
- **Admin duy nhất**: `do.huy` (mật khẩu mặc định `14503246`, tự seed khi khởi động lần đầu; nên đổi qua biến môi trường).
- Admin duyệt (cấp quyền) user, thu hồi quyền, và **xóa** user.
- Tin nhắn **không thể xóa/thu hồi** — không có endpoint xóa tin nhắn.
- Gửi/xem **ảnh và video** (tối đa 15MB/file, giới hạn ở phía client + server).
- Mỗi bong bóng chat có **nút copy nổi** (hiện khi hover/chạm).
- Tin nhắn mới **báo hiệu realtime** cho mọi client qua WebSocket (chấm đỏ + số chưa đọc trong app — **không** đẩy push notification ra hệ điều hành).
- Tin nhắn **tự động bị xóa sau 2 ngày** (dọn dẹp mỗi giờ bằng cron nội bộ).
- Hỗ trợ **tag @username** trong phòng chat (autocomplete khi gõ `@`).
- **Mã hóa đầu-cuối (E2E)**: nội dung text/ảnh/video được mã hóa AES-GCM ngay trên trình duyệt bằng khóa suy ra từ một **mật khẩu phòng chat** do bạn tự đặt và chia sẻ ngoài hệ thống (ví dụ nói miệng, nhắn Zalo riêng...). Server **chỉ lưu ciphertext**, không có khả năng đọc nội dung.

## Cấu trúc

```
server.js         # Express REST API + WebSocket + PostgreSQL
public/index.html # Giao diện SPA (login/register/chat/admin)
public/app.js      # Toàn bộ logic client + mã hóa E2E
public/style.css   # Giao diện tối, tông teal/cyan
```

## Chạy local

```bash
npm install
cp .env.example .env   # sửa DATABASE_URL trỏ tới Postgres local hoặc Render
npm start
```

Mở `http://localhost:3000`.

## Deploy lên Render.com

1. **Đẩy code lên GitHub**: tạo repo mới, push toàn bộ thư mục này (đã có sẵn `.gitignore`).
2. **Tạo PostgreSQL trên Render**: Dashboard → New → PostgreSQL. Sau khi tạo xong, copy **Internal Database URL**.
3. **Tạo Web Service trên Render**: Dashboard → New → Web Service → kết nối repo GitHub vừa tạo.
   - Build Command: `npm install`
   - Start Command: `npm start`
4. Vào tab **Environment** của Web Service, thêm các biến:
   - `DATABASE_URL` = Internal Database URL vừa copy ở bước 2
   - `JWT_SECRET` = một chuỗi ngẫu nhiên dài, bí mật (bắt buộc cho production)
   - `ADMIN_USERNAME` = `do.huy` (tùy chọn, đây là giá trị mặc định)
   - `ADMIN_PASSWORD` = mật khẩu admin bạn muốn dùng (tùy chọn, mặc định `14503246`)
5. Deploy. Render tự cấp biến `PORT`, server đã đọc `process.env.PORT`.
6. Đăng nhập bằng tài khoản admin, đăng ký thử vài tài khoản khác để kiểm tra luồng duyệt.
7. Tất cả người dùng trong công ty cần biết **mật khẩu mã hóa phòng chat** (nhập ở màn "Mã hóa đầu-cuối" sau khi đăng nhập lần đầu) — đây là bí mật chia sẻ riêng, không liên quan mật khẩu đăng nhập, và không được lưu ở server.

## Lưu ý quan trọng

- **Đổi `ADMIN_PASSWORD` và `JWT_SECRET`** trên Render trước khi dùng thật; giá trị mặc định trong code chỉ để đúng yêu cầu ban đầu, không an toàn nếu để nguyên.
- Gói Free của Render Postgres có giới hạn dung lượng/thời gian — phù hợp thử nghiệm nội bộ, cân nhắc gói trả phí nếu dùng lâu dài.
- Vì tin nhắn/ảnh/video được mã hóa AES-GCM bằng "mật khẩu phòng chat" dùng chung, ai biết mật khẩu này đều đọc được toàn bộ nội dung — đây là mô hình E2E theo nhóm dùng khóa chia sẻ (không phải mã hóa theo từng cặp người dùng kiểu Signal). Nếu cần thu hồi quyền đọc lịch sử một cách triệt để, cần đổi mật khẩu phòng và thông báo lại cho các user còn hoạt động.
- Trường `mentions` (danh sách username được @tag) được gửi dưới dạng metadata **không mã hóa** để phục vụ hiển thị/thông báo — bản thân nội dung tin nhắn vẫn được mã hóa đầy đủ.
- File đính kèm giới hạn 15MB (do được mã hóa + encode base64 rồi gửi qua JSON); có thể tăng giới hạn trong `server.js` (`MAX_PAYLOAD_MB`) và `public/app.js` nếu cần, nhưng lưu ý gói Free của Render có giới hạn băng thông/bộ nhớ.
