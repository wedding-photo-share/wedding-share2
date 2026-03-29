// ── タブ切替 ────────────────────────────────────────────────
function switchTab(name) {
  const tabNames = ['qr', 'community', 'users', 'storage'];
  document.querySelectorAll('.tab-btn').forEach((btn, i) => {
    btn.classList.toggle('active', tabNames[i] === name);
  });
  document.querySelectorAll('.tab-panel').forEach(panel => {
    panel.classList.remove('active');
  });
  document.getElementById('tab-' + name).classList.add('active');

  if (name === 'community') loadCommunities();
  if (name === 'users') loadUsers();
  if (name === 'storage') loadS3Usage();
}

// ── QRコード ─────────────────────────────────────────────────

let pollingTimer = null;
let tunnelReady = false;

const GITHUB_PAGES_URL = 'https://wedding-photo-share.github.io/wedding-share2/';

async function pollTunnelStatus() {
  try {
    const res = await fetch('/api/tunnel-status');
    const data = await res.json();

    const dot = document.getElementById('status-dot');
    const text = document.getElementById('status-text');

    if (data.status === 'ready' && data.url) {
      dot.className = 'status-dot ready';
      text.textContent = 'サーバー接続中';

      if (!tunnelReady) {
        tunnelReady = true;
        clearInterval(pollingTimer);
      }
    } else if (data.status === 'error') {
      dot.className = 'status-dot error';
      text.textContent = 'サーバー接続エラー';
      clearInterval(pollingTimer);
    }
  } catch (e) {}
}

async function generateQR(initialUrl) {
  const url = initialUrl || document.getElementById('url-input').value.trim();
  if (!url) return;

  document.getElementById('qr-label').textContent = 'QRコード生成中...';
  document.getElementById('qr-container').style.display = 'none';
  document.getElementById('copy-btn').style.display = 'none';

  try {
    const res = await fetch(`/api/qrcode?url=${encodeURIComponent(url)}`);
    const data = await res.json();

    document.getElementById('qr-img').src = data.qrcode;
    document.getElementById('qr-container').style.display = 'inline-block';
    document.getElementById('qr-url').textContent = data.url;
    document.getElementById('qr-label').textContent = 'スマホでスキャンしてください ✦';
    document.getElementById('copy-btn').style.display = 'inline-block';
  } catch (err) {
    document.getElementById('qr-label').textContent = 'QRコード生成に失敗しました';
  }
}

function copyUrl() {
  const url = document.getElementById('qr-url').textContent;
  navigator.clipboard.writeText(url).then(() => {
    const msg = document.getElementById('copied-msg');
    msg.style.display = 'block';
    setTimeout(() => { msg.style.display = 'none'; }, 2000);
  });
}

document.getElementById('url-input').addEventListener('keypress', (e) => {
  if (e.key === 'Enter') generateQR();
});

document.getElementById('url-input').value = GITHUB_PAGES_URL;
generateQR(GITHUB_PAGES_URL);

pollTunnelStatus();
pollingTimer = setInterval(pollTunnelStatus, 1000);

// ── S3 使用量 ──────────────────────────────────────────────

function formatBytes(bytes) {
  if (bytes < 1024)             return bytes + ' B';
  if (bytes < 1024 ** 2)        return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 ** 3)        return (bytes / 1024 ** 2).toFixed(1) + ' MB';
  return (bytes / 1024 ** 3).toFixed(2) + ' GB';
}

async function loadS3Usage() {
  try {
    const res = await fetch('/api/s3-usage');
    if (!res.ok) throw new Error('fetch failed');
    const d = await res.json();
    const s = d.storage;
    const t = d.transfer;

    document.getElementById('usage-loading').style.display = 'none';
    document.getElementById('usage-body').style.display    = 'block';

    document.getElementById('usage-used').textContent   = formatBytes(s.totalBytes);
    document.getElementById('usage-photos').textContent = s.totalCount + ' 枚';

    const storageBar    = document.getElementById('usage-bar');
    storageBar.style.width = s.usedPct + '%';

    const storageRemain = document.getElementById('usage-remain');
    storageRemain.textContent = '残り ' + formatBytes(s.remainBytes);

    if (s.usedPct >= 80) {
      storageBar.classList.add('danger');
      storageRemain.classList.add('danger');
    }

    const storageCostEl = document.getElementById('usage-cost');
    if (s.isOverFreeTier) {
      storageCostEl.style.display = 'block';
      storageCostEl.textContent =
        `⚠ 無料枠超過。追加料金の目安: $${s.estimatedCostUSD.toFixed(4)} USD/月`;
    }

    document.getElementById('dl-used').textContent  = formatBytes(t.totalBytes);
    document.getElementById('dl-count').textContent = t.totalDownloads + ' 回のダウンロード';

    const dlBar    = document.getElementById('dl-bar');
    dlBar.style.width = t.usedPct + '%';

    const dlRemain = document.getElementById('dl-remain');
    dlRemain.textContent = '残り ' + formatBytes(t.remainBytes);

    if (t.usedPct >= 80) {
      dlBar.classList.add('danger');
      dlRemain.classList.add('danger');
    }

    const dlCostEl = document.getElementById('dl-cost');
    if (t.isOverFreeTier) {
      dlCostEl.style.display = 'block';
      dlCostEl.textContent =
        `⚠ 無料枠超過。追加料金の目安: $${t.estimatedCostUSD.toFixed(4)} USD/月`;
    }
  } catch (e) {
    document.getElementById('usage-loading').textContent = '取得に失敗しました';
  }
}

