/* ==========================================================================
   おせっ会 浜松 (Osekkai Hamamatsu) - Persistent Backend API & Web Server
   Node.js Standard Library HTTP + File Storage (db.json) + LAN Access
   ========================================================================== */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'db.json');

// --- 運営者（目視確認）用APIの管理パスコード（第3弾） ---
// 申請一覧の取得や承認・差し戻しには、リクエストヘッダ
// 「X-Admin-Passcode」にこの値と一致するパスコードが必要です。
// ★ 仮の初期値です。本格運用の前に必ず変更してください。
//   変更方法: 環境変数 OSEKKAI_ADMIN_PASSCODE を設定するか、
//   下の初期値文字列自体を書き換えてください（詳細は REPORT.md 第3弾）。
const ADMIN_PASSCODE = process.env.OSEKKAI_ADMIN_PASSCODE || 'osekkai-admin-2026';

// --- 本人確認写真の保存先: Vercel Blob 対応（第4弾） ---
// 環境変数 BLOB_READ_WRITE_TOKEN がある環境では、本人確認の写真バイナリと
// 申請メタデータ（JSON）を Vercel Blob に保存します。Vercel（サーバーレス）
// では db.json への書き込みが永続化されないため、写真申請だけでも Blob に
// 逃がすことで「利用者が送った写真が運営者に届き続ける」状態にします。
// トークンが無い環境（ローカル・テスト）では従来どおり db.json に写真の
// データURLごと保存する方式（inline）にフォールバックします。
//
// Blob 上の配置（申請IDごとに2ファイル）:
//   verify-requests/<申請ID>/photo.<拡張子>  … 写真バイナリ（非公開: access 'private'）
//   verify-requests/<申請ID>/meta.json       … 申請メタデータ（写真データ自体は含まない）
// 第5弾: 写真とメタデータは非公開（private）で保存します。写真の URL は
// サーバー内部の記録にのみ保持し、API レスポンスには一切含めません。
// 運営者が写真を見るのは、パスコード必須の運営者一覧APIの中で、サーバーが
// トークンを使って取得した写真をデータURLに変換して返す場合だけです。
//   verify-requests/<申請ID>/meta.json       … 申請メタデータ（写真データ自体は含まない）
// メタデータも Blob に置くのは、写真だけ残して申請情報が消えると運営者が
// 確認作業をできないためです（判断の詳細は REPORT.md 第4弾）。
const VERIFY_BLOB_PREFIX = 'verify-requests/';

let blobClientCache; // undefined=未試行 / null=利用不可 / object=@vercel/blob モジュール
function loadBlobClient() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return null;
  if (blobClientCache !== undefined) return blobClientCache;
  try {
    // 通常は npm パッケージ '@vercel/blob' を読みます。テストでは
    // OSEKKAI_BLOB_MODULE_PATH にモックモジュールのパスを指定できます。
    const modulePath = process.env.OSEKKAI_BLOB_MODULE_PATH || '@vercel/blob';
    blobClientCache = require(modulePath);
  } catch (err) {
    console.error('⚠️ @vercel/blob を読み込めませんでした。写真は従来方式（db.json）で保存します:', err.message);
    blobClientCache = null;
  }
  return blobClientCache;
}
function blobStorageEnabled() { return !!loadBlobClient(); }

function verifyPhotoPathname(id, ext) { return VERIFY_BLOB_PREFIX + id + '/photo.' + ext; }
function verifyMetaPathname(id) { return VERIFY_BLOB_PREFIX + id + '/meta.json'; }

// 写真の data URL（data:image/...;base64,....）をバイナリに変換する。
// 変換できない形式の場合は null。
function parsePhotoDataUrl(photo) {
  const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(typeof photo === 'string' ? photo : '');
  if (!m) return null;
  const mime = m[1].toLowerCase();
  const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : mime === 'image/gif' ? 'gif' : 'jpg';
  try {
    return { mime: mime, ext: ext, buffer: Buffer.from(m[2], 'base64') };
  } catch (err) {
    return null;
  }
}

// Blob の meta.json に保存する形（写真データそのものは含めない）。
function verifyMetaOf(record) {
  const meta = { ...record };
  delete meta.photoDataUrl;
  return meta;
}

