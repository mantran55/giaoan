// server.js - simplified: only list folders/files and download from Google Drive
const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const os = require('os');

process.on('unhandledRejection', (r) => console.error('UnhandledRejection', r));
process.on('uncaughtException', (e) => console.error('UncaughtException', e));

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// Required envs
const FOLDER_ID = process.env.FOLDER_ID || '';
const SA_JSON_B64 = process.env.SERVICE_ACCOUNT_JSON_BASE64 || '';

if (!FOLDER_ID) console.warn('WARNING: FOLDER_ID not set.');
if (!SA_JSON_B64) console.warn('WARNING: SERVICE_ACCOUNT_JSON_BASE64 not set.');

let TMP_KEY_PATH = '';
try {
  if (SA_JSON_B64) {
    TMP_KEY_PATH = path.join(os.tmpdir(), `sa-${Date.now()}.json`);
    fs.writeFileSync(TMP_KEY_PATH, Buffer.from(SA_JSON_B64, 'base64').toString('utf8'), { mode: 0o600 });
    console.log('Service account JSON written to', TMP_KEY_PATH);
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
    console.log('Drive client initialized');
  } else {
    console.warn('Drive client not initialized due to missing SA JSON');
  }
} catch (err) {
  console.error('Drive init error:', err);
}

// Basic categories (names only). If you used CATEGORIES_JSON before, you can still set it.
let CATEGORY_MAP = {};
try {
  if (process.env.CATEGORIES_JSON) {
    CATEGORY_MAP = JSON.parse(process.env.CATEGORIES_JSON);
  } else {
    CATEGORY_MAP = {
      "Năm 1": "",
      "Năm 2": "",
      "Bài Hát Sinh Hoạt": "",
      "Tài Liệu Giáo Án": ""
    };
  }
} catch (err) {
  console.error('Failed to parse CATEGORIES_JSON, using defaults', err);
  CATEGORY_MAP = {
    "Năm 1": "",
    "Năm 2": "",
    "Bài Hát Sinh Hoạt": "",
    "Tài Liệu Giáo Án": ""
  };
}

// Health
app.get('/_health', (req, res) => res.json({ ok: true }));

// Categories (names + folderId if known)
app.get('/api/categories', (req, res) => {
  const arr = Object.keys(CATEGORY_MAP).map(k => ({ name: k, folderId: CATEGORY_MAP[k] || null }));
  res.json(arr);
});

// List children of a folder (folders + files)
app.get('/api/list', async (req, res) => {
  try {
    if (!drive) return res.status(500).json({ error: 'Drive client not initialized' });
    const folderId = req.query.folderId || FOLDER_ID;
    if (!folderId) return res.status(400).json({ error: 'folderId query or FOLDER_ID env required' });

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
    const folders = items.filter(it => it.mimeType === 'application/vnd.google-apps.folder');
    const files = items.filter(it => it.mimeType !== 'application/vnd.google-apps.folder');
    res.json({ folderId, folders, files });
  } catch (err) {
    console.error('/api/list error:', err && err.stack ? err.stack : err);
    res.status(500).json({ error: err.message || 'list failed' });
  }
});

// List by category (if CATEGORY_MAP has folderId)
app.get('/api/list-by-category', async (req, res) => {
  try {
    if (!drive) return res.status(500).json({ error: 'Drive client not initialized' });
    const category = req.query.category;
    if (!category) return res.status(400).json({ error: 'category query required' });
    const folderId = CATEGORY_MAP[category];
    if (!folderId) return res.json({ folderId: null, folders: [], files: [] });

    const q = `'${folderId}' in parents and trashed = false`;
    const r = await drive.files.list({
      q,
      fields: 'files(id,name,mimeType,size,createdTime,webViewLink)',
      pageSize: 1000,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true
    });
    const items = r.data.files || [];
    res.json({ folderId, folders: items.filter(i => i.mimeType === 'application/vnd.google-apps.folder'), files: items.filter(i => i.mimeType !== 'application/vnd.google-apps.folder') });
  } catch (err) {
    console.error('/api/list-by-category error:', err && err.stack ? err.stack : err);
    res.status(500).json({ error: err.message || 'list-by-category failed' });
  }
});

// Download / stream file
app.get('/api/download/:fileId', async (req, res) => {
  try {
    if (!drive) return res.status(500).json({ error: 'Drive client not initialized' });
    const fileId = req.params.fileId;
    if (!fileId) return res.status(400).json({ error: 'fileId required' });

    const meta = await drive.files.get({ fileId, fields: 'name,mimeType,size', supportsAllDrives: true });
    const filename = meta.data.name || 'file';
    const mime = meta.data.mimeType || 'application/octet-stream';

    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
    res.setHeader('Content-Type', mime);

    const driveRes = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream', supportsAllDrives: true });
    driveRes.data.on('error', err => {
      console.error('Stream error:', err);
      if (!res.headersSent) res.status(500).end();
    }).pipe(res);
  } catch (err) {
    console.error('/api/download error:', err && err.stack ? err.stack : err);
    res.status(500).json({ error: err.message || 'download failed' });
  }
});

// Serve static if exists
const buildPath = path.join(__dirname, 'frontend', 'build');
if (fs.existsSync(buildPath)) {
  app.use(express.static(buildPath));
  app.get('*', (req, res) => res.sendFile(path.join(buildPath, 'index.html')));
}

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Server listening on ${PORT}`));
