// server.js
const express = require("express");
const { google } = require("googleapis");
const fs = require("fs");
const path = require("path");
const os = require("os");
const multer = require("multer");
const { Readable } = require("stream");
const cors = require('cors');
// allow only your dev origin (better) or use { origin: '*' } to allow all
app.use(cors({
  origin: 'http://127.0.0.1:5500' // hoặc '*' nếu bạn muốn tạm cho mọi origin
}));


const app = express();
app.use(express.json());

// ─────────────────────────────────────────────
// 1) Load ENV
// ─────────────────────────────────────────────
const FOLDER_ID = process.env.FOLDER_ID;  
const SA_JSON_B64 = process.env.SERVICE_ACCOUNT_JSON_BASE64;
const CATEGORIES_JSON = process.env.CATEGORIES_JSON || "";

if (!FOLDER_ID || !SA_JSON_B64) {
  console.error("❌ ERROR: Missing FOLDER_ID or SERVICE_ACCOUNT_JSON_BASE64");
  process.exit(1);
}

// write service account JSON to temp file
const TMP_KEY_PATH = path.join(os.tmpdir(), `sa-${Date.now()}.json`);
fs.writeFileSync(
  TMP_KEY_PATH,
  Buffer.from(SA_JSON_B64, "base64").toString("utf8"),
  { mode: 0o600 }
);

// init drive
const auth = new google.auth.GoogleAuth({
  keyFile: TMP_KEY_PATH,
  scopes: ["https://www.googleapis.com/auth/drive"],
});
const drive = google.drive({ version: "v3", auth });

// ─────────────────────────────────────────────
// 2) CATEGORY MAP
// ─────────────────────────────────────────────
let CATEGORY_MAP = {};

try {
  CATEGORY_MAP = CATEGORIES_JSON ? JSON.parse(CATEGORIES_JSON) : {
    "Năm 1": "",
    "Năm 2": "",
    "Bài Hát Sinh Hoạt": "",
    "Tài Liệu Giáo Án": ""
  };
} catch (e) {
  CATEGORY_MAP = {};
}

// ensure category folder exists
async function ensureCategoryFolder(categoryName) {
  if (!categoryName) categoryName = "Uncategorized";

  if (CATEGORY_MAP[categoryName]) return CATEGORY_MAP[categoryName];

  // search if folder exists
  const q = `name='${categoryName}' and '${FOLDER_ID}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const search = await drive.files.list({
    q, fields: "files(id,name)", pageSize: 5
  });

  if (search.data.files.length > 0) {
    CATEGORY_MAP[categoryName] = search.data.files[0].id;
    return CATEGORY_MAP[categoryName];
  }

  // create folder
  const created = await drive.files.create({
    requestBody: {
      name: categoryName,
      mimeType: "application/vnd.google-apps.folder",
      parents: [FOLDER_ID]
    },
    fields: "id,name"
  });

  CATEGORY_MAP[categoryName] = created.data.id;
  return created.data.id;
}

// ─────────────────────────────────────────────
// 3) Upload Setup
// ─────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 }
});

// ─────────────────────────────────────────────
// 4) API: categories
// ─────────────────────────────────────────────

app.get("/api/categories", (req, res) => {
  res.json(
    Object.keys(CATEGORY_MAP).map(name => ({
      name,
      folderId: CATEGORY_MAP[name] || null
    }))
  );
});

// ─────────────────────────────────────────────
// 5) API: upload
// ─────────────────────────────────────────────

app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const category = req.body.category || "Uncategorized";
    const uploader = req.body.uploader || "";

    const folderId = await ensureCategoryFolder(category);

    // Convert buffer to stream
    const stream = new Readable();
    stream._read = () => {};
    stream.push(req.file.buffer);
    stream.push(null);

    const uploaded = await drive.files.create({
      requestBody: {
        name: req.file.originalname,
        parents: [folderId]
      },
      media: {
        mimeType: req.file.mimetype,
        body: stream
      },
      fields: "id,name,mimeType,size,webViewLink"
    });

    res.json({
      ok: true,
      file: uploaded.data,
      category,
      uploader
    });

  } catch (err) {
    console.error("❌ Upload error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// 6) API: list folder (folders + files)
// ─────────────────────────────────────────────

app.get("/api/list", async (req, res) => {
  try {
    const folderId = req.query.folderId || FOLDER_ID;

    const q = `'${folderId}' in parents and trashed=false`;
    const r = await drive.files.list({
      q,
      fields: "files(id,name,mimeType,size,webViewLink,createdTime)",
      pageSize: 1000
    });

    const items = r.data.files || [];
    const folders = items.filter(x => x.mimeType === "application/vnd.google-apps.folder");
    const files = items.filter(x => x.mimeType !== "application/vnd.google-apps.folder");

    res.json({ folderId, folders, files });

  } catch (err) {
    console.error("❌ list error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// 7) API: list by category
// ─────────────────────────────────────────────

app.get("/api/list-by-category", async (req, res) => {
  try {
    const category = req.query.category;

    if (!category || !CATEGORY_MAP[category])
      return res.json({ folderId: null, folders: [], files: [] });

    const folderId = CATEGORY_MAP[category];

    const q = `'${folderId}' in parents and trashed=false`;
    const r = await drive.files.list({
      q,
      fields: "files(id,name,mimeType,size,webViewLink,createdTime)",
      pageSize: 1000
    });

    const items = r.data.files || [];
    const folders = items.filter(x =>
      x.mimeType === "application/vnd.google-apps.folder"
    );
    const files = items.filter(x =>
      x.mimeType !== "application/vnd.google-apps.folder"
    );

    res.json({ folderId, folders, files });

  } catch (err) {
    console.error("❌ list-by-category error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// 8) API: download
// ─────────────────────────────────────────────

app.get("/api/download/:fileId", async (req, res) => {
  try {
    const fileId = req.params.fileId;

    const meta = await drive.files.get({
      fileId,
      fields: "name,mimeType,size"
    });

    res.setHeader("Content-Disposition",
      `attachment; filename="${encodeURIComponent(meta.data.name)}"`);
    res.setHeader("Content-Type", meta.data.mimeType);

    const driveRes = await drive.files.get(
      { fileId, alt: "media" },
      { responseType: "stream" }
    );

    driveRes.data.pipe(res);

  } catch (err) {
    console.error("❌ download error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// 9) PORT
// ─────────────────────────────────────────────

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log("✅ Server is running on port", PORT);
});

