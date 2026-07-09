# ⛽ 加油站儲值管理系統（PostgreSQL 版）

Node.js + Express + PostgreSQL + Session 登入的完整全端專案。這個版本改用 PostgreSQL（取代原本的 SQLite），資料庫是獨立的雲端服務，不會因為網站服務休眠、重啟、重新部署而清空資料，適合部署在 Render 這類免費方案沒有持久化磁碟的平台上。

## 功能總覽

- **前台**（`/`）：即時顯示廠商餘額（卡片式），低於 NT$20,000 紅色警示 + 晃動動畫；唯一操作為扣款，並有完整金額檢核（不可為 0、不可負數、不可超過餘額）。
- **後台**（`/admin.html`，密碼可由環境變數設定，預設 `8899`）：
  - Session 登入保護所有後台 API
  - 廠商管理：新增 / 改名 / 刪除（有交易紀錄不可刪除）/ 調整餘額（可加可減，不受前台限制）
  - 扣款紀錄表格
  - 每日統計表格（依 Asia/Taipei 分日）
  - 兩顆「匯出 Excel」按鈕，各自下載獨立 `.xlsx` 檔案

## 環境變數

| 變數 | 預設值 | 說明 |
|---|---|---|
| `PORT` | `3000` | 伺服器監聽的埠號（雲端平台通常會自動注入） |
| `DATABASE_URL` | 無，**必填** | PostgreSQL 連線字串，例如 `postgres://user:pass@host/dbname` |
| `ADMIN_PASSWORD` | `8899` | 後台登入密碼 |
| `SESSION_SECRET` | 內建預設字串 | Session 加密密鑰，**正式上線請務必自行設定成隨機字串** |

## 本機測試（需要一個可連線的 PostgreSQL，例如 Render 提供的 External Database URL）

```bash
npm install
DATABASE_URL="貼上你的連線字串" ADMIN_PASSWORD=8899 SESSION_SECRET=隨便一串亂碼 npm start
```

啟動後：前台 `http://localhost:3000/`，後台 `http://localhost:3000/admin.html`。

---

## 🚀 部署到 Render.com（完整步驟）

### 第一步：建立免費 PostgreSQL 資料庫

1. Render Dashboard → **New +** → **PostgreSQL**
2. 填寫：Name 隨意（例如 `gas-station-db`）、Region 選 **Singapore**、Instance Type 選 **Free**
3. 建立完成後，進入資料庫頁面，複製 **Internal Database URL**（如果網站服務跟資料庫在同一個 Render 帳號、同一區域，用 Internal 連線速度較快也不計流量）

### 第二步：建立 Web Service

1. **New +** → **Web Service**，連接你的 GitHub repo
2. Build Command：`npm install`　Start Command：`node server.js`
3. Instance Type：**Free**
4. 在 **Environment Variables** 新增：
   - `DATABASE_URL` = 剛剛複製的 Internal Database URL
   - `ADMIN_PASSWORD` = 你自訂的密碼
   - `SESSION_SECRET` = 隨便一串英數字
5. **不需要**也**找不到** Disks 設定（免費方案不支援持久化磁碟，這正是這個版本改用 PostgreSQL 的原因）
6. 點 **Create Web Service**，等待部署完成即可拿到網址

### 部署後的重要提醒

- 免費方案的網站服務閒置 15 分鐘會自動休眠，下次打開需要等待約 30 秒~1 分鐘喚醒，這是正常現象。
- **資料庫本身不會因為網站休眠而清空**，因為資料庫是獨立運作的服務。
- Render 免費 PostgreSQL **有 90 天效期限制**，過期後資料庫會被停用，需升級成付費方案才能繼續使用（付費方案很便宜，且不會這樣限制）。到期前 Render 會寄信提醒你。
- 務必更改 `ADMIN_PASSWORD`（不要用預設的 `8899`）與 `SESSION_SECRET`。

---

## 專案結構

```
gas-station-system/
├── server.js              # Express 後端主程式（PostgreSQL 版）
├── package.json
├── Dockerfile              # 可選：支援 Docker 的平台（Railway / Zeabur 等）
├── Procfile
└── public/
    ├── index.html          # 前台頁面
    ├── style.css
    ├── app.js
    ├── admin.html          # 後台頁面（含登入畫面）
    ├── admin.css
    └── admin.js
```

## API 一覽

### 前台（無需登入）
| Method | Path | 說明 |
|---|---|---|
| GET | `/api/vendors` | 取得所有廠商餘額 |
| POST | `/api/deduct` | 扣款 `{ vendor_id, amount }` |

### 後台（需先登入，session 驗證）
| Method | Path | 說明 |
|---|---|---|
| POST | `/api/admin/login` | 登入 `{ password }` |
| POST | `/api/admin/logout` | 登出 |
| GET | `/api/admin/session` | 檢查登入狀態 |
| GET | `/api/admin/vendors` | 廠商列表 |
| POST | `/api/admin/vendors` | 新增廠商 `{ name, initial_balance? }` |
| PUT | `/api/admin/vendors/:id` | 改名 `{ name }` |
| DELETE | `/api/admin/vendors/:id` | 刪除（有交易紀錄則拒絕） |
| POST | `/api/admin/vendors/:id/adjust` | 調整餘額 `{ amount }`（正負皆可） |
| GET | `/api/admin/transactions` | 扣款紀錄列表 |
| GET | `/api/admin/daily-stats` | 每日統計（依 Asia/Taipei） |
| GET | `/api/admin/export/transactions` | 下載扣款紀錄 `.xlsx` |
| GET | `/api/admin/export/daily-stats` | 下載每日統計 `.xlsx` |

## 業務規則實作重點

- 所有金額檢查（`amount <= 0`、`amount > balance`）在後端強制執行，並用資料庫交易（`BEGIN`/`COMMIT`/`ROLLBACK` + `FOR UPDATE` 鎖定該筆廠商資料）確保並發扣款時不會產生錯誤餘額。
- 時間一律使用 `Asia/Taipei`（透過 `toLocaleString('sv-SE', {timeZone:'Asia/Taipei'})`，未使用 UTC 或任何第三方時區套件）。
- 每日統計以 `created_at` 字串前 10 碼（`YYYY-MM-DD`）分組，僅計算 `type = 'deduct'` 的扣款金額。
- 廠商刪除前會檢查 `transactions` 表是否有該廠商的任何紀錄，有紀錄則拒絕刪除。
- 兩個匯出功能各自產生獨立的 `.xlsx` 檔案。

## ⚠️ 關於這份程式碼的重要說明

這份程式碼是在沒有對外網路連線的沙盒環境中撰寫完成的，只做過語法檢查（`node --check`），**沒有實際連上 PostgreSQL 執行測試**。部署後請照著下面清單測試一輪，有任何錯誤訊息回報給我：

- 扣款（含超額、負數、0 元的錯誤訊息）
- 後台登入 / 登出
- 廠商新增、改名、刪除（含「有交易紀錄不可刪除」的情境）
- 餘額調整
- 兩個 Excel 匯出按鈕是否正確下載
