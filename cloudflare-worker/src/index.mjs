const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';

let accessTokenCache = null;

function corsHeaders(headers = {}) {
  return new Headers({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    ...headers,
  });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: corsHeaders({ 'Content-Type': 'application/json; charset=utf-8' }),
  });
}

function base64Url(input) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function pemToArrayBuffer(pem) {
  const base64 = pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, '');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function getAccessToken(env) {
  if (accessTokenCache && accessTokenCache.expiresAt > Date.now() + 60_000) {
    return accessTokenCache.token;
  }

  if (!env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not configured');
  }

  const account = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: account.private_key_id }));
  const claims = base64Url(JSON.stringify({
    iss: account.client_email,
    scope: DRIVE_SCOPE,
    aud: account.token_uri || 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));
  const unsignedToken = `${header}.${claims}`;
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(account.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    key,
    new TextEncoder().encode(unsignedToken),
  );
  const assertion = `${unsignedToken}.${base64Url(signature)}`;
  const tokenResponse = await fetch(account.token_uri || 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });

  if (!tokenResponse.ok) throw new Error(`Google OAuth failed: ${await tokenResponse.text()}`);
  const token = await tokenResponse.json();
  accessTokenCache = {
    token: token.access_token,
    expiresAt: Date.now() + Number(token.expires_in || 3600) * 1000,
  };
  return accessTokenCache.token;
}

async function driveFetch(env, path, init = {}) {
  const token = await getAccessToken(env);
  return fetch(`${DRIVE_API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) },
  });
}

function validDriveId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]+$/.test(id);
}

async function listFiles(request, env) {
  const url = new URL(request.url);
  const folderId = url.searchParams.get('folderId') || env.FOLDER_ID;
  if (!validDriveId(folderId)) return json({ error: 'folderId is required or invalid' }, 400);

  const params = new URLSearchParams({
    q: `'${folderId}' in parents and trashed = false`,
    fields: 'files(id,name,mimeType,size,createdTime,webViewLink)',
    orderBy: 'folder,name,createdTime desc',
    pageSize: '1000',
    includeItemsFromAllDrives: 'true',
    supportsAllDrives: 'true',
  });
  const response = await driveFetch(env, `/files?${params}`);
  if (!response.ok) return json({ error: 'Không thể lấy danh sách', detail: await response.text() }, response.status);

  const data = await response.json();
  const items = data.files || [];
  return json({
    folderId,
    folders: items.filter((item) => item.mimeType === 'application/vnd.google-apps.folder'),
    files: items.filter((item) => item.mimeType !== 'application/vnd.google-apps.folder'),
  });
}

async function downloadFile(fileId, env) {
  if (!validDriveId(fileId)) return json({ error: 'fileId is invalid' }, 400);

  const metadata = await driveFetch(env, `/files/${fileId}?fields=name,mimeType,size&supportsAllDrives=true`);
  if (!metadata.ok) return json({ error: 'Không thể lấy thông tin tệp', detail: await metadata.text() }, metadata.status);
  const file = await metadata.json();
  const fileResponse = await driveFetch(env, `/files/${fileId}?alt=media&supportsAllDrives=true`);
  if (!fileResponse.ok) return json({ error: 'Không thể tải tệp', detail: await fileResponse.text() }, fileResponse.status);

  return new Response(fileResponse.body, {
    headers: corsHeaders({
      'Content-Type': file.mimeType || 'application/octet-stream',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name || 'file')}`,
    }),
  });
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() });
      if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
      if (url.pathname === '/_health') return json({ ok: true });
      if (url.pathname === '/api/list') return listFiles(request, env);

      const downloadMatch = url.pathname.match(/^\/api\/download\/([^/]+)$/);
      if (downloadMatch) return downloadFile(downloadMatch[1], env);
      return json({ error: 'Not found' }, 404);
    } catch (error) {
      console.error(error);
      return json({ error: error.message || 'Internal server error' }, 500);
    }
  },
};
