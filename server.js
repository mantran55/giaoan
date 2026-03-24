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

// API để lấy link xem trước (Preview)
app.get('/api/preview/:fileId', async (req, res) => {
  try {
    if (!drive) return res.status(500).json({ error: 'Drive client not initialized' });
    const fileId = req.params.fileId;
    
    // Lấy thông tin file để kiểm tra định dạng (mimeType)
    const meta = await drive.files.get({ fileId, fields: 'mimeType, name', supportsAllDrives: true });
    const mimeType = meta.data.mimeType;
    const fileName = meta.data.name;

    // 1. Nếu là Google Slides hoặc Google Docs -> Xuất ra PDF trực tiếp
    if (mimeType === 'application/vnd.google-apps.presentation' || mimeType === 'application/vnd.google-apps.document') {
      // Redirect đến link xuất PDF của Google
      const exportUrl = `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=application/pdf&key=${process.env.GOOGLE_API_KEY}`;
      // Lưu ý: Cách đơn giản nhất là dùng stream để tránh lộ key, nhưng ở đây ta dùng redirect có auth
      // Ta sẽ pipe dữ liệu pdf để đảm bảo bảo mật
      const pdfRes = await drive.files.export({ fileId, mimeType: 'application/pdf' }, { responseType: 'stream' });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(fileName)}.pdf"`);
      pdfRes.data.pipe(res);
    } 
    // 2. Nếu là file PDF gốc -> Đọc và hiển thị
    else if (mimeType === 'application/pdf') {
      const driveRes = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream', supportsAllDrives: true });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(fileName)}"`);
      driveRes.data.pipe(res);
    }
    // 3. Với các file khác (PPTX, DOCX, Ảnh) -> Trả về link view của Google
    // Vì server không thể chuyển PPTX ra PDF nhanh, ta dùng Google Viewer
    else {
      // Trả về một URL để client mở trong iframe mới
      res.json({ 
        previewUrl: `https://drive.google.com/file/d/${fileId}/preview`,
        type: 'external' 
      });
    }
  } catch (err) {
    console.error('Preview error:', err);
    res.status(500).json({ error: 'Cannot preview this file' });
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

    // --- BẮT ĐẦU PHẦN SỬA LỖI TÊN FILE CHO MAC/IPHONE ---
    // Chuẩn hóa tên file: Loại bỏ ký tự đặc biệt gây lỗi trên iOS
    let safeFilename = filename;
    // Thay thế dấu ngoặc kép, dấu hai chấu... nếu cần, hoặc giữ nguyên nếu muốn
    // Quan trọng nhất là thiết lập header chuẩn RFC 5987
    res.setHeader('Content-Type', mime);
    // Dùng filename*=UTF-8'' để Safari hiểu tiếng Việt và khoảng trắng
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    // --- KẾT THÚC PHẦN SỬA ---

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
