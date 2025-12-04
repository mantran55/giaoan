// server.js
const express = require('express');
const {google} = require('googleapis');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
app.use(express.json());

// === CONFIG from env ===
// FOLDER_ID: Google Drive folder id
// SERVICE_ACCOUNT_JSON_BASE64: base64 encoding of service-account.json
const FOLDER_ID = process.env.FOLDER_ID;
const SA_JSON_B64 = process.env.SERVICE_ACCOUNT_JSON_BASE64;

if (!FOLDER_ID) {
  console.error('ERROR: FOLDER_ID environment variable is required.');
  process.exit(1);
}
if (!SA_JSON_B64) {
  console.error('ERROR: SERVICE_ACCOUNT_JSON_BASE64 environment variable is required.');
  process.exit(1);
}

// Write service account JSON to a temp file (Render ephemeral filesystem is fine at runtime)
const TMP_KEY_PATH = path.join(os.tmpdir(), `sa-${Date.now()}.json`);
try {
  const saJson = Buffer.from(SA_JSON_B64, 'base64').toString('utf8');
  fs.writeFileSync(TMP_KEY_PATH, saJson, {mode: 0o600});
} catch (err) {
  console.error('Failed to write service account JSON:', err);
  process.exit(1);
}

const SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];
const auth = new google.auth.GoogleAuth({
  keyFile: TMP_KEY_PATH,
  scopes: SCOPES,
});
const drive = google.drive({version: 'v3', auth});

// Simple CORS for dev (adjust for production)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); // change in production
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Health
app.get('/_health', (req, res) => res.json({ok: true}));

// List files in folder
app.get('/api/files', async (req, res) => {
  try {
    const q = `'${FOLDER_ID}' in parents and trashed = false`;
    const r = await drive.files.list({
      q,
      fields: 'files(id,name,mimeType,size,createdTime,webViewLink)',
      orderBy: 'createdTime desc',
      pageSize: 500,
    });
    res.json(r.data.files || []);
  } catch (err) {
    console.error('Error list files:', err);
    res.status(500).json({error: 'Không thể lấy danh sách file', detail: err.message});
  }
});

// Download / stream file
app.get('/api/download/:fileId', async (req, res) => {
  const fileId = req.params.fileId;
  if (!fileId) return res.status(400).json({error: 'Missing fileId'});

  try {
    const meta = await drive.files.get({fileId, fields: 'name,mimeType,size'});
    const filename = meta.data.name || 'file';
    const mime = meta.data.mimeType || 'application/octet-stream';

    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
    res.setHeader('Content-Type', mime);

    const driveRes = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });
    driveRes.data
      .on('end', () => { /* done */ })
      .on('error', err => {
        console.error('Error streaming file:', err);
        if (!res.headersSent) res.status(500).end();
      })
      .pipe(res);
  } catch (err) {
    console.error('Error download file:', err);
    res.status(500).json({error: 'Không thể tải file', detail: err.message});
  }
});

// Serve frontend static if exists
const buildPath = path.join(__dirname, 'frontend', 'build');
if (fs.existsSync(buildPath)) {
  app.use(express.static(buildPath));
  // fallback to index.html
  app.get('*', (req, res) => {
    res.sendFile(path.join(buildPath, 'index.html'));
  });
}

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});
