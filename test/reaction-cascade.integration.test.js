// test/reaction-cascade.integration.test.js
//
// STEP 2.1 §12: xac nhan message_reactions.message_id ON DELETE CASCADE hoat
// dong that - tao message, tao reaction, xoa message, xac nhan reaction cung
// bien mat. Chay bang PostgreSQL THAT, chi doc TEST_DATABASE_URL (KHONG bao
// gio DATABASE_URL cua app/production), TU SKIP neu chua co Postgres test.
// Dung bang tam rieng (test_cascade_messages / test_cascade_reactions),
// KHONG dung bang "messages"/"message_reactions" that cua app.
//
// Chay that: xem huong dan o dau file test/oldest-first.integration.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

test('deleting a message cascades to its reactions - REAL PostgreSQL', { skip: !TEST_DATABASE_URL }, async () => {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: TEST_DATABASE_URL });
    try {
        await pool.query('DROP TABLE IF EXISTS test_cascade_reactions');
        await pool.query('DROP TABLE IF EXISTS test_cascade_messages');
        await pool.query(`
            CREATE TABLE test_cascade_messages (
                id SERIAL PRIMARY KEY,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
        `);
        // Cau truc FK phai GIONG HET migrations/000_init.sql (message_reactions
        // that cua app) de test nay thuc su xac nhan dung hanh vi cascade.
        await pool.query(`
            CREATE TABLE test_cascade_reactions (
                id SERIAL PRIMARY KEY,
                message_id INTEGER NOT NULL REFERENCES test_cascade_messages(id) ON DELETE CASCADE,
                username TEXT NOT NULL,
                emoji TEXT NOT NULL,
                UNIQUE (message_id, username)
            )
        `);

        const msgRes = await pool.query('INSERT INTO test_cascade_messages DEFAULT VALUES RETURNING id');
        const messageId = msgRes.rows[0].id;
        await pool.query(
            'INSERT INTO test_cascade_reactions (message_id, username, emoji) VALUES ($1, $2, $3)',
            [messageId, 'do.huy', '👍']
        );

        let reactions = await pool.query('SELECT id FROM test_cascade_reactions WHERE message_id = $1', [messageId]);
        assert.equal(reactions.rows.length, 1, 'Reaction phải tồn tại trước khi xóa message');

        await pool.query('DELETE FROM test_cascade_messages WHERE id = $1', [messageId]);

        reactions = await pool.query('SELECT id FROM test_cascade_reactions WHERE message_id = $1', [messageId]);
        assert.equal(reactions.rows.length, 0, 'Reaction phải tự động bị xóa theo message (ON DELETE CASCADE)');
    } finally {
        await pool.query('DROP TABLE IF EXISTS test_cascade_reactions').catch(() => {});
        await pool.query('DROP TABLE IF EXISTS test_cascade_messages').catch(() => {});
        await pool.end();
    }
});