// ── コミュニティ管理 ────────────────────────────────────────

function toggleCreateForm() {
  const form = document.getElementById('community-create-form');
  form.classList.toggle('open');
  if (form.classList.contains('open')) {
    document.getElementById('new-comm-name').focus();
  } else {
    document.getElementById('new-comm-name').value = '';
    document.getElementById('new-comm-passphrase').value = '';
    document.getElementById('create-comm-error').style.display = 'none';
  }
}

async function loadCommunities() {
  const listEl = document.getElementById('community-list');
  listEl.innerHTML = '<div class="usage-loading" id="comm-loading">読み込み中...</div>';

  try {
    const res = await fetch('/api/admin/communities');
    if (!res.ok) throw new Error('fetch failed');
    const { communities } = await res.json();

    if (communities.length === 0) {
      listEl.innerHTML = '<div class="empty-state">コミュニティがありません</div>';
      return;
    }

    listEl.innerHTML = '';
    communities.forEach(c => {
      const row = document.createElement('div');
      row.id = 'comm-row-' + c.id;
      row.innerHTML = `
        <div class="community-row">
          <div class="community-info">
            <div class="community-name">${escapeHtml(c.name)}</div>
            <div class="community-date">${formatDate(c.createdAt)}</div>
          </div>
          <div class="row-actions">
            <button class="btn-edit-pw" data-id="${c.id}">合言葉変更</button>
            <button class="btn-delete-sm" data-id="${c.id}" data-name="${escapeHtml(c.name)}">削除</button>
          </div>
        </div>
        <div class="inline-pw-form" id="pw-form-${c.id}">
          <div class="warn-text">⚠ 変更するとこのコミュニティのメンバーが全員ログアウトされます</div>
          <div class="form-field">
            <input type="text" class="form-input" id="pw-input-${c.id}" placeholder="新しい合言葉" maxlength="100">
          </div>
          <div class="error-inline" id="pw-error-${c.id}"></div>
          <div class="form-actions">
            <button class="btn-cancel-sm" data-id="${c.id}" data-action="cancel-pw">キャンセル</button>
            <button class="btn-save-sm" data-id="${c.id}" data-action="save-pw">変更する</button>
          </div>
        </div>
      `;
      // イベントリスナーを直接アタッチ
      row.querySelector('.btn-edit-pw').addEventListener('click', () => togglePwForm(c.id));
      row.querySelector('.btn-delete-sm').addEventListener('click', () => deleteCommunity(c.id, c.name));
      row.querySelector('[data-action="cancel-pw"]').addEventListener('click', () => togglePwForm(c.id));
      row.querySelector('[data-action="save-pw"]').addEventListener('click', () => changePw(c.id));
      listEl.appendChild(row);
    });
  } catch (e) {
    listEl.innerHTML = '<div class="empty-state" style="color:#f87171">取得に失敗しました</div>';
  }
}

function togglePwForm(id) {
  const form = document.getElementById('pw-form-' + id);
  form.classList.toggle('open');
  if (form.classList.contains('open')) {
    document.getElementById('pw-input-' + id).focus();
  }
}

async function createCommunity() {
  const name = document.getElementById('new-comm-name').value.trim();
  const passphrase = document.getElementById('new-comm-passphrase').value;
  const errorEl = document.getElementById('create-comm-error');
  errorEl.style.display = 'none';

  if (!name) { errorEl.textContent = '名前を入力してください'; errorEl.style.display = 'block'; return; }
  if (!passphrase) { errorEl.textContent = '合言葉を入力してください'; errorEl.style.display = 'block'; return; }

  try {
    const res = await fetch('/api/admin/communities', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, passphrase }),
    });
    const data = await res.json();
    if (!res.ok) {
      errorEl.textContent = data.error || '作成に失敗しました';
      errorEl.style.display = 'block';
      return;
    }
    toggleCreateForm();
    loadCommunities();
  } catch (e) {
    errorEl.textContent = 'ネットワークエラーが発生しました';
    errorEl.style.display = 'block';
  }
}