async function putVerifyMetaToBlob(record) {
  const blob = loadBlobClient();
  if (!blob) throw new Error('blob storage is not available');
  await blob.put(verifyMetaPathname(record.id), JSON.stringify(verifyMetaOf(record)), {
    access: 'private',
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true,
    token: process.env.BLOB_READ_WRITE_TOKEN
  });
}

// Blob に非公開で保存した写真を、運営者向けにデータURLとして取り出す（第5弾）。
// 写真は access: 'private' で保存されるため、URL を知っていてもブラウザからは
// 開けません。運営者一覧API（パスコード必須）の応答の中でのみ、サーバーが
// トークンを使って取得し、データURLに変換して返します。
// 取得に失敗した場合は空文字を返し、一覧表示自体は止めません。
async function fetchVerifyPhotoAsDataUrl(record) {
  const blob = loadBlobClient();
  if (!blob || !record.photoBlobPathname) return '';
  try {
    const got = await blob.get(record.photoBlobPathname, { token: process.env.BLOB_READ_WRITE_TOKEN });
    if (!got || !got.stream) return '';
    const buf = Buffer.from(await new Response(got.stream).arrayBuffer());
    let mime = '';
    if (got.blob && got.blob.contentType) mime = got.blob.contentType;
    else if (got.headers && typeof got.headers.get === 'function') mime = got.headers.get('content-type') || '';
    if (!mime || mime.indexOf('image/') !== 0) {
      const ext = String(record.photoBlobPathname).split('.').pop().toLowerCase();
      mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'image/jpeg';
    }
    return 'data:' + mime + ';base64,' + buf.toString('base64');
  } catch (err) {
    console.error('⚠️ Blob からの写真取得に失敗しました:', record.id, err.message);
    return '';
  }
}

// Blob 上の meta.json 群を読み、db.verificationRequests に取り込む
// （Vercel のコールドスタートでメモリ/db.json が初期化されても、Blob に
// 残っている申請を復元するため）。プロセス内で基本1回だけ実行し、
// 失敗した場合は次回の呼び出しで再試行できるようにする。
let verifyHydrationPromise = null;
function hydrateVerifyRequestsFromBlob(db) {
  const blob = loadBlobClient();
  if (!blob) return Promise.resolve(false);
  if (!verifyHydrationPromise) {
    verifyHydrationPromise = (async () => {
      try {
        const metas = [];
        let cursor = undefined;
        do {
          const listed = await blob.list({
            prefix: VERIFY_BLOB_PREFIX,
            limit: 1000,
            cursor: cursor,
            token: process.env.BLOB_READ_WRITE_TOKEN
          });
          for (const b of (listed.blobs || [])) {
            if (b.pathname && b.pathname.endsWith('/meta.json')) metas.push(b.pathname);
          }
          cursor = listed.hasMore ? listed.cursor : undefined;
        } while (cursor);
        const byId = new Map();
        for (const r of (db.verificationRequests || [])) byId.set(r.id, r);
        for (const pathname of metas) {
          try {
            const got = await blob.get(pathname, { token: process.env.BLOB_READ_WRITE_TOKEN });
            if (!got || !got.stream) continue;
            const text = await new Response(got.stream).text();
            const meta = JSON.parse(text);
            if (meta && meta.id) {
              // Blob 側を正として、同IDのメモリ側レコードを置き換える
              byId.set(meta.id, { photoDataUrl: '', ...meta });
            }
          } catch (err) {
            console.error('⚠️ Blob の申請メタデータ読み込みに失敗（読み飛ばします）:', pathname, err.message);
          }
        }
        db.verificationRequests = [...byId.values()];
        return true;
      } catch (err) {
        console.error('⚠️ Blob からの申請データ復元に失敗しました:', err.message);
        verifyHydrationPromise = null; // 次回リクエストで再試行できるようにする
        return false;
      }
    })();
  }
  return verifyHydrationPromise;
}

let inMemoryDB = null;

