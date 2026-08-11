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
      balance DOUBLE PRECISION NOT NULL DEFAULT 0,
      low_balance_threshold DOUBLE PRECISION NOT NULL DEFAULT 20000
    );
  `);

  // 針對已存在的舊資料庫（尚未有這個欄位）自動補上，不影響既有資料
  await pool.query(`
    ALTER TABLE vendors ADD COLUMN IF NOT EXISTS low_balance_threshold DOUBLE PRECISION NOT NULL DEFAULT 20000;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS transactions (
      id         SERIAL PRIMARY KEY,
      vendor_id  INTEGER REFERENCES vendors(id) ON DELETE SET NULL,
      amount     DOUBLE PRECISION NOT NULL,
      type       TEXT NOT NULL CHECK (type IN ('deduct','admin_adjust')),
      created_at TEXT NOT NULL,
      vendor_name_snapshot TEXT
    );
  `);

  // 針對已存在的舊資料庫做遷移：
  // 1. 補上 vendor_name_snapshot 欄位（保存刪除廠商當下的名稱，讓歷史紀錄不會因為廠商被刪除而消失）
  // 2. 把 vendor_id 改成可以是 NULL，並把外鍵規則改成「廠商刪除時，交易紀錄保留、只是不再連到廠商」
  await pool.query(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS vendor_name_snapshot TEXT;`);
  await pool.query(`
    UPDATE transactions t
    SET vendor_name_snapshot = v.name
    FROM vendors v
    WHERE t.vendor_id = v.id AND t.vendor_name_snapshot IS NULL;
  `);
  await pool.query(`ALTER TABLE transactions ALTER COLUMN vendor_id DROP NOT NULL;`);
  await pool.query(`ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_vendor_id_fkey;`);
  await pool.query(`
    ALTER TABLE transactions
    ADD CONSTRAINT transactions_vendor_id_fkey
    FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE SET NULL;
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
      await pool.query(
        'INSERT INTO vendors (name, balance, low_balance_threshold) VALUES ($1, $2, $3)',
        [name, INITIAL_BALANCE, LOW_BALANCE_THRESHOLD]
      );
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
  const { rows } = await pool.query('SELECT id, name, balance, low_balance_threshold FROM vendors ORDER BY id');
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

    // 這裡刻意不檢查「扣款金額是否超過餘額」，允許廠商餘額被扣成負數
    const newBalance = vendor.balance - amt;
    await client.query('UPDATE vendors SET balance = $1 WHERE id = $2', [newBalance, vendor.id]);
    await client.query(
      'INSERT INTO transactions (vendor_id, amount, type, created_at, vendor_name_snapshot) VALUES ($1, $2, $3, $4, $5)',
      [vendor.id, amt, 'deduct', nowTaipei(), vendor.name]
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

// 後台自行修改密碼（存在既有的 admin_users 資料表，不需要改資料庫結構、也不需要改環境變數）
app.put('/api/admin/change-password', requireAdmin, asyncHandler(async (req, res) => {
  const { current_password, new_password } = req.body;

  if (!current_password || !new_password) {
    return res.status(400).json({ error: '請輸入目前密碼與新密碼' });
  }
  if (String(new_password).length < 4) {
    return res.status(400).json({ error: '新密碼至少需要 4 個字元' });
  }

  const { rows } = await pool.query('SELECT * FROM admin_users WHERE username = $1', ['admin']);
  const admin = rows[0];

  if (!admin || current_password !== admin.password) {
    return res.status(401).json({ error: '目前密碼不正確' });
  }

  await pool.query('UPDATE admin_users SET password = $1 WHERE username = $2', [String(new_password), 'admin']);
  res.json({ success: true });
}));

// ---------------------------------------------------------------------------
// 🟨 後台 - 廠商管理
// ---------------------------------------------------------------------------

app.get('/api/admin/vendors', requireAdmin, asyncHandler(async (req, res) => {
  const { rows } = await pool.query('SELECT id, name, balance, low_balance_threshold FROM vendors ORDER BY id');
  res.json(rows);
}));

app.post('/api/admin/vendors', requireAdmin, asyncHandler(async (req, res) => {
  const { name, initial_balance, low_balance_threshold } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: '請輸入廠商名稱' });
  }
  const balance = Number.isFinite(Number(initial_balance)) ? Number(initial_balance) : 0;
  const threshold = Number.isFinite(Number(low_balance_threshold)) && Number(low_balance_threshold) >= 0
    ? Number(low_balance_threshold)
    : LOW_BALANCE_THRESHOLD;
  try {
    const { rows } = await pool.query(
      'INSERT INTO vendors (name, balance, low_balance_threshold) VALUES ($1, $2, $3) RETURNING id',
      [name.trim(), balance, threshold]
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

// 設定該廠商自訂的餘額警示門檻（後台專用）
app.put('/api/admin/vendors/:id/threshold', requireAdmin, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { low_balance_threshold } = req.body;
  const threshold = Number(low_balance_threshold);

  if (!Number.isFinite(threshold) || threshold < 0) {
    return res.status(400).json({ error: '警示門檻必須是不小於 0 的數字' });
  }
  const { rows } = await pool.query('SELECT * FROM vendors WHERE id = $1', [id]);
  if (!rows[0]) {
    return res.status(404).json({ error: '廠商不存在' });
  }
  await pool.query('UPDATE vendors SET low_balance_threshold = $1 WHERE id = $2', [threshold, id]);
  res.json({ success: true, low_balance_threshold: threshold });
}));

app.delete('/api/admin/vendors/:id', requireAdmin, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { rows } = await pool.query('SELECT * FROM vendors WHERE id = $1', [id]);
  if (!rows[0]) {
    return res.status(404).json({ error: '廠商不存在' });
  }
  // 直接刪除，即使有交易紀錄也允許刪除；歷史交易紀錄會保留（vendor_id 會變成 NULL，但名稱快照還在）
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
      'INSERT INTO transactions (vendor_id, amount, type, created_at, vendor_name_snapshot) VALUES ($1, $2, $3, $4, $5)',
      [id, amt, 'admin_adjust', nowTaipei(), vendor.name]
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
    SELECT t.id, COALESCE(v.name, t.vendor_name_snapshot, '(已刪除廠商)') AS vendor_name, t.amount, t.type, t.created_at
    FROM transactions t
    LEFT JOIN vendors v ON v.id = t.vendor_id
    ORDER BY t.id DESC
  `);
  res.json(rows);
}));

