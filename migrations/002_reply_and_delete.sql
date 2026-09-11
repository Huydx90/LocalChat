-- 002_reply_and_delete.sql
-- Ho tro tinh nang "Reply" (tra loi 1 tin nhan) va admin "Delete" tin nhan.
--
-- reply_to_id: FK toi messages.id, ON DELETE SET NULL - neu tin nhan goc bi
-- xoa (admin xoa hoac het han retention 48h) thi lien ket bi go, nhung phan
-- snapshot (reply_to_sender/reply_to_preview) VAN GIU LAI de UI tiep tuc hien
-- thi noi dung trich dan (giong hanh vi WhatsApp/Zalo: quote van con nhung
-- khong the "nhay toi" tin nhan goc nua).
--
-- reply_to_sender / reply_to_preview: snapshot PLAINTEXT duoc server tu trich
-- xuat tai thoi diem gui (cung cach lam voi cot "mentions" da co san - metadata
-- phuc vu hien thi, khong phai noi dung chinh cua tin nhan, nen khong can ma
-- hoa nhu ciphertext/iv).
--
-- Xoa tin nhan (DELETE /api/messages/:id, chi admin) dung DELETE FROM messages
-- binh thuong - da co san ON DELETE CASCADE cho message_reactions tu 000_init.sql.

ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to_id INTEGER REFERENCES messages(id) ON DELETE SET NULL;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to_sender TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to_preview TEXT;

CREATE INDEX IF NOT EXISTS idx_messages_reply_to_id ON messages (reply_to_id);
