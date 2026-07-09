/**
 * 加油站儲值管理系統 - 後端伺服器
 * Node.js + Express + PostgreSQL (pg) + express-session
 * 所有時間一律使用 Asia/Taipei
 */

const express = require('express');
const session = require('express-session');
const path = require('path');
const { Pool } = require('pg');
const XLSX = require('xlsx');

const app = express();
const PORT = process.env.PORT || 3000;

const LOW_BALANCE_THRESHOLD = 20000; // 餘額警示門檻
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '8899';
const INITIAL_BALANCE = 100000;
const SESSION_SECRET =
  process.env.SESSION_SECRET || 'gas-station-admin-secret-please-change-in-production';

if (!process.env.DATABASE_URL) {
  console.warn('⚠️  尚未設定 DATABASE_URL 環境變數，請在 Render 上新增此環境變數，指向你的 PostgreSQL 連線字串。');
}

const isLocalDb = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || '');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocalDb ? false : { rejectUnauthorized: false }
});

// ---------------------------------------------------------------------------
// 時間工具（Asia/Taipei，不使用 UTC）
// ---------------------------------------------------------------------------
function nowTaipei() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' });
}

// ---------------------------------------------------------------------------
// 資料庫初始化
// ---------------------------------------------------------------------------
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vendors (
      id      SERIAL PRIMARY KEY,
      name    TEXT UNIQUE NOT NULL,
      balance DOUBLE PRECISION NOT NULL DEFAULT 0
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS transactions (
      id         SERIAL PRIMARY KEY,
      vendor_id  INTEGER NOT NULL REFERENCES vendors(id),
      amount     DOUBLE PRECISION NOT NULL,
      type       TEXT NOT NULL CHECK (type IN ('deduct','admin_adjust')),
      created_at TEXT NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_users (
      id       SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL
    );
  `);

  const { rows: vendorRows } = await pool.query('SELECT COUNT(*)::int AS c FROM vendors');
  if (vendorRows[0].c === 0) {
    const names = ['A', 'B', 'C', 'D'];
    for (const name of names) {
      await pool.query('INSERT INTO vendors (name, balance) VALUES ($1, $2)', [name, INITIAL_BALANCE]);
    }
  }

  const { rows: adminRows } = await pool.query('SELECT COUNT(*)::int AS c FROM admin_users');
  if (adminRows[0].c === 0) {
    await pool.query('INSERT INTO admin_users (username, password) VALUES ($1, $2)', ['admin', ADMIN_PASSWORD]);
  }
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.set('trust proxy', 1); // 部署在 Render 等平台的反向代理後方時，讓 session cookie 正確運作

app.use(express.json());
app.use(
  session({
    name: 'gas.sid',
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 1000 * 60 * 60 * 8 // 8 小時
    }
  })
);

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.status(401).json({ error: '請先登入後台' });
}

function asyncHandler(fn) {
  return (req, res, next) => fn(req, res, next).catch(next);
}

// ---------------------------------------------------------------------------
// 🟩 前台 API（無需登入）
// ---------------------------------------------------------------------------

app.get('/api/vendors', asyncHandler(async (req, res) => {
  const { rows } = await pool.query('SELECT id, name, balance FROM vendors ORDER BY id');
  res.json(rows);
}));

app.post('/api/deduct', asyncHandler(async (req, res) => {
  const { vendor_id, amount } = req.body;
  const amt = Number(amount);

  if (!vendor_id) {
    return res.status(400).json({ error: '請選擇廠商' });
  }
  if (!Number.isFinite(amt) || amt <= 0) {
    return res.status(400).json({ error: '扣款金額必須大於 0' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM vendors WHERE id = $1 FOR UPDATE', [vendor_id]);
    const vendor = rows[0];
    if (!vendor) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: '廠商不存在' });
    }
    if (amt > vendor.balance) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: '扣款金額不可超過餘額' });
    }

    const newBalance = vendor.balance - amt;
    await client.query('UPDATE vendors SET balance = $1 WHERE id = $2', [newBalance, vendor.id]);
    await client.query(
      'INSERT INTO transactions (vendor_id, amount, type, created_at) VALUES ($1, $2, $3, $4)',
      [vendor.id, amt, 'deduct', nowTaipei()]
    );
    await client.query('COMMIT');

    res.json({ success: true, vendor: { id: vendor.id, name: vendor.name, balance: newBalance } });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// ---------------------------------------------------------------------------
// 🟨 後台 - 登入 / 登出 / Session 狀態
// ---------------------------------------------------------------------------

app.post('/api/admin/login', asyncHandler(async (req, res) => {
  const { password } = req.body;
  const { rows } = await pool.query('SELECT * FROM admin_users WHERE username = $1', ['admin']);
  const admin = rows[0];

  if (admin && password === admin.password) {
    req.session.isAdmin = true;
    return res.json({ success: true });
  }
  res.status(401).json({ error: '密碼錯誤' });
}));

app.post('/api/admin/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('gas.sid');
    res.json({ success: true });
  });
});

app.get('/api/admin/session', (req, res) => {
  res.json({ loggedIn: !!(req.session && req.session.isAdmin) });
});

// ---------------------------------------------------------------------------
// 🟨 後台 - 廠商管理
// ---------------------------------------------------------------------------

app.get('/api/admin/vendors', requireAdmin, asyncHandler(async (req, res) => {
  const { rows } = await pool.query('SELECT id, name, balance FROM vendors ORDER BY id');
  res.json(rows);
}));

app.post('/api/admin/vendors', requireAdmin, asyncHandler(async (req, res) => {
  const { name, initial_balance } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: '請輸入廠商名稱' });
  }
  const balance = Number.isFinite(Number(initial_balance)) ? Number(initial_balance) : 0;
  try {
    const { rows } = await pool.query(
      'INSERT INTO vendors (name, balance) VALUES ($1, $2) RETURNING id',
      [name.trim(), balance]
    );
    res.json({ success: true, id: rows[0].id });
  } catch (e) {
    res.status(400).json({ error: '廠商名稱重複或無效' });
  }
}));

app.put('/api/admin/vendors/:id', requireAdmin, asyncHandler(async (req, res) => {
  const { name } = req.body;
  const { id } = req.params;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: '請輸入廠商名稱' });
  }
  const { rows } = await pool.query('SELECT * FROM vendors WHERE id = $1', [id]);
  if (!rows[0]) {
    return res.status(404).json({ error: '廠商不存在' });
  }
  try {
    await pool.query('UPDATE vendors SET name = $1 WHERE id = $2', [name.trim(), id]);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: '廠商名稱重複或無效' });
  }
}));

app.delete('/api/admin/vendors/:id', requireAdmin, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { rows } = await pool.query('SELECT * FROM vendors WHERE id = $1', [id]);
  if (!rows[0]) {
    return res.status(404).json({ error: '廠商不存在' });
  }
  const { rows: txRows } = await pool.query('SELECT COUNT(*)::int AS c FROM transactions WHERE vendor_id = $1', [id]);
  if (txRows[0].c > 0) {
    return res.status(400).json({ error: '此廠商已有交易紀錄，無法刪除' });
  }
  await pool.query('DELETE FROM vendors WHERE id = $1', [id]);
  res.json({ success: true });
}));

app.post('/api/admin/vendors/:id/adjust', requireAdmin, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { amount } = req.body;
  const amt = Number(amount);

  if (!Number.isFinite(amt) || amt === 0) {
    return res.status(400).json({ error: '調整金額不可為 0 或無效數字' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM vendors WHERE id = $1 FOR UPDATE', [id]);
    const vendor = rows[0];
    if (!vendor) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: '廠商不存在' });
    }
    const newBalance = vendor.balance + amt;
    await client.query('UPDATE vendors SET balance = $1 WHERE id = $2', [newBalance, id]);
    await client.query(
      'INSERT INTO transactions (vendor_id, amount, type, created_at) VALUES ($1, $2, $3, $4)',
      [id, amt, 'admin_adjust', nowTaipei()]
    );
    await client.query('COMMIT');
    res.json({ success: true, vendor: { id: vendor.id, name: vendor.name, balance: newBalance } });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// ---------------------------------------------------------------------------
// 🟨 後台 - 扣款紀錄
// ---------------------------------------------------------------------------
app.get('/api/admin/transactions', requireAdmin, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT t.id, v.name AS vendor_name, t.amount, t.type, t.created_at
    FROM transactions t
    JOIN vendors v ON v.id = t.vendor_id
    ORDER BY t.id DESC
  `);
  res.json(rows);
}));

