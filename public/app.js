const LOW_BALANCE_THRESHOLD = 20000;
let vendorsData = [];

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function formatMoney(n) {
  return Number(n).toLocaleString('zh-Hant-TW');
}

async function loadVendors() {
  try {
    const res = await fetch('/api/vendors');
    vendorsData = await res.json();
    renderVendors();
    renderVendorSelect();
  } catch (err) {
    document.getElementById('vendor-list').innerHTML = '<div class="loading">載入失敗，請重新整理</div>';
  }
}

function renderVendors() {
  const container = document.getElementById('vendor-list');
  container.innerHTML = '';

  if (vendorsData.length === 0) {
    container.innerHTML = '<div class="loading">目前尚無廠商資料</div>';
    return;
  }

  vendorsData.forEach((v) => {
    const isLow = v.balance < LOW_BALANCE_THRESHOLD;
    const card = document.createElement('div');
    card.className = 'vendor-card' + (isLow ? ' low-balance shake' : '');
    card.innerHTML = `
      <div class="vendor-name">${escapeHtml(v.name)}</div>
      <div class="vendor-balance${isLow ? ' balance-low' : ''}">NT$ ${formatMoney(v.balance)}</div>
      ${isLow ? '<div class="warning-badge">⚠️ 餘額過低，請儘速儲值</div>' : ''}
    `;
    container.appendChild(card);
  });
}

function renderVendorSelect() {
  const select = document.getElementById('vendor-select');
  const currentValue = select.value;
  select.innerHTML =
    '<option value="">請選擇廠商</option>' +
    vendorsData
      .map((v) => `<option value="${v.id}">${escapeHtml(v.name)}（餘額 NT$ ${formatMoney(v.balance)}）</option>`)
      .join('');
  if (currentValue) select.value = currentValue;
}

function showMessage(text, type) {
  const msgEl = document.getElementById('message');
  msgEl.textContent = text;
  msgEl.className = 'message ' + type;
}

document.getElementById('deduct-form').addEventListener('submit', async (e) => {
  e.preventDefault();

  const vendorId = document.getElementById('vendor-select').value;
  const amountRaw = document.getElementById('amount-input').value;
  const amt = Number(amountRaw);

  if (!vendorId) {
    showMessage('請選擇廠商', 'error');
    return;
  }
  if (!amountRaw || !Number.isFinite(amt) || amt <= 0) {
    showMessage('扣款金額必須大於 0', 'error');
    return;
  }

  try {
    const res = await fetch('/api/deduct', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vendor_id: vendorId, amount: amt })
    });
    const data = await res.json();

    if (!res.ok) {
      showMessage(data.error || '扣款失敗', 'error');
      return;
    }

    showMessage(`✅ 扣款成功！${data.vendor.name} 剩餘餘額 NT$ ${formatMoney(data.vendor.balance)}`, 'success');
    document.getElementById('deduct-form').reset();
    await loadVendors();
  } catch (err) {
    showMessage('連線錯誤，請稍後再試', 'error');
  }
});

loadVendors();
setInterval(loadVendors, 15000);
