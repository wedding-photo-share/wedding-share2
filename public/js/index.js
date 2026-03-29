async function authFetch(url, options = {}) {
  const token = localStorage.getItem('authToken');
  const headers = {
    ...(options.headers || {}),
    'Authorization': 'Bearer ' + token,
  };
  const res = await fetch(url, { ...options, headers });
  if (res.status === 401) {
    localStorage.removeItem('authToken');
    location.replace('/login?redirect=' + encodeURIComponent(location.pathname + location.search));
    throw new Error('認証エラー');
  }
  return res;
}

function doLogout() {
  localStorage.removeItem('authToken');
  location.replace('/login');
}

window._communities = [];
let selectedCommunityId = null;

async function initPage() {
  try {
    const res = await authFetch('/api/auth/me');
    const data = await res.json();
    const user = data.user;

    document.getElementById('user-name-display').textContent = user.nickname + ' さん、おかえりなさい';

    if (user.communities && user.communities.length > 0) {
      window._communities = user.communities;

      document.getElementById('btn-community-gallery').style.display = 'inline-block';

      const destOptions = document.getElementById('dest-options');
      const destSelector = document.getElementById('dest-selector');

      user.communities.forEach(community => {
        const btn = document.createElement('button');
        btn.className = 'dest-option';
        btn.dataset.communityId = community.id;
        btn.onclick = function() { selectDest(this); };
        btn.innerHTML = `<div class="dest-radio"></div><span>🔒 ${community.name} だけに共有</span>`;
        destOptions.appendChild(btn);
      });

      destSelector.style.display = 'block';

      if (window._preselectedCommunityId) {
        const targetBtn = document.querySelector(`.dest-option[data-community-id="${window._preselectedCommunityId}"]`);
        if (targetBtn) selectDest(targetBtn);
      }
    }
  } catch (err) {
    if (err.message !== '認証エラー') {
      document.getElementById('user-name-display').textContent = '';
    }
  }
}

function selectDest(btn) {
  document.querySelectorAll('.dest-option').forEach(el => {
    el.classList.remove('selected', 'selected-community');
  });
  const communityId = btn.dataset.communityId;
  selectedCommunityId = communityId || null;
  if (communityId) {
    btn.classList.add('selected-community');
  } else {
    btn.classList.add('selected');
  }
}

(function() {
  const urlParams = new URLSearchParams(location.search);
  const preselectedCommunityId = urlParams.get('communityId');
  if (preselectedCommunityId) {
    window._preselectedCommunityId = preselectedCommunityId;
  }
})();

initPage();

// ── アップロード処理 ──────────────────────────────────────────

const fileInput = document.getElementById('fileInput');
const previewSection = document.getElementById('preview-section');
const previewGrid = document.getElementById('preview-grid');
const previewCount = document.getElementById('preview-count');
const uploadBtn = document.getElementById('upload-btn');
const progressSection = document.getElementById('progress-section');
const progressBar = document.getElementById('progress-bar');
const progressText = document.getElementById('progress-text');
const successSection = document.getElementById('success-section');
const uploadSection = document.getElementById('upload-section');

let selectedFiles = [];

const MAX_FILE_SIZE = 20 * 1024 * 1024;
const MAX_FILE_COUNT = 50;

fileInput.addEventListener('change', (e) => {
  const newFiles = Array.from(e.target.files);
  const oversized = newFiles.filter(f => f.size > MAX_FILE_SIZE);
  if (oversized.length > 0) {
    alert(`以下のファイルは20MBを超えているため追加できません:\n${oversized.map(f => f.name).join('\n')}`);
  }
  const valid = newFiles.filter(f => f.size <= MAX_FILE_SIZE);
  const combined = [...selectedFiles, ...valid];
  if (combined.length > MAX_FILE_COUNT) {
    alert(`一度に選択できるのは${MAX_FILE_COUNT}枚までです。最初の${MAX_FILE_COUNT}枚のみ追加します。`);
    selectedFiles = combined.slice(0, MAX_FILE_COUNT);
  } else {
    selectedFiles = combined;
  }
  renderPreviews();
  fileInput.value = '';
});

