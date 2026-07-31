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
// 修改密碼（齒輪按鈕）
// ---------------------------------------------------------------------------
document.getElementById('settings-btn').addEventListener('click', () => {
  document.getElementById('current-password').value = '';
  document.getElementById('new-password').value = '';
  document.getElementById('confirm-password').value = '';
  document.getElementById('change-password-msg').textContent = '';
  document.getElementById('settings-modal').style.display = 'flex';
});

document.getElementById('settings-cancel-btn').addEventListener('click', () => {
  document.getElementById('settings-modal').style.display = 'none';
});

document.getElementById('settings-modal').addEventListener('click', (e) => {
  if (e.target.id === 'settings-modal') {
    document.getElementById('settings-modal').style.display = 'none';
  }
});

document.getElementById('change-password-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const currentPassword = document.getElementById('current-password').value;
  const newPassword = document.getElementById('new-password').value;
  const confirmPassword = document.getElementById('confirm-password').value;
  const msgEl = document.getElementById('change-password-msg');
  msgEl.textContent = '';

  if (!currentPassword || !newPassword || !confirmPassword) {
    msgEl.textContent = '請填寫所有欄位';
    return;
  }
  if (newPassword !== confirmPassword) {
    msgEl.textContent = '新密碼與確認新密碼不一致';
    return;
  }
  if (newPassword.length < 4) {
    msgEl.textContent = '新密碼至少需要 4 個字元';
    return;
  }

  const res = await fetch('/api/admin/change-password', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ current_password: currentPassword, new_password: newPassword })
  });
  const data = await res.json();

  if (!res.ok) {
    msgEl.textContent = data.error || '修改失敗';
    return;
  }

  document.getElementById('settings-modal').style.display = 'none';
  showToast('密碼已修改成功', 'success');
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
    tbody.innerHTML = '<tr class="empty-row"><td colspan="5">尚無廠商資料</td></tr>';
    return;
  }

  vendors.forEach((v) => {
    const threshold = Number.isFinite(Number(v.low_balance_threshold)) ? Number(v.low_balance_threshold) : LOW_BALANCE_THRESHOLD;
    const isLow = v.balance < threshold;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${v.id}</td>
      <td>${escapeHtml(v.name)}</td>
      <td class="${isLow ? 'balance-low' : ''}">NT$ ${formatMoney(v.balance)}</td>
      <td>NT$ ${formatMoney(threshold)}</td>
      <td>
        <div class="row-actions">
          <button class="btn-rename" data-action="rename" data-id="${v.id}" data-name="${escapeHtml(v.name)}">改名</button>
          <button class="btn-rename" data-action="threshold" data-id="${v.id}" data-threshold="${threshold}">設定門檻</button>
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

  if (action === 'threshold') {
    const currentThreshold = btn.dataset.threshold;
    const input = prompt('請輸入這個廠商的餘額警示門檻（NT$）：', currentThreshold);
    if (input === null) return;
    const threshold = Number(input);
    if (!input.trim() || !Number.isFinite(threshold) || threshold < 0) {
      showToast('請輸入不小於 0 的有效數字', 'error');
      return;
    }

    const res = await fetch(`/api/admin/vendors/${id}/threshold`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ low_balance_threshold: threshold })
    });
    const data = await res.json();
    if (!res.ok) { showToast(data.error || '設定失敗', 'error'); return; }
    showToast('警示門檻已更新', 'success');
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
  const thresholdInput = document.getElementById('new-vendor-threshold');
  const name = nameInput.value.trim();
  const initial_balance = balanceInput.value ? Number(balanceInput.value) : 0;
  const low_balance_threshold = thresholdInput.value ? Number(thresholdInput.value) : undefined;

  if (!name) { showToast('請輸入廠商名稱', 'error'); return; }

  const res = await fetch('/api/admin/vendors', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, initial_balance, low_balance_threshold })
  });
  const data = await res.json();
  if (!res.ok) { showToast(data.error || '新增失敗', 'error'); return; }

  showToast('廠商已新增', 'success');
  nameInput.value = '';
  balanceInput.value = '';
  thresholdInput.value = '';
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
