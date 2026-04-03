const express = require('express');
const archiver = require('archiver');
const { S3Client, PutObjectCommand, PutBucketCorsCommand, ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');
const { spawn } = require('child_process');
const path = require('path');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '10kb' }));

// ── セキュリティヘッダー ──────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (process.env.RENDER) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "img-src 'self' data: blob: https://*.amazonaws.com https://*.cloudfront.net",
    "connect-src 'self' https://*.amazonaws.com https://*.onrender.com https://*.cloudfront.net",
    "frame-ancestors 'none'",
  ].join('; '));
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

const BUCKET_NAME = 'wedding-share-app2';
const REGION = 'ap-northeast-1';
const PORT = process.env.PORT || 3000;

const ALLOWED_CONTENT_TYPES = new Set([
  'image/jpeg', 'image/jpg', 'image/png', 'image/gif',
  'image/webp', 'image/heic', 'image/heif', 'image/bmp', 'image/tiff',
]);
const ALLOWED_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif', '.bmp', '.tiff', '.tif',
]);

const UPLOAD_URL_EXPIRY  = 5 * 60;
const VIEW_URL_EXPIRY    = 30 * 60;

const CLOUDFRONT_DOMAIN = process.env.CLOUDFRONT_DOMAIN
  ? process.env.CLOUDFRONT_DOMAIN.replace(/^https?:\/\//, '').replace(/\/$/, '')
  : null;

const PHOTO_CACHE_TTL = CLOUDFRONT_DOMAIN ? 10 * 60 * 1000 : 25 * 60 * 1000;

const s3Client = new S3Client({ region: REGION });

// ── レート制限 ──────────────────────────────────────────────
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'リクエストが多すぎます。しばらく待ってからお試しください。' },
});

const uploadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'アップロードリクエストが多すぎます。しばらく待ってからお試しください。' },
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'ログイン試行が多すぎます。15分後に再試行してください。' },
});

app.use('/api/', generalLimiter);

// ── 管理画面 Basic 認証 ──────────────────────────────────────
function requireAdmin(req, res, next) {
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) return next();

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Admin", charset="UTF-8"');
    return res.status(401).send('管理画面へのアクセスには認証が必要です');
  }

  const credentials = Buffer.from(authHeader.slice(6), 'base64').toString('utf-8');
  const colonIndex = credentials.indexOf(':');
  const password = colonIndex >= 0 ? credentials.slice(colonIndex + 1) : '';

  if (password !== adminPassword) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Admin", charset="UTF-8"');
    return res.status(401).send('パスワードが間違っています');
  }
  next();
}

// ── ユーザーデータキャッシュ ──────────────────────────────────
let usersCache = null;
let usersCacheTime = 0;
let commCache = null;
let commCacheTime = 0;
const DATA_CACHE_TTL = 30 * 1000;

// ── S3 上のデータファイル読み書き ──────────────────────────────
const USERS_KEY = 'data/users.json';
const COMMUNITIES_KEY = 'data/communities.json';

async function readUsers() {
  const now = Date.now();
  if (usersCache && (now - usersCacheTime) < DATA_CACHE_TTL) {
    return usersCache;
  }
  try {
    const data = await s3Client.send(new GetObjectCommand({ Bucket: BUCKET_NAME, Key: USERS_KEY }));
    const body = await data.Body.transformToString();
    usersCache = JSON.parse(body);
    usersCacheTime = now;
    return usersCache;
  } catch (_) {
    return { users: [] };
  }
}

async function writeUsers(data) {
  usersCache = data;
  usersCacheTime = Date.now();
  await s3Client.send(new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: USERS_KEY,
    Body: JSON.stringify(data),
    ContentType: 'application/json',
  }));
}

