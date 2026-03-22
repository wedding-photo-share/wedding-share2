const express = require('express');
const { S3Client, PutObjectCommand, PutBucketCorsCommand, ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');
const { spawn } = require('child_process');
const path = require('path');

const app = express();
app.use(express.json({ limit: '10kb' }));

// セキュリティヘッダー
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
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

const s3Client = new S3Client({ region: REGION });

// トンネルURLを保持
let tunnelUrl = null;
let tunnelStatus = 'starting'; // 'starting' | 'ready' | 'error'

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

  // プロセス終了時にトンネルも終了
  process.on('exit', () => cf.kill());
  process.on('SIGINT', () => { cf.kill(); process.exit(0); });
}

// S3バケットにCORSを設定
async function configureBucketCors() {
  const corsConfig = {
    Bucket: BUCKET_NAME,
    CORSConfiguration: {
      CORSRules: [
        {
          AllowedHeaders: ['*'],
          AllowedMethods: ['PUT', 'POST', 'GET'],
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

// ヘルスチェック（GitHub Pages の待機画面がポーリング）
app.get('/health', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json({ ok: true });
});

// トンネルURL取得エンドポイント（管理画面がポーリング）
app.get('/api/tunnel-status', (req, res) => {
  res.json({ status: tunnelStatus, url: tunnelUrl });
});

// Presigned URL生成エンドポイント
app.post('/api/presigned-url', async (req, res) => {
  try {
    const { filename, contentType } = req.body;
    if (!filename || !contentType) {
      return res.status(400).json({ error: 'filename と contentType が必要です' });
    }

    // ファイルタイプ検証（画像のみ許可）
    if (!ALLOWED_CONTENT_TYPES.has(contentType.toLowerCase())) {
      return res.status(400).json({ error: '画像ファイルのみアップロードできます' });
    }
    const ext = path.extname(filename).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      return res.status(400).json({ error: '対応していないファイル形式です' });
    }

    const key = `uploads/${new Date().toISOString().slice(0, 10)}/${uuidv4()}${ext}`;

    const command = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
      ContentType: contentType,
    });

    const url = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
    res.json({ url, key });
  } catch (err) {
    console.error('Presigned URL生成エラー:', err);
    res.status(500).json({ error: 'URLの生成に失敗しました' });
  }
});

// QRコード生成エンドポイント
app.get('/api/qrcode', async (req, res) => {
  try {
    const baseUrl = req.query.url || tunnelUrl || `http://localhost:${PORT}`;
    const qrDataUrl = await QRCode.toDataURL(baseUrl, {
      width: 300,
      margin: 2,
      color: { dark: '#1a1a2e', light: '#ffffff' },
    });
    res.json({ qrcode: qrDataUrl, url: baseUrl });
  } catch (err) {
    res.status(500).json({ error: 'QRコード生成失敗' });
  }
});

// 写真一覧キャッシュ（presigned URLの有効期限3600秒に合わせ50分でキャッシュ）
const PHOTO_CACHE_TTL = 50 * 60 * 1000;
let photoCache = null;
let photoCacheTime = 0;

// 写真一覧取得エンドポイント
app.get('/api/photos', async (req, res) => {
  // 新しい写真が追加された後も反映されるよう、強制更新クエリをサポート
  const forceRefresh = req.query.refresh === '1';
  const now = Date.now();

  if (!forceRefresh && photoCache && (now - photoCacheTime) < PHOTO_CACHE_TTL) {
    return res.json({ photos: photoCache, cached: true });
  }

  try {
    const listCommand = new ListObjectsV2Command({
      Bucket: BUCKET_NAME,
      Prefix: 'uploads/',
    });
    const data = await s3Client.send(listCommand);

    const objects = (data.Contents || []).filter(obj => !obj.Key.endsWith('/'));
    objects.sort((a, b) => b.LastModified - a.LastModified);

    const photos = await Promise.all(objects.map(async (obj) => {
      const viewUrl = await getSignedUrl(s3Client, new GetObjectCommand({
        Bucket: BUCKET_NAME,
        Key: obj.Key,
      }), { expiresIn: 3600 });

      const downloadUrl = await getSignedUrl(s3Client, new GetObjectCommand({
        Bucket: BUCKET_NAME,
        Key: obj.Key,
        ResponseContentDisposition: `attachment; filename="${path.basename(obj.Key)}"`,
      }), { expiresIn: 3600 });

      return {
        key: obj.Key,
        filename: path.basename(obj.Key),
        viewUrl,
        downloadUrl,
        lastModified: obj.LastModified,
        size: obj.Size,
      };
    }));

    photoCache = photos;
    photoCacheTime = now;
    res.json({ photos, cached: false });
  } catch (err) {
    console.error('写真一覧取得エラー:', err);
    res.status(500).json({ error: '写真一覧の取得に失敗しました' });
  }
});

// 写真アップロード後にキャッシュを破棄
app.post('/api/invalidate-cache', (req, res) => {
  photoCache = null;
  photoCacheTime = 0;
  res.json({ ok: true });
});

// ギャラリーページ
app.get('/gallery', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'gallery.html'));
});

// 管理画面
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.listen(PORT, async () => {
  await configureBucketCors();
  console.log(`サーバー起動: http://localhost:${PORT}`);
  console.log(`管理画面:     http://localhost:${PORT}/admin`);

  // Render.com上ではcloudflaredは不要。固定URLをそのまま使用する
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
