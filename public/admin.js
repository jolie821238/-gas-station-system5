const LOW_BALANCE_THRESHOLD = 20000;

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function formatMoney(n) {
  return Number(n).toLocaleString('zh-Hant-TW');
}

function showToast(text, type) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.className = 'toast ' + type;
  toast.textContent = text;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

// ---------------------------------------------------------------------------
// Session / 登入 / 登出
// ---------------------------------------------------------------------------
async function checkSession() {
  const res = await fetch('/api/admin/session');
  const data = await res.json();
  if (data.loggedIn) {
    showDashboard();
  } else {
    showLogin();
  }
}

function showLogin() {
  document.getElementById('login-section').style.display = 'flex';
  document.getElementById('dashboard-section').style.display = 'none';
}

function showDashboard() {
  document.getElementById('login-section').style.display = 'none';
  document.getElementById('dashboard-section').style.display = 'block';
  loadAll();
}

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = document.getElementById('login-password').value;
  const msgEl = document.getElementById('login-message');
  msgEl.textContent = '';

  try {
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    });
    const data = await res.json();
    if (!res.ok) {
      msgEl.textContent = data.error || '登入失敗';
      return;
    }
    document.getElementById('login-password').value = '';
    showDashboard();
  } catch (err) {
    msgEl.textContent = '連線錯誤，請稍後再試';
  }
});

document.getElementById('logout-btn').addEventListener('click', async () => {
  await fetch('/api/admin/logout', { method: 'POST' });
  showLogin();
});

// ---------------------------------------------------------------------------
// 載入所有後台資料
// ---------------------------------------------------------------------------
function loadAll() {
  loadVendors();
  loadTransactions();
  loadDailyStats();
}

// ---------------------------------------------------------------------------
// 廠商管理
// ---------------------------------------------------------------------------
async function loadVendors() {
  const res = await fetch('/api/admin/vendors');
  if (res.status === 401) { showLogin(); return; }
  const vendors = await res.json();
  renderVendorTable(vendors);
}

function renderVendorTable(vendors) {
  const tbody = document.getElementById('vendor-table-body');
  tbody.innerHTML = '';

  if (vendors.length === 0) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="4">尚無廠商資料</td></tr>';
    return;
  }

  vendors.forEach((v) => {
    const isLow = v.balance < LOW_BALANCE_THRESHOLD;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${v.id}</td>
      <td>${escapeHtml(v.name)}</td>
      <td class="${isLow ? 'balance-low' : ''}">NT$ ${formatMoney(v.balance)}</td>
      <td>
        <div class="row-actions">
          <button class="btn-rename" data-action="rename" data-id="${v.id}" data-name="${escapeHtml(v.name)}">改名</button>
          <input type="number" placeholder="+/-金額" data-adjust-input="${v.id}" step="1" />
          <button class="btn-adjust" data-action="adjust" data-id="${v.id}">調整餘額</button>
          <button class="btn-delete" data-action="delete" data-id="${v.id}">刪除</button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

document.getElementById('vendor-table-body').addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const action = btn.dataset.action;
  const id = btn.dataset.id;

  if (action === 'rename') {
    const currentName = btn.dataset.name;
    const newName = prompt('請輸入新的廠商名稱：', currentName);
    if (newName === null) return;
    if (!newName.trim()) { showToast('名稱不可為空', 'error'); return; }

    const res = await fetch(`/api/admin/vendors/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName.trim() })
    });
    const data = await res.json();
    if (!res.ok) { showToast(data.error || '修改失敗', 'error'); return; }
    showToast('廠商名稱已更新', 'success');
    loadVendors();
  }

  if (action === 'delete') {
    if (!confirm('確定要刪除此廠商嗎？（若有交易紀錄將無法刪除）')) return;
    const res = await fetch(`/api/admin/vendors/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) { showToast(data.error || '刪除失敗', 'error'); return; }
    showToast('廠商已刪除', 'success');
    loadVendors();
  }

  if (action === 'adjust') {
    const input = document.querySelector(`input[data-adjust-input="${id}"]`);
    const amount = Number(input.value);
    if (!input.value || !Number.isFinite(amount) || amount === 0) {
      showToast('請輸入有效且不為 0 的調整金額', 'error');
      return;
    }
    const res = await fetch(`/api/admin/vendors/${id}/adjust`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount })
    });
    const data = await res.json();
    if (!res.ok) { showToast(data.error || '調整失敗', 'error'); return; }
    showToast(`餘額已調整，最新餘額 NT$ ${formatMoney(data.vendor.balance)}`, 'success');
    input.value = '';
    loadVendors();
    loadTransactions();
    loadDailyStats();
  }
});

document.getElementById('add-vendor-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const nameInput = document.getElementById('new-vendor-name');
  const balanceInput = document.getElementById('new-vendor-balance');
  const name = nameInput.value.trim();
  const initial_balance = balanceInput.value ? Number(balanceInput.value) : 0;

  if (!name) { showToast('請輸入廠商名稱', 'error'); return; }

  const res = await fetch('/api/admin/vendors', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, initial_balance })
  });
  const data = await res.json();
  if (!res.ok) { showToast(data.error || '新增失敗', 'error'); return; }

  showToast('廠商已新增', 'success');
  nameInput.value = '';
  balanceInput.value = '';
  loadVendors();
});

// ---------------------------------------------------------------------------
// 扣款紀錄
// ---------------------------------------------------------------------------
async function loadTransactions() {
  const res = await fetch('/api/admin/transactions');
  if (res.status === 401) { showLogin(); return; }
  const rows = await res.json();
  renderTransactionTable(rows);
}

function renderTransactionTable(rows) {
  const tbody = document.getElementById('tx-table-body');
  tbody.innerHTML = '';

  if (rows.length === 0) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="5">尚無交易紀錄</td></tr>';
    return;
  }

  rows.forEach((r) => {
    const tr = document.createElement('tr');
    const typeLabel = r.type === 'deduct' ? '扣款' : '後台調整';
    tr.innerHTML = `
      <td>${r.id}</td>
      <td>${escapeHtml(r.vendor_name)}</td>
      <td>NT$ ${formatMoney(r.amount)}</td>
      <td>${typeLabel}</td>
      <td>${escapeHtml(r.created_at)}</td>
    `;
    tbody.appendChild(tr);
  });
}

// ---------------------------------------------------------------------------
// 每日統計
// ---------------------------------------------------------------------------
async function loadDailyStats() {
  const res = await fetch('/api/admin/daily-stats');
  if (res.status === 401) { showLogin(); return; }
  const rows = await res.json();
  renderDailyStatsTable(rows);
}

function renderDailyStatsTable(rows) {
  const tbody = document.getElementById('daily-stats-body');
  tbody.innerHTML = '';

  if (rows.length === 0) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="3">尚無統計資料</td></tr>';
    return;
  }

  rows.forEach((r) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(r.date)}</td>
      <td>${escapeHtml(r.vendor_name)}</td>
      <td>NT$ ${formatMoney(r.total)}</td>
    `;
    tbody.appendChild(tr);
  });
}

// ---------------------------------------------------------------------------
// Excel 匯出
// ---------------------------------------------------------------------------
document.getElementById('export-tx-btn').addEventListener('click', () => {
  window.location.href = '/api/admin/export/transactions';
});

document.getElementById('export-daily-btn').addEventListener('click', () => {
  window.location.href = '/api/admin/export/daily-stats';
});

// ---------------------------------------------------------------------------
// 初始化
// ---------------------------------------------------------------------------
checkSession();