async function readCommunities() {
  const now = Date.now();
  if (commCache && (now - commCacheTime) < DATA_CACHE_TTL) {
    return commCache;
  }
  try {
    const data = await s3Client.send(new GetObjectCommand({ Bucket: BUCKET_NAME, Key: COMMUNITIES_KEY }));
    const body = await data.Body.transformToString();
    commCache = JSON.parse(body);
    commCacheTime = now;
    return commCache;
  } catch (_) {
    return { communities: [] };
  }
}

async function writeCommunities(data) {
  commCache = data;
  commCacheTime = Date.now();
  await s3Client.send(new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: COMMUNITIES_KEY,
    Body: JSON.stringify(data),
    ContentType: 'application/json',
  }));
}

function hashPassphrase(passphrase) {
  return crypto.createHash('sha256').update('ws2026:' + passphrase).digest('hex');
}

// ── requireUser ミドルウェア ──────────────────────────────────
async function requireUser(req, res, next) {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return res.status(401).json({ error: 'ログインが必要です' });
  const token = h.slice(7);
  const { users } = await readUsers();
  const user = users.find(u => u.sessions?.some(s => s.token === token));
  if (!user) return res.status(401).json({ error: 'セッションが無効です' });
  // lastSeen 更新（キャッシュ内のみ、バックグラウンドで保存）
  user.lastSeen = new Date().toISOString();
  req.user = user;
  next();
}

// ── コミュニティ写真キャッシュ ────────────────────────────────
const communityPhotoCache = new Map(); // communityId -> { photos, time }

// ── ストレージ使用量キャッシュ ────────────────────────────────
const STORAGE_LIMIT_BYTES = 10 * 1024 * 1024 * 1024; // 10GB
const STORAGE_CACHE_TTL   = 5 * 60 * 1000;            // 5分
let storageCache     = null;
let storageCacheTime = 0;

async function getTotalStorageBytes() {
  const now = Date.now();
  if (storageCache !== null && (now - storageCacheTime) < STORAGE_CACHE_TTL) {
    return storageCache;
  }
  let totalBytes = 0;
  let continuationToken = undefined;
  do {
    const data = await s3Client.send(new ListObjectsV2Command({
      Bucket: BUCKET_NAME,
      Prefix: 'uploads/',
      ContinuationToken: continuationToken,
    }));
    totalBytes += (data.Contents || [])
      .filter(obj => !obj.Key.endsWith('/'))
      .reduce((sum, obj) => sum + (obj.Size || 0), 0);
    continuationToken = data.IsTruncated ? data.NextContinuationToken : undefined;
  } while (continuationToken);
  storageCache = totalBytes;
  storageCacheTime = now;
  return totalBytes;
}

// ── 写真URLリスト生成ヘルパー ──────────────────────────────────
async function buildPhotoList(objects) {
  return Promise.all(objects.map(async (obj) => {
    const viewUrl = CLOUDFRONT_DOMAIN
      ? `https://${CLOUDFRONT_DOMAIN}/${obj.Key}`
      : await getSignedUrl(s3Client, new GetObjectCommand({
          Bucket: BUCKET_NAME,
          Key: obj.Key,
        }), { expiresIn: VIEW_URL_EXPIRY });

    const downloadUrl = await getSignedUrl(s3Client, new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: obj.Key,
      ResponseContentDisposition: `attachment; filename="${path.basename(obj.Key)}"`,
    }), { expiresIn: VIEW_URL_EXPIRY });

    return {
      key: obj.Key,
      filename: path.basename(obj.Key),
      viewUrl,
      downloadUrl,
      lastModified: obj.LastModified,
      size: obj.Size,
    };
  }));
}

// トンネルURLを保持
let tunnelUrl = null;
let tunnelStatus = 'starting';