// ---------------------------------------------------------------------------
// 🟨 後台 - 每日統計
// ---------------------------------------------------------------------------
app.get('/api/admin/daily-stats', requireAdmin, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT substr(t.created_at, 1, 10) AS date, v.name AS vendor_name, SUM(t.amount) AS total
    FROM transactions t
    JOIN vendors v ON v.id = t.vendor_id
    WHERE t.type = 'deduct'
    GROUP BY date, v.name
    ORDER BY date DESC, v.name ASC
  `);
  res.json(rows);
}));

// ---------------------------------------------------------------------------
// 🟨 後台 - Excel 匯出
// ---------------------------------------------------------------------------
app.get('/api/admin/export/transactions', requireAdmin, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT v.name AS "廠商名稱", t.amount AS "金額",
           CASE t.type WHEN 'deduct' THEN '扣款' ELSE '後台調整' END AS "類型",
           t.created_at AS "時間"
    FROM transactions t
    JOIN vendors v ON v.id = t.vendor_id
    ORDER BY t.id DESC
  `);

  const worksheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, '扣款紀錄');
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="transactions.xlsx"');
  res.send(buffer);
}));

app.get('/api/admin/export/daily-stats', requireAdmin, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT substr(t.created_at, 1, 10) AS "日期", v.name AS "廠商名稱", SUM(t.amount) AS "扣款總額"
    FROM transactions t
    JOIN vendors v ON v.id = t.vendor_id
    WHERE t.type = 'deduct'
    GROUP BY "日期", v.name
    ORDER BY "日期" DESC, v.name ASC
  `);

  const worksheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, '每日統計');
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="daily_stats.xlsx"');
  res.send(buffer);
}));

// ---------------------------------------------------------------------------
// 靜態檔案 + 錯誤處理
// ---------------------------------------------------------------------------
app.use(express.static(path.join(__dirname, 'public')));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: '伺服器發生錯誤，請稍後再試' });
});

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`🚀 加油站儲值管理系統已啟動`);
      console.log(`   前台: http://localhost:${PORT}/`);
      console.log(`   後台: http://localhost:${PORT}/admin.html`);
    });
  })
  .catch((err) => {
    console.error('❌ 資料庫初始化失敗：', err);
    process.exit(1);
  });
