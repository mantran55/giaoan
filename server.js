// server.js (đã bao gồm phần auth google và drive từ trước)
// Assumes you already wrote SA JSON to TMP_KEY_PATH and created `drive` object
const express = require('express');
const {google} = require('googleapis');
const fs = require('fs');
const path = require('path');
const os = require('os');
const multer = require('multer');

const app = express();
app.use(express.json());

// --- EXISTING CONFIG (from previous code) ---
const FOLDER_ID = process.env.FOLDER_ID; // root folder id
const SA_JSON_B64 = process.env.SERVICE_ACCOUNT_JSON_BASE64;
if (!FOLDER_ID || !SA_JSON_B64) {
  console.error('FOLDER_ID and SERVICE_ACCOUNT_JSON_BASE64 required');
  process.exit(1);
}
// write SA file to tmp... (same as before)
const TMP_KEY_PATH = path.join(os.tmpdir(), `sa-${Date.now()}.json`);
fs.writeFileSync(TMP_KEY_PATH, Buffer.from(SA_JSON_B64, 'base64').toString('utf8'), {mode: 0o600});

const SCOPES = ['https://www.googleapis.com/auth/drive'];
const auth = new google.auth.GoogleAuth({ keyFile: TMP_KEY_PATH, scopes: SCOPES });
const drive = google.drive({version: 'v3', auth});

// --- Category mapping ---
// Provide mapping by ENV: CATEGORIES_JSON (a JSON string) OR default hardcoded.
// Format: {"Năm 1":"<folderId-or-empty>","Năm 2":"","Bài Hát Sinh Hoạt":"","Tài Liệu Giáo Án":""}
let CATEGORY_MAP = {};
if (process.env.CATEGORIES_JSON) {
  try { CATEGORY_MAP = JSON.parse(process.env.CATEGORIES_JSON); } catch(e) { CATEGORY_MAP = {}; }
} else {
  // default categories (folder ids empty => will create under FOLDER_ID root when first used)
  CATEGORY_MAP = {
    "Năm 1": "",
    "Năm 2": "",
    "Bài Hát Sinh Hoạt": "",
    "Tài Liệu Giáo Án": ""
  };
}

// helper: get/create folder for category, returns folderId
async function ensureCategoryFolder(categoryName) {
  if (!categoryName) categoryName = 'Uncategorized';
  // if mapped and non-empty -> return
  if (CATEGORY_MAP[categoryName]) return CATEGORY_MAP[categoryName];

  // try to find folder under root with that name (prevent duplicates)
  const q = `name = '${categoryName.replace(/'/g, "\\'")}' and '${FOLDER_ID}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const resp = await drive.files.list({ q, fields: 'files(id,name)', pageSize: 5 });
  if (resp.data.files && resp.data.files.length > 0) {
    const id = resp.data.files[0].id;
    CATEGORY_MAP[categoryName] = id;
    return id;
  }

  // create new folder under root
  const createRes = await drive.files.create({
    requestBody: {
      name: categoryName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [FOLDER_ID],
    },
    fields: 'id,name'
  });
  const newId = createRes.data.id;
  CATEGORY_MAP[categoryName] = newId;
  // Note: the in-memory map is updated, but not persisted. To persist, store in DB or update environment variable.
  return newId;
}

// --- Multer setup (store in memory) ---
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 } // 200MB limit adjust as needed
});

// --- API: get categories (with folderId if exists) ---
app.get('/api/categories', (req, res) => {
  // return array of {name, folderId}
  const arr = Object.keys(CATEGORY_MAP).map(k => ({ name: k, folderId: CATEGORY_MAP[k] || null }));
  res.json(arr);
});

// --- API: upload file to category ---
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    const category = req.body.category || 'Uncategorized';
    const uploaderName = req.body.uploader || 'anonymous';

    if (!file) return res.status(400).json({ error: 'No file uploaded' });

    // ensure folder exists
    const folderId = await ensureCategoryFolder(category);

    // upload file to Drive under folderId
    const media = {
      mimeType: file.mimetype,
      body: Buffer.from(file.buffer)
    };

    // googleapis expects a stream or readable; Buffer works via passing buffer in requestBody? use drive.files.create with media.body as stream:
    // create a temp file or use streamifier. Simpler: create readable stream from buffer:
    const {Readable} = require('stream');
    const stream = new Readable();
    stream._read = () => {};
    stream.push(file.buffer);
    stream.push(null);

    const createRes = await drive.files.create({
      requestBody: {
        name: file.originalname,
        parents: [folderId],
      },
      media: {
        mimeType: file.mimetype,
        body: stream
      },
      fields: 'id,name,mimeType,size,webViewLink'
    });

    // Optionally set file permission to anyone with link (if you want public downloads)
    // await drive.permissions.create({fileId: createRes.data.id, requestBody: {role: 'reader', type: 'anyone'} });

    res.json({ ok: true, file: createRes.data, category });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: 'Upload failed', detail: err.message });
  }
});

// --- Existing list by category endpoint ---
// GET /api/list?category=Name
app.get('/api/list-by-category', async (req, res) => {
  try {
    const category = req.query.category;
    let folderId = FOLDER_ID;
    if (category) {
      if (CATEGORY_MAP[category]) folderId = CATEGORY_MAP[category];
      else {
        // if not exist, return empty or create? we return empty and client can create via upload
        return res.json({ folderId: null, folders: [], files: [] });
      }
    }
    // reuse existing /api/list code logic (or inline)
    const q = `'${folderId}' in parents and trashed = false`;
    const r = await drive.files.list({
      q,
      fields: 'files(id,name,mimeType,size,createdTime,webViewLink)',
      orderBy: 'folder,name,createdTime desc',
      pageSize: 1000,
    });
    const items = r.data.files || [];
    const folders = items.filter(it => it.mimeType === 'application/vnd.google-apps.folder');
    const files = items.filter(it => it.mimeType !== 'application/vnd.google-apps.folder');
    res.json({ folderId, folders, files });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// --- keep previous /api/list and /api/download endpoints as before ---
// ... (ensure these are present, as earlier provided)

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log('Server running on', PORT));
