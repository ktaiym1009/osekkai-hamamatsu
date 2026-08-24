/* ==========================================================================
   お節会 浜松 (Osekkai Hamamatsu) - Persistent Backend API & Web Server
   Node.js Standard Library HTTP + File Storage (db.json) + LAN Access
   ========================================================================== */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'db.json');

// --- Helper: Read / Write JSON Database ---
function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const raw = fs.readFileSync(DB_FILE, 'utf-8');
      return JSON.parse(raw);
    }
  } catch (err) {
    console.error("⚠️ Error loading db.json:", err.message);
  }
  return {
    tasks: [],
    npoStats: { totalMealsServed: 1248, totalDonationYen: 624000, supportedCafeterias: 14, registeredSupporters: 340 },
    chatStore: {},
    userVerifications: { defaultUser: { requester: true, helper: true } }
  };
}

function saveDB(data) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error("⚠️ Error saving db.json:", err.message);
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
      filtered = filtered.filter(t => t.fuzzyLocation.includes(ward) || t.ward === ward);
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

    db.tasks = (db.tasks || []).filter(t => t.id !== taskId);
    if (!db.npoStats) {
      db.npoStats = { totalMealsServed: 1248, totalDonationYen: 624000, supportedCafeterias: 14, registeredSupporters: 340 };
    }
    db.npoStats.totalMealsServed += 1;
    db.npoStats.totalDonationYen += 500;
    saveDB(db);

    res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
    res.end(JSON.stringify({ success: true, npoStats: db.npoStats }));
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

        // Auto mock response if sender is 'me' and autoReply flag is set
        if (data.sender !== 'them' && data.autoReply !== false) {
          setTimeout(() => {
            const dbAsync = loadDB();
            dbAsync.chatStore = dbAsync.chatStore || {};
            if (!dbAsync.chatStore[taskId]) dbAsync.chatStore[taskId] = [];
            const replies = [
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
    res.end(JSON.stringify(db.userVerifications || { defaultUser: { requester: true, helper: true } }));
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
  let safePath = pathname === '/' ? 'index.html' : pathname;
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
server.listen(PORT, '0.0.0.0', () => {
  const ips = getLocalIpAddresses();
  console.log("\n============================================================");
  console.log("🌸 お節会 浜松 (Osekkai Hamamatsu) バックエンド＆Webサーバー起動！");
  console.log("============================================================");
  console.log(`💻 PCブラウザ用アクセス:   http://localhost:${PORT}/`);
  if (ips.length > 0) {
    ips.forEach(ip => {
      console.log(`📲 スマホ用アクセス (Wi-Fi): http://${ip}:${PORT}/`);
    });
  }
  console.log("============================================================\n");
});