// Cloudflare Quick Tunnel を起動
function startCloudflaredTunnel() {
  console.log('Cloudflare Tunnel 起動中...');
  const cf = spawn('cloudflared', ['tunnel', '--config', '/dev/null', '--url', `http://localhost:${PORT}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const parseUrl = (data) => {
    const text = data.toString();
    const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (match && !tunnelUrl) {
      tunnelUrl = match[0];
      tunnelStatus = 'ready';
      console.log(`\n========================================`);
      console.log(`  公開URL: ${tunnelUrl}`);
      console.log(`  管理画面で自動的にQRコードが生成されます`);
      console.log(`========================================\n`);
    }
  };

  cf.stdout.on('data', parseUrl);
  cf.stderr.on('data', parseUrl);

  cf.on('error', (err) => {
    console.error('cloudflared 起動エラー:', err.message);
    tunnelStatus = 'error';
  });

  cf.on('close', (code) => {
    if (tunnelStatus !== 'ready') tunnelStatus = 'error';
    console.log(`cloudflared 終了 (code: ${code})`);
  });

  process.on('exit', () => { try { cf.kill(); } catch (_) {} });
  process.on('SIGINT', () => { try { cf.kill(); } catch (_) {} process.exit(0); });
}

// S3バケットにCORSを設定
async function configureBucketCors() {
  const corsConfig = {
    Bucket: BUCKET_NAME,
    CORSConfiguration: {
      CORSRules: [
        {
          AllowedHeaders: ['Content-Type'],
          AllowedMethods: ['PUT', 'GET'],
          AllowedOrigins: ['*'],
          ExposeHeaders: ['ETag'],
          MaxAgeSeconds: 3000,
        },
      ],
    },
  };
  try {
    await s3Client.send(new PutBucketCorsCommand(corsConfig));
    console.log('S3 CORS設定完了');
  } catch (err) {
    console.error('S3 CORS設定エラー:', err.message);
  }
}

// ── ヘルスチェック ──────────────────────────────────────────
app.get('/health', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json({ ok: true });
});

// ── トンネルURL取得 ─────────────────────────────────────────
app.get('/api/tunnel-status', requireAdmin, (req, res) => {
  res.json({ status: tunnelStatus, url: tunnelUrl });
});

// ── 認証API ─────────────────────────────────────────────────

// POST /api/auth/login
app.post('/api/auth/login', loginLimiter, async (req, res) => {
  try {
    const { nickname, passphrase } = req.body;
    if (!nickname || !passphrase) {
      return res.status(400).json({ error: 'ニックネームと合言葉が必要です' });
    }
    if (typeof nickname !== 'string' || nickname.length > 50) {
      return res.status(400).json({ error: 'ニックネームは50文字以内で入力してください' });
    }
    if (typeof passphrase !== 'string' || passphrase.length > 100) {
      return res.status(400).json({ error: '合言葉が長すぎます' });
    }

    const hash = hashPassphrase(passphrase);
    const { communities } = await readCommunities();
    const community = communities.find(c => c.passphraseHash === hash);
    if (!community) {
      return res.status(401).json({ error: '合言葉が正しくありません' });
    }

    const { users } = await readUsers();
    let token = crypto.randomBytes(32).toString('hex');

    // 既存ユーザーを探す（同じニックネームで同コミュニティに参加済み）
    let user = users.find(u =>
      u.nickname === nickname &&
      u.communityIds?.includes(community.id)
    );

    if (user) {
      // セッション追加（最大10件、古いものを削除）
      if (!user.sessions) user.sessions = [];
      user.sessions.push({ token, createdAt: new Date().toISOString() });
      if (user.sessions.length > 10) {
        user.sessions = user.sessions.slice(user.sessions.length - 10);
      }
      user.lastSeen = new Date().toISOString();
    } else {
      // 新規ユーザー作成
      user = {
        id: uuidv4(),
        nickname,
        communityIds: [community.id],
        sessions: [{ token, createdAt: new Date().toISOString() }],
        createdAt: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
      };
      users.push(user);
    }

    await writeUsers({ users });

    res.json({
      token,
      user: {
        id: user.id,
        nickname: user.nickname,
        communityIds: user.communityIds,
      },
    });
  } catch (err) {
    console.error('ログインエラー:', err);
    res.status(500).json({ error: 'ログイン処理に失敗しました' });
  }
});

// GET /api/auth/me
app.get('/api/auth/me', requireUser, async (req, res) => {
  try {
    const { communities } = await readCommunities();
    const myCommunities = communities.filter(c => req.user.communityIds?.includes(c.id));
    res.json({
      user: {
        id: req.user.id,
        nickname: req.user.nickname,
        communityIds: req.user.communityIds || [],
        communities: myCommunities.map(c => ({ id: c.id, name: c.name })),
      },
    });
  } catch (err) {
    res.status(500).json({ error: '情報取得に失敗しました' });
  }
});

// POST /api/auth/join-community
app.post('/api/auth/join-community', requireUser, async (req, res) => {
  try {
    const { passphrase } = req.body;
    if (!passphrase) return res.status(400).json({ error: '合言葉が必要です' });

    const hash = hashPassphrase(passphrase);
    const { communities } = await readCommunities();
    const community = communities.find(c => c.passphraseHash === hash);
    if (!community) return res.status(401).json({ error: '合言葉が正しくありません' });

    const { users } = await readUsers();
    const user = users.find(u => u.id === req.user.id);
    if (!user) return res.status(404).json({ error: 'ユーザーが見つかりません' });

    if (!user.communityIds) user.communityIds = [];
    if (!user.communityIds.includes(community.id)) {
      user.communityIds.push(community.id);
    }
    user.lastSeen = new Date().toISOString();

    await writeUsers({ users });
    res.json({ ok: true, community: { id: community.id, name: community.name } });
  } catch (err) {
    res.status(500).json({ error: 'コミュニティ参加に失敗しました' });
  }
});

// GET /api/communities/mine
app.get('/api/communities/mine', requireUser, async (req, res) => {
  try {
    const { communities } = await readCommunities();
    const mine = communities.filter(c => req.user.communityIds?.includes(c.id));
    res.json({ communities: mine.map(c => ({ id: c.id, name: c.name })) });
  } catch (err) {
    res.status(500).json({ error: 'コミュニティ一覧取得に失敗しました' });
  }
});

// ── 写真API ──────────────────────────────────────────────────

// 写真一覧キャッシュ
let photoCache = null;
let photoCacheTime = 0;

// GET /api/photos (公開写真のみ、コミュニティ写真を除外)
app.get('/api/photos', requireUser, async (req, res) => {
  const forceRefresh = req.query.refresh === '1';
  const now = Date.now();

  if (!forceRefresh && photoCache && (now - photoCacheTime) < PHOTO_CACHE_TTL) {
    return res.json({ photos: photoCache, cached: true });
  }

  try {
    // 旧パス uploads/ と新パス uploads/public/ の両方を取得
    const [oldData, newData] = await Promise.all([
      s3Client.send(new ListObjectsV2Command({ Bucket: BUCKET_NAME, Prefix: 'uploads/' })),
      // ↑ uploads/ 全体を取得し、community/ を除外する
    ]);

    const allObjects = (oldData.Contents || []).filter(obj => {
      if (obj.Key.endsWith('/')) return false;
      // uploads/community/ は除外
      if (obj.Key.startsWith('uploads/community/')) return false;
      return true;
    });

    allObjects.sort((a, b) => b.LastModified - a.LastModified);

    const photos = await buildPhotoList(allObjects);

    photoCache = photos;
    photoCacheTime = now;
    res.json({ photos, cached: false });
  } catch (err) {
    console.error('写真一覧取得エラー:', err);
    res.status(500).json({ error: '写真一覧の取得に失敗しました' });
  }
});

// GET /api/photos/community/:communityId
app.get('/api/photos/community/:communityId', requireUser, async (req, res) => {
  const { communityId } = req.params;
  if (!/^[0-9a-f-]{36}$/.test(communityId)) {
    return res.status(400).json({ error: '無効なコミュニティIDです' });
  }

  // 参加確認
  if (!req.user.communityIds?.includes(communityId)) {
    return res.status(403).json({ error: 'このコミュニティに参加していません' });
  }

  const forceRefresh = req.query.refresh === '1';
  const now = Date.now();
  const cached = communityPhotoCache.get(communityId);
  if (!forceRefresh && cached && (now - cached.time) < PHOTO_CACHE_TTL) {
    return res.json({ photos: cached.photos, cached: true });
  }

  try {
    const data = await s3Client.send(new ListObjectsV2Command({
      Bucket: BUCKET_NAME,
      Prefix: `uploads/community/${communityId}/`,
    }));

    const objects = (data.Contents || []).filter(obj => !obj.Key.endsWith('/'));
    objects.sort((a, b) => b.LastModified - a.LastModified);

    const photos = await buildPhotoList(objects);
    communityPhotoCache.set(communityId, { photos, time: now });
    res.json({ photos, cached: false });
  } catch (err) {
    console.error('コミュニティ写真取得エラー:', err);
    res.status(500).json({ error: 'コミュニティ写真の取得に失敗しました' });
  }
});

// POST /api/presigned-url
app.post('/api/presigned-url', uploadLimiter, requireUser, async (req, res) => {
  try {
    const { filename, contentType, communityId, fileSize } = req.body;
    if (!filename || !contentType) {
      return res.status(400).json({ error: 'filename と contentType が必要です' });
    }

    const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB
    if (fileSize !== undefined) {
      if (typeof fileSize !== 'number' || fileSize < 0 || fileSize > MAX_FILE_SIZE) {
        return res.status(400).json({ error: 'ファイルサイズは20MB以下にしてください' });
      }
    }

    const totalStorage = await getTotalStorageBytes();
    if (totalStorage >= STORAGE_LIMIT_BYTES) {
      return res.status(403).json({ error: 'ストレージ上限（10GB）に達したため、写真のアップロードができません' });
    }

    if (!ALLOWED_CONTENT_TYPES.has(contentType.toLowerCase())) {
      return res.status(400).json({ error: '画像ファイルのみアップロードできます' });
    }
    const ext = path.extname(filename).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      return res.status(400).json({ error: '対応していないファイル形式です' });
    }

    let key;
    const dateStr = new Date().toISOString().slice(0, 10);

    if (communityId) {
      if (!/^[0-9a-f-]{36}$/.test(communityId)) {
        return res.status(400).json({ error: '無効なコミュニティIDです' });
      }
      if (!req.user.communityIds?.includes(communityId)) {
        return res.status(403).json({ error: 'このコミュニティに参加していません' });
      }
      key = `uploads/community/${communityId}/${dateStr}/${uuidv4()}${ext}`;
    } else {
      key = `uploads/public/${dateStr}/${uuidv4()}${ext}`;
    }

    const command = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
      ContentType: contentType,
    });

    const url = await getSignedUrl(s3Client, command, { expiresIn: UPLOAD_URL_EXPIRY });
    res.json({ url, key });
  } catch (err) {
    console.error('Presigned URL生成エラー:', err);
    res.status(500).json({ error: 'URLの生成に失敗しました' });
  }
});

// POST /api/track-download
app.post('/api/track-download', requireUser, async (req, res) => {
  try {
    const { key, size } = req.body;
    if (!key || typeof size !== 'number' || size < 0 || size > 500 * 1024 * 1024) {
      return res.status(400).json({ error: '無効なパラメータです' });
    }
    const stats = await readDownloadStats();
    stats.totalDownloads = (stats.totalDownloads || 0) + 1;
    stats.totalBytes     = (stats.totalBytes     || 0) + size;
    stats.lastUpdated    = new Date().toISOString();
    await writeDownloadStats(stats);
    res.json({ ok: true });
  } catch (_) {
    res.json({ ok: true });
  }
});

// POST /api/download-zip
app.post('/api/download-zip', requireUser, async (req, res) => {
  try {
    const { keys } = req.body;
    if (!Array.isArray(keys) || keys.length === 0 || keys.length > 30) {
      return res.status(400).json({ error: '無効なキーリストです（1〜30件）' });
    }
    const validKey = /^uploads\/[\w\-./]+$/;
    for (const key of keys) {
      if (typeof key !== 'string' || !validKey.test(key)) {
        return res.status(400).json({ error: '無効なキーが含まれています' });
      }
    }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="wedding-photos.zip"');

    const archive = archiver('zip', { zlib: { level: 1 } });
    archive.pipe(res);

    let totalBytes = 0;
    for (const key of keys) {
      const data = await s3Client.send(new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key }));
      totalBytes += data.ContentLength || 0;
      archive.append(data.Body, { name: path.basename(key) });
    }

    archive.on('finish', () => {
      readDownloadStats().then(stats => {
        stats.totalDownloads = (stats.totalDownloads || 0) + keys.length;
        stats.totalBytes     = (stats.totalBytes     || 0) + totalBytes;
        stats.lastUpdated    = new Date().toISOString();
        return writeDownloadStats(stats);
      }).catch(() => {});
    });

    archive.finalize();
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: 'ZIPの生成に失敗しました' });
  }
});

// POST /api/invalidate-cache
app.post('/api/invalidate-cache', requireUser, (req, res) => {
  photoCache = null;
  photoCacheTime = 0;
  communityPhotoCache.clear();
  res.json({ ok: true });
});

// ── 管理者API ────────────────────────────────────────────────

// GET /api/admin/communities
app.get('/api/admin/communities', requireAdmin, async (req, res) => {
  try {
    const { communities } = await readCommunities();
    res.json({ communities: communities.map(c => ({ id: c.id, name: c.name, passphrase: c.passphrase || null, createdAt: c.createdAt })) });
  } catch (err) {
    res.status(500).json({ error: 'コミュニティ一覧取得に失敗しました' });
  }
});

// POST /api/admin/communities
app.post('/api/admin/communities', requireAdmin, async (req, res) => {
  try {
    const { name, passphrase } = req.body;
    if (!name || !passphrase) return res.status(400).json({ error: '名前と合言葉が必要です' });
    if (typeof name !== 'string' || name.length > 50) return res.status(400).json({ error: '名前は50文字以内で入力してください' });
    if (typeof passphrase !== 'string' || passphrase.length > 100) return res.status(400).json({ error: '合言葉が長すぎます' });

    const { communities } = await readCommunities();
    const community = {
      id: uuidv4(),
      name,
      passphrase,
      passphraseHash: hashPassphrase(passphrase),
      createdAt: new Date().toISOString(),
    };
    communities.push(community);
    await writeCommunities({ communities });
    res.json({ community: { id: community.id, name: community.name, createdAt: community.createdAt } });
  } catch (err) {
    res.status(500).json({ error: 'コミュニティ作成に失敗しました' });
  }
});

// PUT /api/admin/communities/:id
app.put('/api/admin/communities/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!/^[0-9a-f-]{36}$/.test(id)) return res.status(400).json({ error: '無効なIDです' });

    const { name, passphrase } = req.body;
    const { communities } = await readCommunities();
    const community = communities.find(c => c.id === id);
    if (!community) return res.status(404).json({ error: 'コミュニティが見つかりません' });

    if (name) {
      if (typeof name !== 'string' || name.length > 50) return res.status(400).json({ error: '名前は50文字以内で入力してください' });
      community.name = name;
    }

    if (passphrase) {
      if (typeof passphrase !== 'string' || passphrase.length > 100) return res.status(400).json({ error: '合言葉が長すぎます' });
      community.passphrase = passphrase;
      community.passphraseHash = hashPassphrase(passphrase);

      // パスフレーズ変更時: メンバーのcommunityIds削除 + sessions全クリア
      const { users } = await readUsers();
      for (const user of users) {
        if (user.communityIds?.includes(id)) {
          user.communityIds = user.communityIds.filter(cid => cid !== id);
          user.sessions = [];
        }
      }
      await writeUsers({ users });
    }

    await writeCommunities({ communities });
    res.json({ community: { id: community.id, name: community.name, createdAt: community.createdAt } });
  } catch (err) {
    res.status(500).json({ error: 'コミュニティ更新に失敗しました' });
  }
});

// DELETE /api/admin/communities/:id
app.delete('/api/admin/communities/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!/^[0-9a-f-]{36}$/.test(id)) return res.status(400).json({ error: '無効なIDです' });

    const { communities } = await readCommunities();
    const idx = communities.findIndex(c => c.id === id);
    if (idx === -1) return res.status(404).json({ error: 'コミュニティが見つかりません' });

    communities.splice(idx, 1);
    await writeCommunities({ communities });

    // ユーザーからコミュニティ削除
    const { users } = await readUsers();
    for (const user of users) {
      if (user.communityIds?.includes(id)) {
        user.communityIds = user.communityIds.filter(cid => cid !== id);
      }
    }
    await writeUsers({ users });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'コミュニティ削除に失敗しました' });
  }
});

// GET /api/admin/users
app.get('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    const [{ users }, { communities }] = await Promise.all([readUsers(), readCommunities()]);
    const communityMap = Object.fromEntries(communities.map(c => [c.id, c.name]));

    res.json({
      users: users.map(u => ({
        id: u.id,
        nickname: u.nickname,
        communityIds: u.communityIds || [],
        communityNames: (u.communityIds || []).map(id => communityMap[id] || '(削除済み)'),
        lastSeen: u.lastSeen,
        createdAt: u.createdAt,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: 'ユーザー一覧取得に失敗しました' });
  }
});

// DELETE /api/admin/users/:id
app.delete('/api/admin/users/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!/^[0-9a-f-]{36}$/.test(id)) return res.status(400).json({ error: '無効なIDです' });

    const { users } = await readUsers();
    const idx = users.findIndex(u => u.id === id);
    if (idx === -1) return res.status(404).json({ error: 'ユーザーが見つかりません' });

    users.splice(idx, 1);
    await writeUsers({ users });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'ユーザー削除に失敗しました' });
  }
});

// QRコード生成エンドポイント
app.get('/api/qrcode', requireAdmin, async (req, res) => {
  try {
    const rawUrl = req.query.url || tunnelUrl || `http://localhost:${PORT}`;

    let validatedUrl;
    try {
      const parsed = new URL(rawUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return res.status(400).json({ error: 'URLはhttp/httpsで始まる必要があります' });
      }
      validatedUrl = parsed.href;
    } catch (_) {
      return res.status(400).json({ error: '有効なURLを指定してください' });
    }

    const qrDataUrl = await QRCode.toDataURL(validatedUrl, {
      width: 300,
      margin: 2,
      color: { dark: '#1a1a2e', light: '#ffffff' },
    });
    res.json({ qrcode: qrDataUrl, url: validatedUrl });
  } catch (err) {
    res.status(500).json({ error: 'QRコード生成失敗' });
  }
});

