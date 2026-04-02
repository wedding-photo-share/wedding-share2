// 認証チェック
(function() {
  const token = localStorage.getItem('authToken');
  if (!token) {
    location.replace('/login?redirect=' + encodeURIComponent(location.pathname + location.search));
  }
})();

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

async function loadCommunities() {
  try {
    const res = await authFetch('/api/auth/me');
    const data = await res.json();
    const communities = data.user?.communities || [];
    const container = document.getElementById('community-btns');

    communities.forEach(community => {
      const btn = document.createElement('button');
      btn.className = 'btn-community';
      btn.style.display = 'inline-block';
      btn.textContent = '🔒 ' + community.name;
      btn.addEventListener('click', () => {
        location.href = '/gallery/community?id=' + encodeURIComponent(community.id);
      });
      container.appendChild(btn);
    });
  } catch (_) {}
}

loadCommunities();

const PAGE_SIZE = 30;
let photos = [];
let currentPage = 0;
let currentIndex = 0;

function renderPage() {
  const start = currentPage * PAGE_SIZE;
  const pagePhotos = photos.slice(start, start + PAGE_SIZE);
  const totalPages = Math.ceil(photos.length / PAGE_SIZE);

  const grid = document.getElementById('photo-grid');
  grid.innerHTML = '';

  pagePhotos.forEach((photo, i) => {
    const item = document.createElement('div');
    item.className = 'photo-item';

    const img = document.createElement('img');
    img.src = photo.viewUrl;
    img.alt = photo.filename;
    img.loading = 'lazy';
    img.addEventListener('click', () => openLightbox(i));

    const dlBtn = document.createElement('button');
    dlBtn.className = 'dl-btn';
    dlBtn.title = 'ダウンロード';
    dlBtn.innerHTML = '⬇';
    dlBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      downloadPhoto(photo);
    });

    item.appendChild(img);
    item.appendChild(dlBtn);
    grid.appendChild(item);
  });

  // ページネーション更新
  const pagination = document.getElementById('pagination');
  if (totalPages > 1) {
    pagination.style.display = 'flex';
    document.getElementById('page-info').textContent = `${currentPage + 1} / ${totalPages} ページ`;
    document.getElementById('btn-prev-page').disabled = currentPage === 0;
    document.getElementById('btn-next-page').disabled = currentPage === totalPages - 1;
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
    const url = forceRefresh ? '/api/photos?refresh=1' : '/api/photos';
    const res = await authFetch(url);
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

loadPhotos();