// ---------------------------------------------------------------------------
// 🟨 後台 - 每日統計
// ---------------------------------------------------------------------------
app.get('/api/admin/daily-stats', requireAdmin, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT substr(t.created_at, 1, 10) AS date,
           COALESCE(v.name, t.vendor_name_snapshot, '(已刪除廠商)') AS vendor_name,
           SUM(t.amount) AS total
    FROM transactions t
    LEFT JOIN vendors v ON v.id = t.vendor_id
    WHERE t.type = 'deduct'
    GROUP BY date, COALESCE(v.name, t.vendor_name_snapshot, '(已刪除廠商)')
    ORDER BY date DESC, vendor_name ASC
  `);
  res.json(rows);
}));

// ---------------------------------------------------------------------------
// 🟨 後台 - Excel 匯出
// ---------------------------------------------------------------------------
app.get('/api/admin/export/transactions', requireAdmin, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT COALESCE(v.name, t.vendor_name_snapshot, '(已刪除廠商)') AS "廠商名稱", t.amount AS "金額",
           CASE t.type WHEN 'deduct' THEN '扣款' ELSE '後台調整' END AS "類型",
           t.created_at AS "時間"
    FROM transactions t
    LEFT JOIN vendors v ON v.id = t.vendor_id
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
    SELECT substr(t.created_at, 1, 10) AS "日期",
           COALESCE(v.name, t.vendor_name_snapshot, '(已刪除廠商)') AS "廠商名稱",
           SUM(t.amount) AS "扣款總額"
    FROM transactions t
    LEFT JOIN vendors v ON v.id = t.vendor_id
    WHERE t.type = 'deduct'
    GROUP BY "日期", COALESCE(v.name, t.vendor_name_snapshot, '(已刪除廠商)')
    ORDER BY "日期" DESC, "廠商名稱" ASC
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