// ── ダウンロード統計 ──────────────────────────────────────────
const STATS_KEY = 'stats/downloads.json';

async function readDownloadStats() {
  try {
    const data = await s3Client.send(new GetObjectCommand({ Bucket: BUCKET_NAME, Key: STATS_KEY }));
    const body = await data.Body.transformToString();
    return JSON.parse(body);
  } catch (_) {
    return { totalDownloads: 0, totalBytes: 0, lastUpdated: null };
  }
}

async function writeDownloadStats(stats) {
  await s3Client.send(new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: STATS_KEY,
    Body: JSON.stringify(stats),
    ContentType: 'application/json',
  }));
}

// S3 使用量取得エンドポイント
const S3_FREE_TIER_BYTES      = 5 * 1024 * 1024 * 1024;
const S3_STORAGE_PRICE_PER_GB = 0.025;
const DT_FREE_TIER_BYTES      = 100 * 1024 * 1024 * 1024;
const DT_PRICE_PER_GB         = 0.09;

app.get('/api/s3-usage', requireAdmin, async (req, res) => {
  try {
    let totalBytes = 0;
    let totalCount = 0;
    let continuationToken = undefined;

    const [, dlStats] = await Promise.all([
      (async () => {
        do {
          const cmd = new ListObjectsV2Command({
            Bucket: BUCKET_NAME,
            Prefix: 'uploads/',
            ContinuationToken: continuationToken,
          });
          const data = await s3Client.send(cmd);
          const objects = (data.Contents || []).filter(obj => !obj.Key.endsWith('/'));
          totalCount += objects.length;
          totalBytes += objects.reduce((sum, obj) => sum + (obj.Size || 0), 0);
          continuationToken = data.IsTruncated ? data.NextContinuationToken : undefined;
        } while (continuationToken);
      })(),
      readDownloadStats(),
    ]);

    const storageRemain   = Math.max(0, S3_FREE_TIER_BYTES - totalBytes);
    const storageUsedPct  = Math.min(100, (totalBytes / S3_FREE_TIER_BYTES) * 100);
    const storageOverGB   = Math.max(0, totalBytes - S3_FREE_TIER_BYTES) / (1024 ** 3);
    const storageCost     = storageOverGB * S3_STORAGE_PRICE_PER_GB;

    const dlBytes         = dlStats.totalBytes || 0;
    const dlRemain        = Math.max(0, DT_FREE_TIER_BYTES - dlBytes);
    const dlUsedPct       = Math.min(100, (dlBytes / DT_FREE_TIER_BYTES) * 100);
    const dlOverGB        = Math.max(0, dlBytes - DT_FREE_TIER_BYTES) / (1024 ** 3);
    const dlCost          = dlOverGB * DT_PRICE_PER_GB;

    res.json({
      storage: {
        totalBytes,
        totalCount,
        freeTierBytes: S3_FREE_TIER_BYTES,
        remainBytes: storageRemain,
        usedPct: Math.round(storageUsedPct * 10) / 10,
        isOverFreeTier: totalBytes > S3_FREE_TIER_BYTES,
        estimatedCostUSD: Math.round(storageCost * 10000) / 10000,
      },
      transfer: {
        totalDownloads: dlStats.totalDownloads || 0,
        totalBytes: dlBytes,
        freeTierBytes: DT_FREE_TIER_BYTES,
        remainBytes: dlRemain,
        usedPct: Math.round(dlUsedPct * 10) / 10,
        isOverFreeTier: dlBytes > DT_FREE_TIER_BYTES,
        estimatedCostUSD: Math.round(dlCost * 10000) / 10000,
        lastUpdated: dlStats.lastUpdated || null,
      },
    });
  } catch (err) {
    console.error('S3使用量取得エラー:', err);
    res.status(500).json({ error: 'S3使用量の取得に失敗しました' });
  }
});

// ── ルーティング ──────────────────────────────────────────────
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/gallery', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'gallery.html'));
});

app.get('/gallery/community', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'community-gallery.html'));
});

app.get('/admin', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.listen(PORT, async () => {
  await configureBucketCors();
  console.log(`サーバー起動: http://localhost:${PORT}`);
  console.log(`管理画面:     http://localhost:${PORT}/admin`);

  if (process.env.RENDER) {
    tunnelUrl = process.env.RENDER_EXTERNAL_URL || `https://${process.env.RENDER_SERVICE_NAME}.onrender.com`;
    tunnelStatus = 'ready';
    console.log(`\n========================================`);
    console.log(`  公開URL: ${tunnelUrl}`);
    console.log(`========================================\n`);
  } else {
    startCloudflaredTunnel();
  }
});
