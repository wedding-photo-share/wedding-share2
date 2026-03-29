function getRedirectUrl() {
  const params = new URLSearchParams(location.search);
  const redirect = params.get('redirect');
  if (redirect && redirect.startsWith('/') && !redirect.startsWith('//')) {
    return redirect;
  }
  return '/';
}

async function checkExistingAuth() {
  const token = localStorage.getItem('authToken');
  if (!token) return;
  try {
    const res = await fetch('/api/auth/me', {
      headers: { 'Authorization': 'Bearer ' + token },
    });
    if (res.ok) {
      location.replace(getRedirectUrl());
    }
  } catch (_) {}
}

checkExistingAuth();

document.getElementById('passphrase-input').addEventListener('keypress', (e) => {
  if (e.key === 'Enter') doLogin();
});
document.getElementById('nickname-input').addEventListener('keypress', (e) => {
  if (e.key === 'Enter') document.getElementById('passphrase-input').focus();
});

async function doLogin() {
  const nickname = document.getElementById('nickname-input').value.trim();
  const passphrase = document.getElementById('passphrase-input').value;
  const errorMsg = document.getElementById('error-msg');
  const loginBtn = document.getElementById('login-btn');

  errorMsg.style.display = 'none';

  if (!nickname) {
    errorMsg.textContent = 'ニックネームを入力してください';
    errorMsg.style.display = 'block';
    return;
  }
  if (!passphrase) {
    errorMsg.textContent = '合言葉を入力してください';
    errorMsg.style.display = 'block';
    return;
  }

  loginBtn.disabled = true;
  loginBtn.textContent = 'ログイン中...';

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nickname, passphrase }),
    });
    const data = await res.json();

    if (!res.ok) {
      errorMsg.textContent = data.error || 'ログインに失敗しました';
      errorMsg.style.display = 'block';
      return;
    }

    localStorage.setItem('authToken', data.token);
    location.replace(getRedirectUrl());
  } catch (err) {
    errorMsg.textContent = 'ネットワークエラーが発生しました';
    errorMsg.style.display = 'block';
  } finally {
    loginBtn.disabled = false;
    loginBtn.textContent = 'ログイン';
  }
}

function openJoinModal() {
  const token = localStorage.getItem('authToken');
  if (!token) {
    const errorMsg = document.getElementById('error-msg');
    errorMsg.textContent = 'まずログインしてください';
    errorMsg.style.display = 'block';
    return;
  }
  document.getElementById('join-modal').classList.add('open');
}

function closeJoinModal() {
  document.getElementById('join-modal').classList.remove('open');
  document.getElementById('join-passphrase').value = '';
  document.getElementById('join-error-msg').style.display = 'none';
}

async function doJoin() {
  const token = localStorage.getItem('authToken');
  if (!token) return;

  const passphrase = document.getElementById('join-passphrase').value;
  const joinErrorMsg = document.getElementById('join-error-msg');
  joinErrorMsg.style.display = 'none';

  if (!passphrase) {
    joinErrorMsg.textContent = '合言葉を入力してください';
    joinErrorMsg.style.display = 'block';
    return;
  }

  try {
    const res = await fetch('/api/auth/join-community', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token,
      },
      body: JSON.stringify({ passphrase }),
    });
    const data = await res.json();

    if (!res.ok) {
      joinErrorMsg.textContent = data.error || '参加に失敗しました';
      joinErrorMsg.style.display = 'block';
      return;
    }

    closeJoinModal();
    alert(`「${data.community.name}」に参加しました！`);
  } catch (err) {
    joinErrorMsg.textContent = 'ネットワークエラーが発生しました';
    joinErrorMsg.style.display = 'block';
  }
}

// onclick属性の代替 addEventListener
document.getElementById('login-btn').addEventListener('click', doLogin);
document.querySelector('.join-link a').addEventListener('click', (e) => {
  e.preventDefault();
  openJoinModal();
});
document.querySelector('.btn-cancel').addEventListener('click', closeJoinModal);
document.querySelector('.btn-join').addEventListener('click', doJoin);
document.getElementById('join-modal').addEventListener('click', (e) => {
  if (e.target === document.getElementById('join-modal')) closeJoinModal();
});
