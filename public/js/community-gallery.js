// 認証チェック + communityId チェック
(function() {
  const token = localStorage.getItem('authToken');
  if (!token) {
    location.replace('/login?redirect=' + encodeURIComponent(location.pathname + location.search));
    return;
  }
  const params = new URLSearchParams(location.search);
  const communityId = params.get('id');
  if (!communityId) {
    location.replace('/gallery');
  }
})();

const params = new URLSearchParams(location.search);
const communityId = params.get('id');

function doLogout() {
  localStorage.removeItem('authToken');
  location.replace('/login');
}

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

document.getElementById('btn-add-photo').addEventListener('click', () => {
  location.href = '/?communityId=' + encodeURIComponent(communityId);
});

async function loadCommunityName() {
  try {
    const res = await authFetch('/api/communities/mine');
    const data = await res.json();
    const community = (data.communities || []).find(c => c.id === communityId);
    if (community) {
      document.getElementById('community-name').textContent = community.name;
      document.title = community.name + ' - Wedding Photo Share';
    } else {
      location.replace('/gallery');
    }
  } catch (_) {}
}

loadCommunityName();

const PAGE_SIZE = 30;
let photos = [];
let currentPage = 0;
let currentIndex = 0;

// ── 選択モード ───────────────────────────────────────────────
let selectionMode = false;
let selectedKeys = new Set();

function enterSelectionMode() {
  selectionMode = true;
  document.getElementById('btn-select-mode').classList.add('active');
  document.getElementById('selection-bar').classList.add('open');
  document.getElementById('photo-grid').classList.add('selection-mode');
  updateSelectionBar();
}

function exitSelectionMode() {
  selectionMode = false;
  selectedKeys.clear();
  document.getElementById('btn-select-mode').classList.remove('active');
  document.getElementById('selection-bar').classList.remove('open');
  document.getElementById('photo-grid').classList.remove('selection-mode');
  document.querySelectorAll('.photo-item.selected').forEach(el => el.classList.remove('selected'));
}

function togglePhotoSelection(item, key) {
  if (selectedKeys.has(key)) {
    selectedKeys.delete(key);
    item.classList.remove('selected');
  } else {
    selectedKeys.add(key);
    item.classList.add('selected');
  }
  updateSelectionBar();
}

function selectAllPage() {
  const pagePhotos = photos.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const allSelected = pagePhotos.every(p => selectedKeys.has(p.key));
  if (allSelected) {
    pagePhotos.forEach(p => selectedKeys.delete(p.key));
    document.querySelectorAll('.photo-item.selected').forEach(el => el.classList.remove('selected'));
  } else {
    document.querySelectorAll('.photo-item').forEach((item, i) => {
      const key = pagePhotos[i]?.key;
      if (key) {
        selectedKeys.add(key);
        item.classList.add('selected');
      }
    });
  }
  updateSelectionBar();
}

function updateSelectionBar() {
  const count = selectedKeys.size;
  document.getElementById('sel-count').textContent = `${count}枚選択中`;
  document.getElementById('btn-dl-selected').disabled = count === 0;

  const pagePhotos = photos.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const allSelected = pagePhotos.length > 0 && pagePhotos.every(p => selectedKeys.has(p.key));
  document.getElementById('btn-sel-all').textContent = allSelected ? '全解除' : '全選択';
}

async function downloadSelected() {
  const keys = Array.from(selectedKeys);
  if (keys.length === 0) return;

  const btn = document.getElementById('btn-dl-selected');
  btn.disabled = true;
  btn.textContent = '準備中...';

  try {
    const res = await authFetch('/api/download-zip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys }),
    });

    if (!res.ok) {
      const err = await res.json();
      alert(err.error || 'ダウンロードに失敗しました');
      return;
    }

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'wedding-photos.zip';
    a.click();
    URL.revokeObjectURL(url);
  } catch (_) {
    alert('ダウンロードに失敗しました');
  } finally {
    btn.textContent = '⬇ ダウンロード';
    updateSelectionBar();
  }
}

// ── ページネーション ─────────────────────────────────────────
function buildPageNumbers(current, total) {
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i);
  }
  const pages = [];
  pages.push(0);
  if (current > 2) pages.push('...');
  for (let i = Math.max(1, current - 1); i <= Math.min(total - 2, current + 1); i++) {
    pages.push(i);
  }
  if (current < total - 3) pages.push('...');
  pages.push(total - 1);
  return pages;
}