// --- Seed (initial) data, used when db.json is missing or unreadable ---
// NOTE: 初期状態では本人確認は「未認証」が正直な既定値です。
// NOTE: 第2弾でデモデータを全て削除しました。統計は全て0、募集は0件が
// 初期状態です（以前はデモ用の数字 1280食/640000円/14箇所/340名 が入っていました）。
const SEED_DB = {
  tasks: [],
  npoStats: { totalMealsServed: 0, totalDonationYen: 0, supportedCafeterias: 0, registeredSupporters: 0 },
  chatStore: {},
  autoReplies: [
    "ご連絡ありがとうございます！お待ちしておりますね。",
    "ありがとうございます！助かります。どうぞ気をつけてお越しください。",
    "承知いたしました！お会いできるのを楽しみにしております。"
  ],
  userVerifications: { defaultUser: { requester: false, helper: false } },
  // 本人確認の写真申請（第3弾）。運営者が目視で確認し、承認/差し戻しをします。
  // 各要素: { id, userKey, displayName, docType, photoDataUrl,
  //           status: 'pending'|'approved'|'rejected', reason, createdAt, reviewedAt }
  // 第4弾: Blob 保存時は photoDataUrl は空になり、代わりに photoStorage: 'blob' /
  // photoUrl（非公開URL。サーバー内部用でAPIレスポンスには含めない。第5弾）/
  // photoBlobPathname / photoMetaBlobPathname が入ります。
  verificationRequests: []
};

// Fill in any missing fields so a partial db.json never crashes an endpoint.
function normalizeDB(data) {
  const db = (data && typeof data === 'object') ? data : {};
  if (!Array.isArray(db.tasks)) db.tasks = [...SEED_DB.tasks];
  if (!db.npoStats || typeof db.npoStats !== 'object') db.npoStats = { ...SEED_DB.npoStats };
  for (const key of Object.keys(SEED_DB.npoStats)) {
    if (typeof db.npoStats[key] !== 'number') db.npoStats[key] = SEED_DB.npoStats[key];
  }
  if (!db.chatStore || typeof db.chatStore !== 'object') db.chatStore = {};
  if (!Array.isArray(db.autoReplies) || db.autoReplies.length === 0) db.autoReplies = [...SEED_DB.autoReplies];
  if (!db.userVerifications || typeof db.userVerifications !== 'object') {
    db.userVerifications = { defaultUser: { ...SEED_DB.userVerifications.defaultUser } };
  }
  if (!db.userVerifications.defaultUser || typeof db.userVerifications.defaultUser !== 'object') {
    db.userVerifications.defaultUser = { ...SEED_DB.userVerifications.defaultUser };
  }
  if (!Array.isArray(db.verificationRequests)) db.verificationRequests = [];
  return db;
}

// --- Helper: Read / Write JSON Database ---
function loadDB() {
  if (inMemoryDB) return inMemoryDB;
  try {
    if (fs.existsSync(DB_FILE)) {
      // Strip a UTF-8 BOM if present (files saved by Windows editors / PowerShell
      // often carry one, and JSON.parse rejects it, silently discarding all data).
      const raw = fs.readFileSync(DB_FILE, 'utf-8').replace(/^\uFEFF/, '');
      inMemoryDB = normalizeDB(JSON.parse(raw));
      return inMemoryDB;
    }
  } catch (err) {
    console.error("⚠️ Error loading db.json (falling back to seed data):", err.message);
  }
  inMemoryDB = normalizeDB(JSON.parse(JSON.stringify(SEED_DB)));
  return inMemoryDB;
}

function saveDB(data) {
  inMemoryDB = data;
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    // 永続化の制約: Vercel のサーバーレス環境ではファイルシステムが読み取り専用で、
    // 書き込んでも次回の実行時には残りません。その場合データはこのプロセスの
    // メモリ内にのみ保持されます（プロセスが再起動するとシード/db.json に戻ります）。
    // 複数人でデータを共有・永続化するには外部データベースが必要です。
  }
}

// --- Helper: Get Local LAN IPv4 Addresses ---
function getLocalIpAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        addresses.push(iface.address);
      }
    }
  }
  return addresses;
}

// --- MIME Types ---
const MIME_TYPES = {
  '.html': 'text/html; charset=UTF-8',
  '.css': 'text/css; charset=UTF-8',
  '.js': 'application/javascript; charset=UTF-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.json': 'application/json; charset=UTF-8',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml'
};

