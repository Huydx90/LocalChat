// test/retention.integration.test.js
//
// STEP 2.1 §10/§19: xac nhan retention 48h - tin cu hon bi xoa, tin moi hon
// duoc giu lai - bang PostgreSQL THAT. Chi doc TEST_DATABASE_URL (KHONG bao
// gio DATABASE_URL cua app/production) va TU SKIP neu bien do khong duoc dat.
// Dung bang tam rieng, DROP sau khi xong - an toan voi du lieu that.
//
// Chay that: xem huong dan o dau file test/oldest-first.integration.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const RETENTION_HOURS = 48;

test('48h retention: old deleted, recent preserved - REAL PostgreSQL', { skip: !TEST_DATABASE_URL }, async () => {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: TEST_DATABASE_URL });
    try {
        await pool.query('DROP TABLE IF EXISTS test_retention_messages');
        await pool.query(`
            CREATE TABLE test_retention_messages (
                id SERIAL PRIMARY KEY,
                label TEXT NOT NULL,
                created_at TIMESTAMPTZ NOT NULL
            )
        `);

        await pool.query(`
            INSERT INTO test_retention_messages (label, created_at) VALUES
            ('older_than_48h', now() - interval '50 hours'),
            ('near_boundary_within', now() - interval '47 hours 55 minutes'),
            ('newer_than_48h', now() - interval '1 hour')
        `);

        const cutoff = new Date(Date.now() - RETENTION_HOURS * 3600 * 1000);
        await pool.query(
            `DELETE FROM test_retention_messages WHERE id IN (
                SELECT id FROM test_retention_messages WHERE created_at < $1 ORDER BY created_at ASC, id ASC LIMIT 500
             )`,
            [cutoff]
        );

        const remaining = await pool.query('SELECT label FROM test_retention_messages ORDER BY id ASC');
        const labels = remaining.rows.map(r => r.label);

        assert.ok(!labels.includes('older_than_48h'), 'Tin cu hon 48h phai bi xoa');
        assert.ok(labels.includes('near_boundary_within'), 'Tin trong pham vi 48h phai duoc giu');
        assert.ok(labels.includes('newer_than_48h'), 'Tin moi hon 48h phai duoc giu');
    } finally {
        await pool.query('DROP TABLE IF EXISTS test_retention_messages').catch(() => {});
        await pool.end();
    }
});
