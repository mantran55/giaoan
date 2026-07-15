const express = require('express');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
app.use(express.json());

// === CONFIG from env ===
const FOLDER_ID = process.env.FOLDER_ID;
const SA_JSON_B64 = process.env.SERVICE_ACCOUNT_JSON_BASE64;

if (!FOLDER_ID) console.warn('WARNING: FOLDER_ID not set.');
if (!SA_JSON_B64) console.warn('WARNING: SERVICE_ACCOUNT_JSON_BASE64 not set.');

let TMP_KEY_PATH = '';
try {
  if (SA_JSON_B64) {
    TMP_KEY_PATH = path.join(os.tmpdir(), `sa-${Date.now()}.json`);
    fs.writeFileSync(TMP_KEY_PATH, Buffer.from(SA_JSON_B64, 'base64').toString('utf8'), { mode: 0o600 });
  }
} catch (err) {
  console.error('Failed to write SA JSON:', err);
}

let drive = null;
try {
  if (TMP_KEY_PATH) {
    const SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];
    const auth = new google.auth.GoogleAuth({ keyFile: TMP_KEY_PATH, scopes: SCOPES });
    drive = google.drive({ version: 'v3', auth });
  }
} catch (err) {
  console.error('Drive init error:', err);
}

// CORS
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Health
app.get('/_health', (req, res) => res.json({ ok: true }));

// --- API CHÍNH: LẤY DANH SÁCH FILE/THƯ MỤC ---
// Frontend script.js đang gọi endpoint này
app.get('/api/list', async (req, res) => {
  try {
    if (!drive) return res.status(500).json({ error: 'Drive client not initialized' });
    
    // Lấy folderId từ query, nếu không có thì dùng FOLDER_ID gốc (root)
    const folderId = req.query.folderId || FOLDER_ID;
    if (!folderId) return res.status(400).json({ error: 'folderId is required' });

    const q = `'${folderId}' in parents and trashed = false`;
    const r = await drive.files.list({
      q,
      fields: 'files(id,name,mimeType,size,createdTime,webViewLink)',
      orderBy: 'folder,name,createdTime desc',
      pageSize: 1000,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true
    });

    const items = r.data.files || [];
    // Tách biệt folder và file để frontend dễ xử lý
    const folders = items.filter(it => it.mimeType === 'application/vnd.google-apps.folder');
    const files = items.filter(it => it.mimeType !== 'application/vnd.google-apps.folder');

    res.json({ folderId, folders, files });
  } catch (err) {
    console.error('/api/list error:', err);
    res.status(500).json({ error: 'Không thể lấy danh sách', detail: err.message });
  }
});

// --- API TẢI FILE ---
app.get('/api/download/:fileId', async (req, res) => {
  try {
    if (!drive) return res.status(500).json({ error: 'Drive client not initialized' });
    const fileId = req.params.fileId;
    if (!fileId) return res.status(400).json({ error: 'fileId required' });

    const meta = await drive.files.get({ fileId, fields: 'name,mimeType,size', supportsAllDrives: true });
    const filename = meta.data.name || 'file';
    const mime = meta.data.mimeType || 'application/octet-stream';

    // SỬA LỖI TÊN FILE CHO MAC/IPHONE (RFC 5987)
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);

    const driveRes = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream', supportsAllDrives: true });
    driveRes.data.on('error', err => {
      console.error('Stream error:', err);
      if (!res.headersSent) res.status(500).end();
    }).pipe(res);
  } catch (err) {
    console.error('/api/download error:', err);
    res.status(500).json({ error: err.message || 'download failed' });
  }
});

// --- API XEM TRƯỚC POWERPOINT ---
// Microsoft Office Viewer sẽ tải nội dung từ URL này để hiển thị trong iframe.
app.get('/api/preview/:fileId', async (req, res) => {
  try {
    if (!drive) return res.status(500).json({ error: 'Drive client not initialized' });
    const fileId = req.params.fileId;
    if (!fileId) return res.status(400).json({ error: 'fileId required' });

    const meta = await drive.files.get({ fileId, fields: 'name,mimeType', supportsAllDrives: true });
    const sourceMime = meta.data.mimeType || 'application/octet-stream';
    const isGooglePresentation = sourceMime === 'application/vnd.google-apps.presentation';
    const filename = meta.data.name || 'presentation';
    const previewMime = isGooglePresentation
      ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
      : sourceMime;
    const previewName = isGooglePresentation ? filename.replace(/\.[^.]+$/, '') + '.pptx' : filename;

    res.setHeader('Content-Type', previewMime);
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(previewName)}`);

    const driveRes = isGooglePresentation
      ? await drive.files.export({ fileId, mimeType: previewMime, supportsAllDrives: true }, { responseType: 'stream' })
      : await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream', supportsAllDrives: true });

    driveRes.data.on('error', err => {
      console.error('Preview stream error:', err);
      if (!res.headersSent) res.status(500).end();
    }).pipe(res);
  } catch (err) {
    console.error('/api/preview error:', err);
    res.status(500).json({ error: err.message || 'preview failed' });
  }
});

// Serve static frontend
const buildPath = path.join(__dirname, 'frontend', 'build');
if (fs.existsSync(buildPath)) {
  app.use(express.static(buildPath));
  app.get('*', (req, res) => res.sendFile(path.join(buildPath, 'index.html')));
}

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Server started on port ${PORT}`));