// --- HTTP Server ---
const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Passcode');

  // Cache Control Headers (Prevent Mobile Browser Stale Cache)
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // === REST API ENDPOINTS ===

  // 1. GET /api/stats
  if (pathname === '/api/stats' && req.method === 'GET') {
    const db = loadDB();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
    res.end(JSON.stringify(db.npoStats || {}));
    return;
  }

  // 2. GET /api/tasks
  if (pathname === '/api/tasks' && req.method === 'GET') {
    const db = loadDB();
    const category = parsedUrl.searchParams.get('category');
    const ward = parsedUrl.searchParams.get('ward');

    let filtered = (db.tasks || []).filter(t => t.status === 'open');
    if (category && category !== 'all') {
      filtered = filtered.filter(t => t.category === category);
    }
    if (ward && ward !== 'all') {
      filtered = filtered.filter(t => (t.fuzzyLocation && t.fuzzyLocation.includes(ward)) || t.ward === ward);
    }

    res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
    res.end(JSON.stringify(filtered));
    return;
  }

  // 3. POST /api/tasks
  if (pathname === '/api/tasks' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (!data.title || !String(data.title).trim() || !data.description || !String(data.description).trim()) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=UTF-8' });
          res.end(JSON.stringify({ error: "title and description are required" }));
          return;
        }
        const db = loadDB();
        const newTask = {
          id: "task-" + Date.now(),
          category: data.category || "housework",
          categoryName: data.categoryName || "💡 住まいの手伝い",
          title: data.title,
          description: data.description,
          fuzzyLocation: `${data.area || '浜松市'}（約500m圏内）`,
          exactLocation: `${data.area || '浜松市'} 登録住所`,
          requesterName: "あなた (浜松市民・本人確認済み)",
          requesterVerified: true,
          timeAgo: "たった今",
          status: "open",
          donationAmount: 500
        };
        db.tasks = db.tasks || [];
        db.tasks.unshift(newTask);
        saveDB(db);

        res.writeHead(201, { 'Content-Type': 'application/json; charset=UTF-8' });
        res.end(JSON.stringify({ success: true, task: newTask }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=UTF-8' });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
      }
    });
    return;
  }

  // 4. POST /api/tasks/:id/complete
  if (pathname.startsWith('/api/tasks/') && pathname.endsWith('/complete') && req.method === 'POST') {
    const parts = pathname.split('/');
    const taskId = parts[3];
    const db = loadDB();

    // Only count the donation when the task actually existed, so repeated or
    // unknown completions never inflate the counters (idempotent).
    const existed = (db.tasks || []).some(t => t.id === taskId);
    if (existed) {
      db.tasks = db.tasks.filter(t => t.id !== taskId);
      db.npoStats.totalMealsServed += 1;
      db.npoStats.totalDonationYen += 500;
      saveDB(db);
    }

    res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
    res.end(JSON.stringify({ success: true, completed: existed, npoStats: db.npoStats }));
    return;
  }

  // 5. GET /api/chat/:id
  if (pathname.startsWith('/api/chat/') && req.method === 'GET') {
    const taskId = pathname.split('/')[3];
    const db = loadDB();
    const history = (db.chatStore && db.chatStore[taskId]) ? db.chatStore[taskId] : [];
    res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
    res.end(JSON.stringify(history));
    return;
  }

  // 6. POST /api/chat/:id
  if (pathname.startsWith('/api/chat/') && req.method === 'POST') {
    const taskId = pathname.split('/')[3];
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const db = loadDB();
        db.chatStore = db.chatStore || {};
        if (!db.chatStore[taskId]) db.chatStore[taskId] = [];

        const now = new Date();
        const timeStr = `${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}`;

        const userMsg = { sender: data.sender || "me", text: data.text, time: timeStr };
        db.chatStore[taskId].push(userMsg);

        // Auto reply if sender is 'me' and autoReply flag is set.
        // 制約: この自動返信は応答後に setTimeout で保存されます。Vercel のような
        // サーバーレス環境ではレスポンス後にプロセスが凍結・終了するため、
        // 自動返信が保存されない場合があります（ローカル実行では動作します）。
        if (data.sender !== 'them' && data.autoReply !== false) {
          setTimeout(() => {
            const dbAsync = loadDB();
            dbAsync.chatStore = dbAsync.chatStore || {};
            if (!dbAsync.chatStore[taskId]) dbAsync.chatStore[taskId] = [];
            const replies = (dbAsync.autoReplies && dbAsync.autoReplies.length > 0) ? dbAsync.autoReplies : [
              "ご連絡ありがとうございます！お待ちしておりますね。",
              "ありがとうございます！助かります。どうぞ気をつけてお越しください。",
              "承知いたしました！お会いできるのを楽しみにしております。"
            ];
            const randomReply = replies[Math.floor(Math.random() * replies.length)];
            dbAsync.chatStore[taskId].push({
              sender: "them",
              text: randomReply,
              time: timeStr
            });
            saveDB(dbAsync);
          }, 800);
        }

        saveDB(db);

        res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
        res.end(JSON.stringify({ success: true, message: userMsg }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=UTF-8' });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
      }
    });
    return;
  }

  // 7. GET /api/user/verify
  if (pathname === '/api/user/verify' && req.method === 'GET') {
    const db = loadDB();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
    res.end(JSON.stringify(db.userVerifications));
    return;
  }

  // 8. POST /api/user/verify
  if (pathname === '/api/user/verify' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const db = loadDB();
        db.userVerifications = db.userVerifications || {};
        db.userVerifications.defaultUser = {
          requester: data.requester !== undefined ? data.requester : true,
          helper: data.helper !== undefined ? data.helper : true,
          verifiedAt: new Date().toISOString()
        };
        saveDB(db);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
        res.end(JSON.stringify({ success: true, verification: db.userVerifications.defaultUser }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=UTF-8' });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
      }
    });
    return;
  }

  // === 本人確認の写真申請・目視確認（第3弾） ===
  // 写真データ（photoDataUrl）は運営者用の一覧APIでのみ返します。
  // 利用者向けAPIでは絶対に含めません（自分の写真でも同じです）。
  function publicVerifyRequest(r) {
    if (!r) return null;
    return {
      id: r.id,
      userKey: r.userKey,
      displayName: r.displayName,
      docType: r.docType,
      status: r.status,
      reason: r.reason || '',
      createdAt: r.createdAt,
      reviewedAt: r.reviewedAt || null
    };
  }

  function hasAdminPasscode(req) {
    const provided = req.headers['x-admin-passcode'];
    return typeof provided === 'string' && provided.length > 0 && provided === ADMIN_PASSCODE;
  }

  function findLatestVerifyRequest(db, userKey) {
    const list = (db.verificationRequests || []).filter(r => r.userKey === userKey);
    if (list.length === 0) return null;
    // createdAt が最新のものを「現在の申請」とする
    return list.reduce((latest, r) => (!latest || String(r.createdAt) > String(latest.createdAt)) ? r : latest, null);
  }

  // 9. POST /api/verify-requests （利用者: 写真を申請する）
  if (pathname === '/api/verify-requests' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', async () => {
      let data;
      try {
        data = JSON.parse(body);
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=UTF-8' });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
        return;
      }
      try {
        const userKey = String(data.userKey || '').trim().slice(0, 128);
        const photo = typeof data.photoDataUrl === 'string' ? data.photoDataUrl : '';
        if (!userKey) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=UTF-8' });
          res.end(JSON.stringify({ error: "userKey is required" }));
          return;
        }
        // 写真は必須。データURL形式の画像で、容量上限（約3MB相当）以内のみ受付
        if (!photo || !photo.startsWith('data:image/') || photo.length > 3000000) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=UTF-8' });
          res.end(JSON.stringify({ error: "photoDataUrl (data:image/...) is required and must be <= 3MB" }));
          return;
        }
        const db = loadDB();
        db.verificationRequests = db.verificationRequests || [];
        const request = {
          id: "vreq-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8),
          userKey: userKey,
          displayName: String(data.displayName || '').trim().slice(0, 100),
          docType: (data.docType === 'license') ? 'license' : 'mynumber',
          photoDataUrl: photo,
          status: 'pending',
          reason: '',
          createdAt: new Date().toISOString(),
          reviewedAt: null
        };

        // 第4弾: Blob が使える環境では、写真バイナリと申請メタデータを
        // Blob に保存し、db 側のレコードには写真データを持たせない。
        // Blob への保存に失敗した場合は申請自体を受け付けない（500）。
        // 中途半端に「写真だけ残って申請が無い」状態を作らないためです。
        const blob = loadBlobClient();
        if (blob) {
          const parsed = parsePhotoDataUrl(photo);
          if (!parsed) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=UTF-8' });
            res.end(JSON.stringify({ error: "photoDataUrl must be a base64 data URL when blob storage is enabled" }));
            return;
          }
          const photoPathname = verifyPhotoPathname(request.id, parsed.ext);
          try {
            const putResult = await blob.put(photoPathname, parsed.buffer, {
              access: 'private',
              contentType: parsed.mime,
              addRandomSuffix: false,
              allowOverwrite: true,
              token: process.env.BLOB_READ_WRITE_TOKEN
            });
            request.photoDataUrl = '';
            request.photoStorage = 'blob';
            request.photoUrl = putResult.url;
            request.photoBlobPathname = photoPathname;
            request.photoMetaBlobPathname = verifyMetaPathname(request.id);
            await putVerifyMetaToBlob(request);
          } catch (err) {
            console.error('⚠️ Blob への写真申請の保存に失敗しました:', err.message);
            // 写真だけが Blob に残らないよう、削除を試みる（失敗しても無視）
            try { await blob.del(photoPathname, { token: process.env.BLOB_READ_WRITE_TOKEN }); } catch (e) {}
            res.writeHead(500, { 'Content-Type': 'application/json; charset=UTF-8' });
            res.end(JSON.stringify({ error: "failed to store verification request" }));
            return;
          }
        }

        db.verificationRequests.push(request);
        saveDB(db);
        res.writeHead(201, { 'Content-Type': 'application/json; charset=UTF-8' });
        res.end(JSON.stringify({ success: true, request: publicVerifyRequest(request) }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=UTF-8' });
        res.end(JSON.stringify({ error: "Internal Server Error" }));
      }
    });
    return;
  }

  // 10. GET /api/verify-requests/mine?userKey=... （利用者: 自分の申請状態）
  if (pathname === '/api/verify-requests/mine' && req.method === 'GET') {
    const db = loadDB();
    await hydrateVerifyRequestsFromBlob(db);
    const userKey = String(parsedUrl.searchParams.get('userKey') || '').trim().slice(0, 128);
    const latest = userKey ? findLatestVerifyRequest(db, userKey) : null;
    res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
    res.end(JSON.stringify({ request: publicVerifyRequest(latest) }));
    return;
  }

  // 11. GET /api/admin/verify-requests （運営者: 申請一覧。パスコード必須・写真含む）
  if (pathname === '/api/admin/verify-requests' && req.method === 'GET') {
    if (!hasAdminPasscode(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ error: "admin passcode required" }));
      return;
    }
    const db = loadDB();
    await hydrateVerifyRequestsFromBlob(db);
    const statusFilter = parsedUrl.searchParams.get('status');
    let list = [...(db.verificationRequests || [])];
    if (statusFilter) list = list.filter(r => r.status === statusFilter);
    list.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    // 第5弾: 写真は非公開保存のため、Blob の URL は運営画面にも渡しません。
    // Blob 保存の申請は、サーバーがここで写真を取得してデータURLとして埋め
    // 込みます（このAPI自体がパスコード必須なので、写真を見られるのは
    // パスコードを知っている運営者だけです）。
    const view = [];
    for (const r of list) {
      const item = { ...r };
      delete item.photoUrl;
      if (item.photoStorage === 'blob' && !item.photoDataUrl) {
        item.photoDataUrl = await fetchVerifyPhotoAsDataUrl(item);
      }
      view.push(item);
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
    res.end(JSON.stringify(view));
    return;
  }

  // 12. POST /api/admin/verify-requests/:id/review （運営者: 承認・差し戻し。パスコード必須）
  if (pathname.startsWith('/api/admin/verify-requests/') && pathname.endsWith('/review') && req.method === 'POST') {
    if (!hasAdminPasscode(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ error: "admin passcode required" }));
      return;
    }
    const requestId = pathname.split('/')[4];
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', async () => {
      let data;
      try {
        data = JSON.parse(body);
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=UTF-8' });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
        return;
      }
      try {
        const action = data.action;
        const reason = String(data.reason || '').trim().slice(0, 500);
        if (action !== 'approve' && action !== 'reject') {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=UTF-8' });
          res.end(JSON.stringify({ error: "action must be 'approve' or 'reject'" }));
          return;
        }
        if (action === 'reject' && !reason) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=UTF-8' });
          res.end(JSON.stringify({ error: "reason is required when rejecting" }));
          return;
        }
        const db = loadDB();
        await hydrateVerifyRequestsFromBlob(db);
        const target = (db.verificationRequests || []).find(r => r.id === requestId);
        if (!target) {
          res.writeHead(404, { 'Content-Type': 'application/json; charset=UTF-8' });
          res.end(JSON.stringify({ error: "request not found" }));
          return;
        }
        const updated = {
          ...target,
          status: (action === 'approve') ? 'approved' : 'rejected',
          reason: (action === 'reject') ? reason : '',
          reviewedAt: new Date().toISOString()
        };

        // 第4弾: Blob 保存の申請は、先に Blob 側のメタデータを更新してから
        // メモリ側に反映する（Blob への保存に失敗したら 500 で、状態は変えない）。
        if (loadBlobClient() && updated.photoStorage === 'blob') {
          try {
            await putVerifyMetaToBlob(updated);
          } catch (err) {
            console.error('⚠️ Blob への確認結果の保存に失敗しました:', err.message);
            res.writeHead(500, { 'Content-Type': 'application/json; charset=UTF-8' });
            res.end(JSON.stringify({ error: "failed to store review result" }));
            return;
          }
        }
        Object.assign(target, updated);

        // 既存の userVerifications（バッジ表示用）にも結果を反映する。
        // 承認: 認証済みにする / 差し戻し: この申請がその利用者の最新なら未認証に戻す
        db.userVerifications = db.userVerifications || {};
        if (action === 'approve') {
          db.userVerifications.defaultUser = { requester: true, helper: true, verifiedAt: target.reviewedAt };
        } else {
          const latest = findLatestVerifyRequest(db, target.userKey);
          if (latest && latest.id === target.id) {
            db.userVerifications.defaultUser = { requester: false, helper: false, verifiedAt: undefined };
          }
        }
        saveDB(db);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
        res.end(JSON.stringify({ success: true, request: publicVerifyRequest(target) }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=UTF-8' });
        res.end(JSON.stringify({ error: "Internal Server Error" }));
      }
    });
    return;
  }

  // === STATIC FILE SERVING ===
  // Server-internal files must never be served to browsers
  // (db.json contains all stored data; local_server.js is the server source).
  const BLOCKED_STATIC_FILES = new Set([
    'db.json', 'local_server.js', 'vercel.json', '.vercelignore',
    'start_server.bat', 'start_server.ps1', 'package.json', 'package-lock.json'
  ]);
  let safePath = pathname === '/' ? 'index.html' : pathname;
  if (BLOCKED_STATIC_FILES.has(path.basename(safePath))) {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=UTF-8' });
    res.end('<h1>404 Not Found</h1>');
    return;
  }
  // 依存パッケージとテスト一式も配信対象外にする（第4弾で追加）
  const firstSegment = safePath.replace(/^\/+/, '').split('/')[0];
  if (firstSegment === 'node_modules' || firstSegment === 'tests') {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=UTF-8' });
    res.end('<h1>404 Not Found</h1>');
    return;
  }
  let filePath = path.join(__dirname, path.normalize(safePath).replace(/^(\.\.[\/\\])+/, ''));
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'text/plain; charset=UTF-8';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/html; charset=UTF-8' });
        res.end('<h1>404 Not Found</h1>');
      } else {
        res.writeHead(500);
        res.end(`Server Error: ${err.code}`);
      }
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    }
  });
});

// Bind to 0.0.0.0 for LAN smartphone access
if (!process.env.VERCEL) {
  server.listen(PORT, '0.0.0.0', () => {
    const ips = getLocalIpAddresses();
    console.log("\n============================================================");
    console.log("🌸 おせっ会 浜松 (Osekkai Hamamatsu) バックエンド＆Webサーバー起動！");
    console.log("============================================================");
    console.log(`💻 PCブラウザ用アクセス:   http://localhost:${PORT}/`);
    if (ips.length > 0) {
      ips.forEach(ip => {
        console.log(`📲 スマホ用アクセス (Wi-Fi): http://${ip}:${PORT}/`);
      });
    }
    console.log("============================================================\n");
  });
}

module.exports = server;