async function changePw(communityId) {
  const pw = document.getElementById('pw-input-' + communityId).value;
  const errorEl = document.getElementById('pw-error-' + communityId);
  errorEl.style.display = 'none';

  if (!pw) {
    errorEl.textContent = '合言葉を入力してください';
    errorEl.style.display = 'block';
    return;
  }

  try {
    const res = await fetch('/api/admin/communities/' + communityId, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passphrase: pw }),
    });
    const data = await res.json();
    if (!res.ok) {
      errorEl.textContent = data.error || '変更に失敗しました';
      errorEl.style.display = 'block';
      return;
    }
    togglePwForm(communityId);
    document.getElementById('pw-input-' + communityId).value = '';
    loadCommunities();
  } catch (e) {
    errorEl.textContent = 'ネットワークエラーが発生しました';
    errorEl.style.display = 'block';
  }
}

async function deleteCommunity(communityId, name) {
  if (!confirm(`「${name}」を削除してもよろしいですか？\nこの操作は取り消せません。`)) return;

  try {
    const res = await fetch('/api/admin/communities/' + communityId, { method: 'DELETE' });
    if (!res.ok) {
      const data = await res.json();
      alert(data.error || '削除に失敗しました');
      return;
    }
    loadCommunities();
  } catch (e) {
    alert('ネットワークエラーが発生しました');
  }
}

// ── ユーザー管理 ────────────────────────────────────────────

async function loadUsers() {
  const listEl = document.getElementById('user-list');
  listEl.innerHTML = '<div class="usage-loading" id="users-loading">読み込み中...</div>';

  try {
    const res = await fetch('/api/admin/users');
    if (!res.ok) throw new Error('fetch failed');
    const { users } = await res.json();

    if (users.length === 0) {
      listEl.innerHTML = '<div class="empty-state">ユーザーがいません</div>';
      return;
    }

    listEl.innerHTML = '';
    users.forEach(u => {
      const row = document.createElement('div');
      row.className = 'user-row';
      row.id = 'user-row-' + u.id;

      const tags = (u.communityNames || []).map(n =>
        `<span class="community-tag">🔒 ${escapeHtml(n)}</span>`
      ).join('');

      const lastSeen = u.lastSeen ? formatDate(u.lastSeen) : '未アクセス';

      row.innerHTML = `
        <div class="user-row-top">
          <div class="user-nickname">${escapeHtml(u.nickname)}</div>
          <button class="btn-delete-sm">削除</button>
        </div>
        <div class="user-communities">${tags || '<span style="font-size:0.7rem;color:#7b5ea0">コミュニティなし</span>'}</div>
        <div class="user-lastseen">最終アクセス: ${lastSeen}</div>
      `;
      row.querySelector('.btn-delete-sm').addEventListener('click', () => deleteUser(u.id, u.nickname));
      listEl.appendChild(row);
    });
  } catch (e) {
    listEl.innerHTML = '<div class="empty-state" style="color:#f87171">取得に失敗しました</div>';
  }
}

async function deleteUser(userId, nickname) {
  if (!confirm(`「${nickname}」を削除してもよろしいですか？`)) return;

  try {
    const res = await fetch('/api/admin/users/' + userId, { method: 'DELETE' });
    if (!res.ok) {
      const data = await res.json();
      alert(data.error || '削除に失敗しました');
      return;
    }
    loadUsers();
  } catch (e) {
    alert('ネットワークエラーが発生しました');
  }
}

// ── ユーティリティ ──────────────────────────────────────────

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatDate(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  return d.toLocaleDateString('ja-JP', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function closePwModal() {
  document.getElementById('pw-change-modal').classList.remove('open');
}
function submitPwChange() {
  closePwModal();
}

// onclick属性の代替 addEventListener (静的ボタン)
const tabNames = ['qr', 'community', 'users', 'storage'];
document.querySelectorAll('.tab-btn').forEach((btn, i) => {
  btn.addEventListener('click', () => switchTab(tabNames[i]));
});
document.querySelector('.url-row button').addEventListener('click', () => generateQR());
document.getElementById('copy-btn').addEventListener('click', copyUrl);
document.querySelector('#tab-community .btn-new').addEventListener('click', toggleCreateForm);
document.querySelector('#community-create-form .btn-cancel-sm').addEventListener('click', toggleCreateForm);
document.querySelector('#community-create-form .btn-save-sm').addEventListener('click', createCommunity);
document.querySelector('#tab-users .btn-new').addEventListener('click', loadUsers);
document.querySelector('.btn-modal-cancel').addEventListener('click', closePwModal);
document.querySelector('.btn-modal-ok').addEventListener('click', submitPwChange);