function renderPage() {
  const start = currentPage * PAGE_SIZE;
  const pagePhotos = photos.slice(start, start + PAGE_SIZE);
  const totalPages = Math.ceil(photos.length / PAGE_SIZE);

  selectedKeys.clear();
  if (selectionMode) updateSelectionBar();

  const grid = document.getElementById('photo-grid');
  grid.innerHTML = '';
  if (selectionMode) grid.classList.add('selection-mode');

  pagePhotos.forEach((photo, i) => {
    const item = document.createElement('div');
    item.className = 'photo-item';

    const img = document.createElement('img');
    img.src = photo.viewUrl;
    img.alt = photo.filename;
    img.loading = 'lazy';

    const overlay = document.createElement('div');
    overlay.className = 'check-overlay';
    const checkIcon = document.createElement('span');
    checkIcon.className = 'check-icon';
    checkIcon.textContent = '✓';
    overlay.appendChild(checkIcon);

    item.appendChild(img);
    item.appendChild(overlay);

    const dlBtn = document.createElement('button');
    dlBtn.className = 'dl-btn';
    dlBtn.title = 'ダウンロード';
    dlBtn.innerHTML = '⬇';
    dlBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (selectionMode) return;
      downloadPhoto(photo);
    });
    item.appendChild(dlBtn);

    item.addEventListener('click', () => {
      if (selectionMode) {
        togglePhotoSelection(item, photo.key);
      } else {
        openLightbox(i);
      }
    });

    grid.appendChild(item);
  });

  const pagination = document.getElementById('pagination');
  if (totalPages > 1) {
    pagination.style.display = 'flex';
    document.getElementById('btn-prev-page').disabled = currentPage === 0;
    document.getElementById('btn-next-page').disabled = currentPage === totalPages - 1;

    const container = document.getElementById('page-numbers');
    container.innerHTML = '';
    buildPageNumbers(currentPage, totalPages).forEach(p => {
      if (p === '...') {
        const el = document.createElement('span');
        el.className = 'ellipsis';
        el.textContent = '…';
        container.appendChild(el);
      } else {
        const btn = document.createElement('button');
        btn.textContent = p + 1;
        if (p === currentPage) btn.classList.add('active');
        btn.addEventListener('click', () => { currentPage = p; renderPage(); });
        container.appendChild(btn);
      }
    });
  } else {
    pagination.style.display = 'none';
  }

  window.scrollTo(0, 0);
}

async function loadPhotos(forceRefresh = false) {
  document.getElementById('loading').style.display = 'block';
  document.getElementById('photo-grid').innerHTML = '';
  document.getElementById('grid-wrapper').style.display = 'none';
  document.getElementById('pagination').style.display = 'none';
  document.getElementById('empty').style.display = 'none';
  document.getElementById('photo-count-header').textContent = '読み込み中...';

  try {
    const url = `/api/photos/community/${encodeURIComponent(communityId)}${forceRefresh ? '?refresh=1' : ''}`;
    const res = await authFetch(url);
    if (res.status === 403) { location.replace('/gallery'); return; }
    const data = await res.json();
    photos = data.photos || [];
  } catch (e) {
    if (e.message === '認証エラー') return;
    photos = [];
  }

  document.getElementById('loading').style.display = 'none';

  if (photos.length === 0) {
    document.getElementById('empty').style.display = 'block';
    document.getElementById('photo-count-header').textContent = '写真はまだありません';
    return;
  }

  document.getElementById('photo-count-header').textContent = `${photos.length} 枚の写真`;
  document.getElementById('grid-wrapper').style.display = 'block';

  currentPage = 0;
  renderPage();
}

// ── ライトボックス ───────────────────────────────────────────
function openLightbox(pageRelativeIndex) {
  currentIndex = pageRelativeIndex;
  updateLightbox();
  document.getElementById('lightbox').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeLightbox() {
  document.getElementById('lightbox').classList.remove('open');
  document.body.style.overflow = '';
}

function updateLightbox() {
  const pagePhotos = photos.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const photo = pagePhotos[currentIndex];
  document.getElementById('lightbox-img').src = photo.viewUrl;
  const dlLink = document.getElementById('lightbox-download');
  dlLink.href = photo.downloadUrl;
  dlLink.download = photo.filename;
  dlLink.onclick = () => {
    authFetch('/api/track-download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: photo.key, size: photo.size }),
    }).catch(() => {});
  };
  const pageCount = pagePhotos.length;
  document.getElementById('lightbox-prev').style.visibility = currentIndex > 0 ? 'visible' : 'hidden';
  document.getElementById('lightbox-next').style.visibility = currentIndex < pageCount - 1 ? 'visible' : 'hidden';
}

function prevPhoto() {
  if (currentIndex > 0) { currentIndex--; updateLightbox(); }
}

function nextPhoto() {
  const pageCount = photos.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE).length;
  if (currentIndex < pageCount - 1) { currentIndex++; updateLightbox(); }
}

function downloadPhoto(photo) {
  authFetch('/api/track-download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: photo.key, size: photo.size }),
  }).catch(() => {});

  const a = document.createElement('a');
  a.href = photo.downloadUrl;
  a.download = photo.filename;
  a.click();
}

document.addEventListener('keydown', (e) => {
  if (!document.getElementById('lightbox').classList.contains('open')) return;
  if (e.key === 'Escape') closeLightbox();
  if (e.key === 'ArrowLeft') prevPhoto();
  if (e.key === 'ArrowRight') nextPhoto();
});

document.getElementById('lightbox').addEventListener('click', (e) => {
  if (e.target === document.getElementById('lightbox')) closeLightbox();
});

document.querySelector('.btn-refresh').addEventListener('click', () => loadPhotos(true));
document.querySelector('.footer-logout').addEventListener('click', doLogout);
document.getElementById('lightbox-close').addEventListener('click', closeLightbox);
document.getElementById('lightbox-prev').addEventListener('click', prevPhoto);
document.getElementById('lightbox-next').addEventListener('click', nextPhoto);
document.getElementById('btn-prev-page').addEventListener('click', () => {
  if (currentPage > 0) { currentPage--; renderPage(); }
});
document.getElementById('btn-next-page').addEventListener('click', () => {
  if (currentPage < Math.ceil(photos.length / PAGE_SIZE) - 1) { currentPage++; renderPage(); }
});
document.getElementById('btn-select-mode').addEventListener('click', () => {
  selectionMode ? exitSelectionMode() : enterSelectionMode();
});
document.getElementById('btn-sel-all').addEventListener('click', selectAllPage);
document.getElementById('btn-dl-selected').addEventListener('click', downloadSelected);
document.getElementById('btn-sel-cancel').addEventListener('click', exitSelectionMode);

loadPhotos();
