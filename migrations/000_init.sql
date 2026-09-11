-- 000_init.sql
-- Schema goc: users, messages (ciphertext/iv luu duoi dang BYTEA - da ma hoa
-- server-side bang AES-256-GCM, KHONG phai plaintext), message_reactions.
-- File nay idempotent (CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS)
-- nen an toan khi chay lai nhieu lan hoac tren DB da co san mot phan schema.

CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',       -- 'admin' | 'user'
    status TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'approved'
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
    id SERIAL PRIMARY KEY,
    sender TEXT NOT NULL,
    msg_type TEXT NOT NULL DEFAULT 'text',   -- 'text' | 'image' | 'video'
    ciphertext BYTEA NOT NULL,               -- AES-256-GCM ciphertext + auth tag (server-side)
    iv BYTEA NOT NULL,                       -- 12-byte IV dung de giai ma phia server
    mime_type TEXT,                          -- chi dung cho image/video
    byte_size INTEGER,                       -- kich thuoc goc (truoc khi ma hoa), phuc vu kiem tra/log
    mentions TEXT[] NOT NULL DEFAULT '{}',   -- danh sach username duoc @tag (metadata, server tu trich xuat)
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages (created_at);

CREATE TABLE IF NOT EXISTS message_reactions (
    id SERIAL PRIMARY KEY,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    username TEXT NOT NULL,
    emoji TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (message_id, username)
);
