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
  userVerifications: { defaultUser: { requester: false, helper: false } }
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
const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

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
