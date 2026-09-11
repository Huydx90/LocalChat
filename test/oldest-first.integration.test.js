// test/oldest-first.integration.test.js
//
// STEP 2.1 §18: xac nhan thu tu xoa "oldest-first" (created_at ASC, id ASC)
// bang PostgreSQL THAT. KHONG dung DATABASE_URL cua production - test nay
// CHU DONG chi doc bien TEST_DATABASE_URL (rieng biet, khong bao gio trung
// voi bien DATABASE_URL ma app dung), va se TU SKIP (khong fail) neu bien do
// khong duoc dat - dung khi ban khong co Postgres test san.
//
// Chay that (vi du voi Docker):
//   docker run --rm -e POSTGRES_PASSWORD=test -p 5433:5432 -d postgres:16
//   TEST_DATABASE_URL=postgres://postgres:test@localhost:5433/postgres npm run test:integration
//
// Test tu tao 1 bang tam "test_oldest_first_messages" (KHONG dung bang
// "messages" that cua app) va DROP no sau khi xong - an toan tuyet doi voi du
// lieu that du ban tro TEST_DATABASE_URL vao mot DB dang co du lieu khac.

const test = require('node:test');
const assert = require('node:assert/strict');

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

test('oldest-first deletion order (created_at ASC, id ASC) - REAL PostgreSQL', { skip: !TEST_DATABASE_URL }, async () => {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: TEST_DATABASE_URL });
    try {
        await pool.query('DROP TABLE IF EXISTS test_oldest_first_messages');
        await pool.query(`
            CREATE TABLE test_oldest_first_messages (
                id INTEGER PRIMARY KEY,
                created_at TIMESTAMPTZ NOT NULL
            )
        `);

        // Dung dung dataset trong STEP 2.1 §18:
        //   A: created_at=10:00, id=100
        //   B: created_at=10:00, id=101
        //   C: created_at=09:00, id=200
        //   D: created_at=11:00, id=50
        // Ky vong thu tu xoa: C, A, B, D
        await pool.query(`
            INSERT INTO test_oldest_first_messages (id, created_at) VALUES
            (100, '2026-01-01T10:00:00Z'),
            (101, '2026-01-01T10:00:00Z'),
            (200, '2026-01-01T09:00:00Z'),
            (50,  '2026-01-01T11:00:00Z')
        `);

        const order = [];
        for (let i = 0; i < 4; i++) {
            const res = await pool.query(`
                DELETE FROM test_oldest_first_messages WHERE id IN (
                    SELECT id FROM test_oldest_first_messages ORDER BY created_at ASC, id ASC LIMIT 1
                ) RETURNING id
            `);
            order.push(res.rows[0].id);
        }

        assert.deepEqual(order, [200, 100, 101, 50], `Thu tu xoa thuc te: ${order.join(',')} (ky vong C,A,B,D = 200,100,101,50)`);
    } finally {
        await pool.query('DROP TABLE IF EXISTS test_oldest_first_messages').catch(() => {});
        await pool.end();
    }
});
