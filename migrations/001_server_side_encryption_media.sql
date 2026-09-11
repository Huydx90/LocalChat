-- 001_server_side_encryption_media.sql
--
-- STEP: chuyen tu E2EE (client-side, passphrase phong chung, ciphertext luu
-- duoi dang TEXT base64) sang ma hoa server-side AES-256-GCM (BYTEA).
--
-- QUAN TRONG: ciphertext cu duoc ma hoa boi client bang mot khoa suy ra tu
-- "mat khau phong chat" ma SERVER CHUA BAO GIO BIET. Voi kien truc moi, server
-- tu ma hoa/giai ma bang MESSAGE_ENCRYPTION_KEY rieng - hai co che khong tuong
-- thich, du lieu cu KHONG THE giai ma lai duoc trong ca 2 mo hinh. Vi retention
-- goc chi 48 gio (du lieu "song" rat ngan), ta xoa sach thay vi giu lai du lieu
-- vinh vien khong doc duoc.
--
-- Khoi nay CHI chay tren cac deployment cu (cot ciphertext van la kieu TEXT).
-- Tren deployment moi (da tao bang tu 000_init.sql voi BYTEA) khoi nay se
-- khong lam gi (dieu kien IF sai ngay tu dau) - an toan de chay lai.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'messages' AND column_name = 'ciphertext' AND data_type <> 'bytea'
    ) THEN
        TRUNCATE TABLE message_reactions, messages RESTART IDENTITY CASCADE;
        ALTER TABLE messages ALTER COLUMN ciphertext TYPE BYTEA USING NULL;
        ALTER TABLE messages ALTER COLUMN iv TYPE BYTEA USING NULL;
    END IF;
END $$;

-- Dam bao cot/idx can thiet cho pipeline media + retention da ton tai
-- (no-op tren deployment moi vi 000_init.sql da tao san).
ALTER TABLE messages ADD COLUMN IF NOT EXISTS byte_size INTEGER;
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages (created_at);