function renderPreviews() {
  previewGrid.innerHTML = '';
  if (selectedFiles.length === 0) {
    previewSection.style.display = 'none';
    uploadBtn.style.display = 'none';
    return;
  }

  previewSection.style.display = 'block';
  uploadBtn.style.display = 'block';
  previewCount.textContent = `選択中: ${selectedFiles.length} 枚`;

  selectedFiles.forEach((file, index) => {
    const item = document.createElement('div');
    item.className = 'preview-item';
    item.id = `preview-${index}`;

    const img = document.createElement('img');
    img.src = URL.createObjectURL(file);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'remove-btn';
    removeBtn.textContent = '×';
    removeBtn.onclick = (e) => {
      e.stopPropagation();
      selectedFiles.splice(index, 1);
      renderPreviews();
    };

    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    const overlayIcon = document.createElement('span');
    overlayIcon.className = 'overlay-icon';
    overlay.appendChild(overlayIcon);

    item.appendChild(img);
    item.appendChild(removeBtn);
    item.appendChild(overlay);
    previewGrid.appendChild(item);
  });
}

uploadBtn.addEventListener('click', async () => {
  if (selectedFiles.length === 0) return;

  uploadBtn.disabled = true;
  progressSection.style.display = 'block';

  let completed = 0;
  let failed = 0;

  for (let i = 0; i < selectedFiles.length; i++) {
    const file = selectedFiles[i];
    const item = document.getElementById(`preview-${i}`);
    const overlay = item.querySelector('.overlay');
    const overlayIcon = item.querySelector('.overlay-icon');

    item.classList.add('uploading');
    overlayIcon.textContent = '⏳';

    try {
      const body = { filename: file.name, contentType: file.type || 'image/jpeg', fileSize: file.size };
      if (selectedCommunityId) {
        body.communityId = selectedCommunityId;
      }

      const res = await authFetch('/api/presigned-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) throw new Error('URL取得失敗');
      const { url } = await res.json();

      const uploadRes = await fetch(url, {
        method: 'PUT',
        body: file,
        headers: { 'Content-Type': file.type || 'image/jpeg' },
      });

      if (!uploadRes.ok) throw new Error('アップロード失敗');

      item.classList.remove('uploading');
      item.classList.add('done');
      overlayIcon.textContent = '✓';
      completed++;
    } catch (err) {
      if (err.message === '認証エラー') return;
      item.classList.remove('uploading');
      item.classList.add('error');
      overlayIcon.textContent = '✗';
      failed++;
      console.error(err);
    }

    const progress = Math.round(((i + 1) / selectedFiles.length) * 100);
    progressBar.style.width = progress + '%';
    progressText.textContent = `${i + 1} / ${selectedFiles.length} 枚処理中...`;
  }

  progressText.textContent = `完了: ${completed} 枚成功${failed > 0 ? ` / ${failed} 枚失敗` : ''}`;

  if (completed > 0) {
    authFetch('/api/invalidate-cache', { method: 'POST' }).catch(() => {});
  }

  setTimeout(() => {
    if (completed > 0) {
      uploadSection.style.display = 'none';
      successSection.style.display = 'block';
    }
    uploadBtn.disabled = false;
  }, 800);
});

function resetPage() {
  selectedFiles = [];
  renderPreviews();
  progressSection.style.display = 'none';
  progressBar.style.width = '0%';
  uploadSection.style.display = 'block';
  successSection.style.display = 'none';
}

// onclick属性の代替 addEventListener
document.querySelector('.drop-area').addEventListener('click', () => {
  document.getElementById('fileInput').click();
});
document.getElementById('again-btn').addEventListener('click', resetPage);
document.querySelector('.footer-logout').addEventListener('click', doLogout);
document.getElementById('btn-community-gallery').addEventListener('click', () => {
  location.href = '/gallery/community?id=' + encodeURIComponent(window._communities[0]?.id || '');
});
document.querySelector('.dest-option.selected').addEventListener('click', function() {
  selectDest(this);
});
