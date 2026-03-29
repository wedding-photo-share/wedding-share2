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

let photos = [];
let currentIndex = 0;

async function loadPhotos(forceRefresh = false) {
  document.getElementById('loading').style.display = 'block';
  document.getElementById('photo-grid').innerHTML = '';
  document.getElementById('grid-wrapper').style.display = 'none';
  document.getElementById('empty').style.display = 'none';
  document.getElementById('photo-count-header').textContent = '読み込み中...';

  try {
    const url = `/api/photos/community/${encodeURIComponent(communityId)}${forceRefresh ? '?refresh=1' : ''}`;
    const res = await authFetch(url);
    if (res.status === 403) {
      location.replace('/gallery');
      return;
    }
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

  const grid = document.getElementById('photo-grid');
  photos.forEach((photo, index) => {
    const item = document.createElement('div');
    item.className = 'photo-item';

    const img = document.createElement('img');
    img.src = photo.viewUrl;
    img.alt = photo.filename;
    img.loading = 'lazy';
    img.addEventListener('click', () => openLightbox(index));

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
}

function openLightbox(index) {
  currentIndex = index;
  updateLightbox();
  document.getElementById('lightbox').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeLightbox() {
  document.getElementById('lightbox').classList.remove('open');
  document.body.style.overflow = '';
}

function updateLightbox() {
  const photo = photos[currentIndex];
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
  document.getElementById('lightbox-prev').style.visibility = currentIndex > 0 ? 'visible' : 'hidden';
  document.getElementById('lightbox-next').style.visibility = currentIndex < photos.length - 1 ? 'visible' : 'hidden';
}

function prevPhoto() {
  if (currentIndex > 0) { currentIndex--; updateLightbox(); }
}

function nextPhoto() {
  if (currentIndex < photos.length - 1) { currentIndex++; updateLightbox(); }
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

// onclick属性の代替 addEventListener
document.querySelector('.btn-refresh').addEventListener('click', () => loadPhotos(true));
document.querySelector('.btn-logout').addEventListener('click', doLogout);
document.getElementById('lightbox-close').addEventListener('click', closeLightbox);
document.getElementById('lightbox-prev').addEventListener('click', prevPhoto);
document.getElementById('lightbox-next').addEventListener('click', nextPhoto);

loadPhotos();
