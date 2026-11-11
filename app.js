/* ==========================================================================
   おせっ会 浜松 (子ども食堂応援・地域助け合いアプリ)
   Core Application Logic & REST API Data Sync Manager
   ========================================================================== */

// App State
let tasksState = [];
let currentCategory = "all";
let currentWard = "all";
let npoStatsState = {
  totalMealsServed: 0,
  totalDonationYen: 0,
  supportedCafeterias: 0,
  registeredSupporters: 0
};
let isSeniorMode = false;
let userVerification = {
  requester: false,
  helper: false,
  docType: "mynumber",
  // 第3弾: サーバー側の写真申請の状態（"" = 申請なし / pending / approved / rejected）
  verifyStatus: "",
  verifyReason: ""
};

// Active Chat Task State & Polling Timer
let currentChatTaskId = null;
let chatPollingTimer = null;
let chatHistories = {};

// DOM Elements
const tasksGrid = document.getElementById("tasksGrid");
const categoryButtons = document.querySelectorAll(".cat-btn");
const mealCounterEl = document.getElementById("mealCounter");
const progressBarFill = document.getElementById("progressBarFill");
const targetPercentLabel = document.getElementById("targetPercentLabel");
const toggleSeniorModeBtn = document.getElementById("toggleSeniorMode");
const seniorModeLabel = document.getElementById("seniorModeLabel");
const familyNotificationLog = document.getElementById("familyNotificationLog");
const toastContainer = document.getElementById("toastContainer");

// Modals
const createTaskModal = document.getElementById("createTaskModal");
const verifyModal = document.getElementById("verifyModal");
const taskDetailModal = document.getElementById("taskDetailModal");
const npoModal = document.getElementById("npoModal");
const chatModal = document.getElementById("chatModal");

// Buttons & Forms
const openCreateTaskBtn = document.getElementById("openCreateTaskBtn");
const openVerifyModalBtn = document.getElementById("openVerifyModalBtn");
const openNpoModalBtn = document.getElementById("openNpoModalBtn");
const createTaskForm = document.getElementById("createTaskForm");

// Chat DOM Elements
const chatMessagesContainer = document.getElementById("chatMessagesContainer");
const chatInputForm = document.getElementById("chatInputForm");
const chatInputText = document.getElementById("chatInputText");
const chatAvatar = document.getElementById("chatAvatar");
const chatUserName = document.getElementById("chatUserName");
const chatContextTitle = document.getElementById("chatContextTitle");

// Camera Modal Elements & State (本人確認の撮影用)
const cameraModal = document.getElementById("cameraModal");
const cameraVideo = document.getElementById("cameraVideo");
const cameraCanvas = document.getElementById("cameraCanvas");
const btnTakeSnap = document.getElementById("btnTakeSnap");
const btnCloseCameraModal = document.getElementById("btnCloseCameraModal");
const btnFallbackGallery = document.getElementById("btnFallbackGallery");
let activeCaptureTarget = "front"; // "front" | "back"
let cameraStream = null;

// LINE Integration State
let lineUserProfile = {
  displayName: "",
  pictureUrl: "",
  userId: "",
  isLoggedIn: false
};

// ==========================================================================
// API Interaction Helpers (REST API Sync with server.js / db.json)
// ==========================================================================

function updateStatsUI() {
  const meals = Number(npoStatsState.totalMealsServed || 0);
  if (mealCounterEl) {
    mealCounterEl.textContent = meals.toLocaleString();
  }
  if (progressBarFill) {
    const targetGoal = 1500;
    const percent = Math.min(100, Math.round((meals / targetGoal) * 100));
    progressBarFill.style.width = percent + "%";
    if (targetPercentLabel) targetPercentLabel.textContent = percent + "%";
  }
  const npoMetricMeals = document.getElementById("npoMetricMeals");
  if (npoMetricMeals) {
    npoMetricMeals.textContent = `${meals.toLocaleString()}食`;
  }
  const npoMetricYen = document.getElementById("npoMetricYen");
  if (npoMetricYen) {
    npoMetricYen.textContent = `${Number(npoStatsState.totalDonationYen || 0).toLocaleString()}円`;
  }
  const npoMetricCafeterias = document.getElementById("npoMetricCafeterias");
  if (npoMetricCafeterias) {
    npoMetricCafeterias.textContent = `${Number(npoStatsState.supportedCafeterias || 0).toLocaleString()}箇所`;
  }
  const npoMetricSupporters = document.getElementById("npoMetricSupporters");
  if (npoMetricSupporters) {
    npoMetricSupporters.textContent = `${Number(npoStatsState.registeredSupporters || 0).toLocaleString()}名`;
  }
}

// --- ローカル保存キー（第2弾で接頭辞を v2 に変更） ---
// 旧キー（接頭辞なし）にはプレビュー期間中のデモ由来データ（サンプル統計・
// サンプル募集・デモチャット等）が残っている端末があるため、新しいキーに
// 切り替えて旧データを読み込まないようにしました。旧キーの中身は削除せず
// 残置しますが、今後は一切参照されません（新しい保存先は v2 キーのみ）。
const STORAGE_KEYS = {
  tasks: "osekkai_v2_tasks_store",
  stats: "osekkai_v2_stats_store",
  chats: "osekkai_v2_chat_store",
  verification: "osekkai_v2_user_verification",
  completedIds: "osekkai_v2_completed_task_ids",
  // 第3弾: LINE未連携時に写真申請を識別するための端末内利用者ID
  userKey: "osekkai_v2_user_key",
  // 第6弾: ワンコイン受け取り記録（サーバーに送れない環境向けの端末内保存）
  coinPayments: "osekkai_v2_coin_payments"
};

// --- 本人確認状態のローカル保存（APIが使えない環境でも自分の認証状態を保持する） ---
function getStoredVerification() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.verification);
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  return null;
}

function saveStoredVerification(v) {
  try {
    localStorage.setItem(STORAGE_KEYS.verification, JSON.stringify(v));
  } catch (e) {}
}

// --- 写真申請の利用者識別キー（第3弾） ---
// LINE連携済みなら LINE の userId を、未連携なら端末内で一度だけ生成して
// 保存した利用者IDを使います。サーバー側の申請レコードと紐づけるための値で、
// これが一致する申請がある場合、その状態（確認待ち/認証済み/差し戻し）を
// この端末の表示に優先して反映します。
function getMyUserKey() {
  if (lineUserProfile && lineUserProfile.isLoggedIn && lineUserProfile.userId) {
    return "line:" + lineUserProfile.userId;
  }
  try {
    let key = localStorage.getItem(STORAGE_KEYS.userKey);
    if (!key) {
      key = "device:" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
      localStorage.setItem(STORAGE_KEYS.userKey, key);
    }
    return key;
  } catch (e) {
    return "device:ephemeral";
  }
}

function getMyDisplayName() {
  if (lineUserProfile && lineUserProfile.isLoggedIn && lineUserProfile.displayName) {
    return lineUserProfile.displayName;
  }
  return "";
}

// 写真を送信前に縮小する（最大幅800px目安・JPEG化）。写真そのものが写って
// いるか運営者が目視で判断できれば十分なため、容量を抑えて送信します。
function shrinkImageToJpeg(dataUrl, maxWidth = 800) {
  return new Promise((resolve) => {
    try {
      const img = new Image();
      img.onload = function() {
        try {
          const scale = Math.min(1, maxWidth / (img.width || maxWidth));
          const w = Math.max(1, Math.round((img.width || maxWidth) * scale));
          const h = Math.max(1, Math.round((img.height || maxWidth) * scale));
          const canvas = document.createElement("canvas");
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL("image/jpeg", 0.82));
        } catch (e) {
          resolve(dataUrl);
        }
      };
      img.onerror = function() { resolve(dataUrl); };
      img.src = dataUrl;
    } catch (e) {
      resolve(dataUrl);
    }
  });
}

// サーバーに自分の写真申請レコードがあれば、その状態を userVerification に
// 優先反映する（第3弾）。申請が無い・APIが使えない場合は何もしない
// （従来どおり自分のブラウザ保存状態を使う）。
async function syncMyVerificationStatus() {
  try {
    const userKey = getMyUserKey();
    const res = await apiFetch("/api/verify-requests/mine?userKey=" + encodeURIComponent(userKey));
    if (!res) return;
    const data = await res.json();
    const req = data && data.request;
    if (!req) return;

    userVerification.verifyStatus = req.status || "";
    userVerification.verifyReason = req.reason || "";
    if (req.docType) userVerification.docType = req.docType;
    if (req.status === "approved") {
      userVerification.requester = true;
      userVerification.helper = true;
    } else {
      // 確認待ち・差し戻しの間は「認証済み」とは表示しない（正直な表示にする）
      userVerification.requester = false;
      userVerification.helper = false;
    }
    saveStoredVerification(userVerification);
    updateVerificationBadgesUI();
  } catch (err) {
    console.warn("⚠️ verify-requests/mine sync error:", err);
  }
}

window.getMyUserKey = getMyUserKey;
window.syncMyVerificationStatus = syncMyVerificationStatus;

// ==========================================================================
// ワンコイン寄付（第6弾）: 受け取り記録と寄付累計カウンター
// - 手伝った人が「500円を受け取りました」を記録すると、サーバーの台帳に
//   「預かり中（held）」として残ります。運営が受け取りを確認すると
//   「運営へ渡し済み（handed_over）」に変わります。
// - サーバーに送れない環境では端末内（localStorage）にだけ記録し、
//   画面が止まらないようにします（記録自体は端末に残ります）。
// ==========================================================================
let myCoinPayments = [];

function getStoredCoinPayments() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.coinPayments);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (e) {}
  return [];
}

function saveStoredCoinPayments(list) {
  try {
    localStorage.setItem(STORAGE_KEYS.coinPayments, JSON.stringify(list));
  } catch (e) {}
}

function formatCoinDate(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString("ja-JP", { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch (e) { return iso; }
}

function renderCoinPayments() {
  const listEl = document.getElementById("coinPaymentsList");
  const summaryEl = document.getElementById("coinPaymentsSummary");
  if (!listEl) return;

  const held = myCoinPayments.filter(p => p.status !== "handed_over");
  const heldTotal = held.reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
  if (summaryEl) {
    summaryEl.textContent = myCoinPayments.length === 0
      ? ""
      : `預かり中: ${held.length}件・${heldTotal.toLocaleString()}円 ／ 記録合計: ${myCoinPayments.length}件`;
  }

  if (myCoinPayments.length === 0) {
    listEl.innerHTML = '<div class="coin-empty">まだ記録がありません。</div>';
    return;
  }

  listEl.innerHTML = "";
  myCoinPayments.forEach(p => {
    const item = document.createElement("div");
    item.className = "coin-record-item";
    const handed = p.status === "handed_over";
    const badge = handed
      ? '<span class="coin-badge coin-badge-handed">運営へ渡し済み</span>'
      : '<span class="coin-badge coin-badge-held">預かり中</span>';
    const methodLabel = p.handoverMethod === "cash" ? "現金" : (p.handoverMethod === "transfer" ? "振込" : "");
    const handedLine = handed
      ? `<div class="coin-sub">運営への受け渡し: ${formatCoinDate(p.handedOverAt)}${methodLabel ? "（" + methodLabel + "）" : ""}</div>`
      : "";
    const memoLine = p.memo ? `<div>${escapeHTML(p.memo)}</div>` : "";
    item.innerHTML = `
      <span class="coin-amount">${(Number(p.amount) || 0).toLocaleString()}円</span>${badge}
      ${memoLine}
      <div class="coin-sub">受け取り: ${formatCoinDate(p.createdAt)}</div>
      ${handedLine}`;
    listEl.appendChild(item);
  });
}

// サーバーに自分の記録があれば、その状態（運営の確認結果を含む）を優先する
async function syncMyCoinPayments() {
  try {
    const userKey = getMyUserKey();
    const res = await apiFetch("/api/coin-payments/mine?userKey=" + encodeURIComponent(userKey));
    if (!res) return;
    const data = await res.json();
    if (data && Array.isArray(data.payments)) {
      myCoinPayments = data.payments;
      saveStoredCoinPayments(myCoinPayments);
      renderCoinPayments();
    }
  } catch (err) {
    console.warn("⚠️ coin-payments/mine sync error:", err);
  }
}

async function recordCoinPayment() {
  const memoInput = document.getElementById("coinMemoInput");
  const memo = memoInput ? memoInput.value.trim() : "";
  const btn = document.getElementById("btnRecordCoin");
  if (btn) btn.disabled = true;

  let saved = null;
  try {
    const res = await apiFetch("/api/coin-payments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userKey: getMyUserKey(),
        displayName: getMyDisplayName(),
        amount: 500,
        memo: memo
      })
    });
    if (res) {
      const data = await res.json();
      if (data && data.payment) saved = data.payment;
    }
  } catch (err) {
    console.warn("⚠️ coin-payments submit error:", err);
  }

  if (!saved) {
    // サーバーに送れない環境: 端末内にだけ記録する（画面は止めない）
    saved = {
      id: "local-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8),
      userKey: getMyUserKey(),
      displayName: getMyDisplayName(),
      amount: 500,
      memo: memo,
      taskId: null,
      status: "held",
      createdAt: new Date().toISOString(),
      handedOverAt: null,
      handoverMethod: null
    };
  }

  myCoinPayments.unshift(saved);
  saveStoredCoinPayments(myCoinPayments);
  renderCoinPayments();
  if (memoInput) memoInput.value = "";
  if (btn) btn.disabled = false;
  showToast("🪙 500円の受け取りを記録しました。預かったお金は運営へお渡しください。");
}

// トップの寄付カウンター（公開サマリー）。取得できない場合はカードを出さない
async function fetchDonationSummary() {
  const card = document.getElementById("donationCounterCard");
  if (!card) return;
  try {
    const res = await apiFetch("/api/donations/summary");
    if (!res) return;
    const data = await res.json();
    if (!data || typeof data.totalDonated !== "number") return;
    const yenEl = document.getElementById("donationTotalYen");
    const countEl = document.getElementById("donationTotalCount");
    if (yenEl) yenEl.textContent = data.totalDonated.toLocaleString();
    if (countEl) countEl.textContent = (data.donationCount || 0).toLocaleString();
    card.style.display = "flex";
  } catch (err) {
    console.warn("⚠️ donations/summary fetch error:", err);
  }
}

function initCoinFeatures() {
  myCoinPayments = getStoredCoinPayments();
  renderCoinPayments();
  const btn = document.getElementById("btnRecordCoin");
  if (btn) btn.addEventListener("click", recordCoinPayment);
  syncMyCoinPayments();
  fetchDonationSummary();
}

window.syncMyCoinPayments = syncMyCoinPayments;
window.fetchDonationSummary = fetchDonationSummary;

async function fetchUserVerification() {
  // 自分の認証状態は、まず自分のブラウザに保存されたものを正とする
  const local = getStoredVerification();
  if (local) {
    userVerification = local;
    updateVerificationBadgesUI();
    // ただしサーバーに自分の写真申請があれば、その状態を優先する（第3弾）
    syncMyVerificationStatus();
    return;
  }

  try {
    const res = await apiFetch("/api/user/verify");
    if (res) {
      const data = await res.json();
      if (data && data.defaultUser) {
        userVerification = data.defaultUser;
        saveStoredVerification(userVerification);
        updateVerificationBadgesUI();
      }
    }
  } catch (err) {
    console.warn("⚠️ API fetchUserVerification error:", err);
  }
  syncMyVerificationStatus();
}

function updateVerificationBadgesUI() {
  const reqBadge = document.getElementById("requesterStatusBadge");
  const helpBadge = document.getElementById("helperStatusBadge");
  const docType = userVerification.docType || "mynumber";
  const docName = docType === "license" ? "運転免許証" : "マイナンバーカード";
  const badgeIcon = docType === "license" ? "🚗" : "🪪";

  // 第3弾: サーバーへ写真申請済みの場合は、その審査状態を優先表示する
  if (userVerification.verifyStatus === "pending") {
    const html = `<i class="fa-solid fa-hourglass-half"></i> ${badgeIcon} ${docName} 確認待ち（運営者が確認中です）`;
    if (reqBadge) { reqBadge.className = "status-unverified"; reqBadge.innerHTML = html; }
    if (helpBadge) { helpBadge.className = "status-unverified"; helpBadge.innerHTML = html; }
    return;
  }
  if (userVerification.verifyStatus === "rejected") {
    const reasonText = userVerification.verifyReason ? `（理由: ${escapeHTML(userVerification.verifyReason)}）` : "";
    const html = `<i class="fa-solid fa-circle-exclamation"></i> 再提出のお願い${reasonText}`;
    if (reqBadge) { reqBadge.className = "status-unverified"; reqBadge.innerHTML = html; }
    if (helpBadge) { helpBadge.className = "status-unverified"; helpBadge.innerHTML = html; }
    return;
  }

  if (userVerification.requester) {
    if (reqBadge) {
      reqBadge.className = "status-verified";
      reqBadge.innerHTML = `<i class="fa-solid fa-shield-check"></i> ${badgeIcon} ${docName}認証済み`;
    }
  } else {
    if (reqBadge) {
      reqBadge.className = "status-unverified";
      reqBadge.innerHTML = `<i class="fa-solid fa-circle-xmark"></i> 未認証`;
    }
  }

  if (userVerification.helper) {
    if (helpBadge) {
      helpBadge.className = "status-verified";
      helpBadge.innerHTML = `<i class="fa-solid fa-shield-check"></i> ${badgeIcon} ${docName}認証済み`;
    }
  } else {
    if (helpBadge) {
      helpBadge.className = "status-unverified";
      helpBadge.innerHTML = `<i class="fa-solid fa-circle-xmark"></i> 未認証`;
    }
  }
}

const BACKEND_CLOUD_API = "https://osekkai-hamamatsu.vercel.app";

async function apiFetch(endpoint, options = {}) {
  // 1. Try local / relative endpoint first
  try {
    const res = await fetch(endpoint, options);
    if (res && res.ok) return res;
  } catch (err) {}

  // 2. Fallback to Cloud Backend API (enables instant real-time sync on GitHub Pages!)
  try {
    const cloudUrl = BACKEND_CLOUD_API + endpoint;
    const res = await fetch(cloudUrl, options);
    if (res && res.ok) return res;
  } catch (err) {}

  return null;
}

// 初期表示用の募集データは置きません（第2弾でデモデータを全て削除）。
// 起動直後は0件が正しい状態で、「まだ投稿がありません」の空表示が出ます。
const INITIAL_SAMPLE_TASKS = [];

function getStoredTasks() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.tasks);
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  return null;
}

function saveStoredTasks(tasks) {
  try {
    localStorage.setItem(STORAGE_KEYS.tasks, JSON.stringify(tasks));
  } catch (e) {}
}

function getStoredStats() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.stats);
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  return null;
}

function saveStoredStats(stats) {
  try {
    localStorage.setItem(STORAGE_KEYS.stats, JSON.stringify(stats));
  } catch (e) {}
}

async function fetchStats() {
  try {
    const res = await apiFetch("/api/stats");
    if (res) {
      const data = await res.json();
      if (data && data.totalMealsServed !== undefined) {
        npoStatsState = data;
        saveStoredStats(npoStatsState);
        updateStatsUI();
        return;
      }
    }
  } catch (err) {
    console.warn("⚠️ API fetchStats fallback:", err);
  }

  const localStats = getStoredStats();
  if (localStats) {
    npoStatsState = localStats;
  }
  updateStatsUI();
}

// 完了済みタスクのID記録（サーバー側で削除が保持されない環境でも、
// 一度完了したタスクが一覧に復活しないようにするため）
function getCompletedTaskIds() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.completedIds);
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  return [];
}

function addCompletedTaskId(taskId) {
  try {
    const ids = getCompletedTaskIds();
    if (!ids.includes(taskId)) {
      ids.push(taskId);
      localStorage.setItem(STORAGE_KEYS.completedIds, JSON.stringify(ids));
    }
  } catch (e) {}
}

async function fetchTasks() {
  const completedIds = getCompletedTaskIds();
  let apiTasks = null;

  try {
    const res = await apiFetch("/api/tasks");
    if (res) {
      const data = await res.json();
      if (Array.isArray(data)) {
        apiTasks = data;
      }
    }
  } catch (err) {
    console.warn("⚠️ API fetchTasks fallback to local storage:", err);
  }

  if (apiTasks !== null) {
    // APIが使える場合: APIの内容を正としつつ、APIにまだ無い（または
    // サーバー側で保持されなかった）自分のローカル投稿もマージして保持する
    const apiIds = new Set(apiTasks.map(t => t.id));
    const stored = getStoredTasks();
    const localOnly = (stored || []).filter(t => !apiIds.has(t.id) && !completedIds.includes(t.id));
    tasksState = [...localOnly, ...apiTasks.filter(t => !completedIds.includes(t.id))];
    // 0件なら正直に0件表示する（デモ募集は置かない）
    saveStoredTasks(tasksState);
    renderTasks();
    updateWardCounts();
    return;
  }

  // Fallback for offline/client state
  const local = getStoredTasks();
  if (local && Array.isArray(local)) {
    tasksState = local.filter(t => !completedIds.includes(t.id));
  } else {
    tasksState = [...INITIAL_SAMPLE_TASKS]; // 空配列（デモデータなし）
    saveStoredTasks(tasksState);
  }
  renderTasks();
  updateWardCounts();
}

async function createNewTask(taskData) {
  const newTask = {
    id: "task-" + Date.now(),
    category: taskData.category || "housework",
    categoryName: taskData.categoryName || "💡 住まいの手伝い",
    title: taskData.title,
    description: taskData.description,
    fuzzyLocation: `${taskData.area}（約500m圏内）`,
    exactLocation: `${taskData.area} 登録住所`,
    requesterName: lineUserProfile.displayName ? `${lineUserProfile.displayName}様` : "あなた (浜松市民・本人確認済み)",
    // 第7弾: 投稿者の利用者キーも持たせ、サーバー側レコードと形を揃える
    requesterKey: getMyUserKey(),
    requesterVerified: true,
    timeAgo: "たった今",
    status: "open",
    donationAmount: 500,
    createdAt: new Date().toISOString()
  };

  try {
    const res = await apiFetch("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // 第7弾: 投稿者情報（利用者キーと表示名）も一緒に送り、サーバーに
      // 保存された共有レコードから「誰の投稿か」が分かるようにする
      body: JSON.stringify({
        ...taskData,
        userKey: getMyUserKey(),
        requesterName: lineUserProfile.displayName ? `${lineUserProfile.displayName}様` : ""
      })
    });
    if (res) {
      const data = await res.json();
      if (data.task) {
        tasksState.unshift(data.task);
        saveStoredTasks(tasksState);
        renderTasks();
        updateWardCounts();
        return;
      }
    }
  } catch (err) {
    console.warn("⚠️ API createNewTask fallback:", err);
  }

  // Fallback for client state
  tasksState.unshift(newTask);
  saveStoredTasks(tasksState);
  renderTasks();
  updateWardCounts();
}

async function completeTaskApi(taskId) {
  let apiCounted = false;
  try {
    const res = await apiFetch(`/api/tasks/${taskId}/complete`, { method: "POST" });
    if (res) {
      const data = await res.json();
      if (data.npoStats) {
        // API側の集計値をそのまま採用する（ここで再度加算すると二重計上になる）。
        // サーバーに存在しないタスク（サンプル等）の完了ではサーバーは加算しないため、
        // その場合は下のローカル集計に任せる。
        npoStatsState = data.npoStats;
        apiCounted = data.completed !== false;
        saveStoredStats(npoStatsState);
        updateStatsUI();
      }
    }
  } catch (err) {
    console.warn("⚠️ API completeTask error:", err);
  }

  tasksState = tasksState.filter(t => t.id !== taskId);
  addCompletedTaskId(taskId);
  saveStoredTasks(tasksState);
  if (!apiCounted) {
    // APIが使えなかった場合のみ、このブラウザ内で集計する
    npoStatsState.totalMealsServed = (npoStatsState.totalMealsServed || 0) + 1;
    npoStatsState.totalDonationYen = (npoStatsState.totalDonationYen || 0) + 500;
    saveStoredStats(npoStatsState);
    updateStatsUI();
  }
  renderTasks();
  updateWardCounts();
}

// --- チャット履歴のローカル保存（APIが使えない環境でも会話が消えないように） ---
const LOCAL_AUTO_REPLIES = [
  "ご連絡ありがとうございます！お待ちしておりますね。",
  "ありがとうございます！助かります。どうぞ気をつけてお越しください。",
  "承知いたしました！お会いできるのを楽しみにしております。"
];

function getStoredChats() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.chats);
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  return {};
}

function saveStoredChats() {
  try {
    localStorage.setItem(STORAGE_KEYS.chats, JSON.stringify(chatHistories));
  } catch (e) {}
}

function chatTimeNow() {
  const now = new Date();
  return `${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}`;
}

async function fetchChatMessages(taskId) {
  try {
    const res = await apiFetch(`/api/chat/${taskId}`);
    if (res) {
      const serverMessages = await res.json();
      if (Array.isArray(serverMessages)) {
        // 第7弾: サーバー履歴は全端末で共有される。メッセージの sender は
        // 「送った端末から見た相対表記（me/them）」のため、そのままでは
        // 他人の発言が自分の吹き出しになってしまう。senderKey（送信者の
        // 利用者キー）があるメッセージは、自分のキーと比べて表示側を
        // 決め直す（自動返信の system:auto-reply は常に相手側になる）。
        const myKey = getMyUserKey();
        const normalized = serverMessages.map(m => {
          if (m && m.senderKey) {
            return { ...m, sender: m.senderKey === myKey ? "me" : "them" };
          }
          return m;
        });
        // サーバー履歴を正とし、サーバーに届いていない自分のローカル送信分があれば保持する
        const localOnly = (chatHistories[taskId] || []).filter(m =>
          m._local && !normalized.some(s => (m.id && s.id === m.id) || (s.sender === m.sender && s.text === m.text))
        );
        chatHistories[taskId] = [...normalized, ...localOnly];
        saveStoredChats();
        if (currentChatTaskId === taskId) {
          renderChatMessages();
        }
        return;
      }
    }
  } catch (err) {
    console.warn("⚠️ API fetchChatMessages error:", err);
  }

  // APIが使えない場合はローカル保存分を表示する
  if (!chatHistories[taskId]) {
    chatHistories[taskId] = getStoredChats()[taskId] || [];
  }
  if (currentChatTaskId === taskId) {
    renderChatMessages();
  }
}

async function postChatMessage(taskId, text) {
  try {
    const res = await apiFetch(`/api/chat/${taskId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // 第7弾: 送信者の利用者キーと表示名も送り、受け取った側の端末で
      // 「誰の発言か」が分かるようにする
      body: JSON.stringify({ text: text, sender: "me", userKey: getMyUserKey(), displayName: getMyDisplayName() })
    });
    if (res) {
      // サーバー側の自動返信（約0.8秒後）を拾うため、少し待ってから再取得する
      setTimeout(() => fetchChatMessages(taskId), 300);
      setTimeout(() => fetchChatMessages(taskId), 1300);
      return;
    }
  } catch (err) {
    console.warn("⚠️ API postChatMessage error:", err);
  }

  // APIが使えない場合のローカル動作: 自分のメッセージを保存し、
  // サーバー接続時と同じ自動返信文で相手からの返信を再現する
  if (!chatHistories[taskId]) chatHistories[taskId] = getStoredChats()[taskId] || [];
  chatHistories[taskId].push({ sender: "me", text: text, time: chatTimeNow(), _local: true });
  saveStoredChats();
  renderChatMessages();

  setTimeout(() => {
    if (!chatHistories[taskId]) chatHistories[taskId] = [];
    const reply = LOCAL_AUTO_REPLIES[Math.floor(Math.random() * LOCAL_AUTO_REPLIES.length)];
    chatHistories[taskId].push({ sender: "them", text: reply, time: chatTimeNow(), _local: true });
    saveStoredChats();
    if (currentChatTaskId === taskId) {
      renderChatMessages();
    }
  }, 800);
}

// Initialize Application
document.addEventListener("DOMContentLoaded", () => {
  // Unregister stale service workers and clear caches on mobile devices
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.getRegistrations().then(registrations => {
      registrations.forEach(reg => reg.unregister());
    });
  }
  if ("caches" in window) {
    caches.keys().then(keys => {
      keys.forEach(key => caches.delete(key));
    });
  }

  fetchStats();
  fetchTasks();
  fetchUserVerification();
  initCoinFeatures();
  setupEventListeners();
  setupWardFilters();
  initLineLiff();

  setInterval(() => {
    fetchTasks();
    fetchStats();
    // 本人確認状態はポーリング対象にしない（自分のブラウザの保存状態が正のため）
  }, 5000);
});

// LINE LIFF SDK の初期化状態（実際に初期化できた場合のみ true）
let liffReady = false;
// SDK 自体が読み込めなかった場合に true
let liffSdkMissing = false;
// liff.init() が失敗した場合、そのエラー内容を保持する
let liffInitError = null;

// ヘッダーの LINE ボタンのラベルを、実際の連携状態に合わせて更新する
function updateLineStatusUI() {
  const lineStatusLabel = document.getElementById("lineStatusLabel");
  if (!lineStatusLabel) return;
  if (lineUserProfile.isLoggedIn) {
    lineStatusLabel.textContent = `LINE: ${lineUserProfile.displayName}様`;
  } else {
    lineStatusLabel.textContent = "LINE連携";
  }
}

// LINE の実プロフィールを取得して状態に反映する（LIFF 公式の手順）
async function applyLineProfile() {
  const profile = await liff.getProfile();
  lineUserProfile.displayName = profile.displayName;
  lineUserProfile.pictureUrl = profile.pictureUrl || "";
  lineUserProfile.userId = profile.userId;
  lineUserProfile.isLoggedIn = true;
  updateLineStatusUI();
  return profile;
}

// Initialize LINE LIFF SDK
// 連携状態は「LIFF SDK が実際に初期化でき、かつ LINE 側でログイン済み」の
// 場合にだけ判定します。URLパラメータやローカル保存だけで「連携完了」とは
// しません（以前の実装は code パラメータがあるだけで固定の名前で
// ログイン完了表示になってしまう問題がありました）。
// 手順は LIFF 公式ドキュメント通り: liff.init() → liff.isLoggedIn() を確認し、
// 未ログインなら liff.login()、ログイン済みなら liff.getProfile() で実プロフィールを
// 表示します。ログアウトは liff.logout() を使います。
function initLineLiff() {
  const btnLineLogin = document.getElementById("btnLineLogin");
  if (btnLineLogin) {
    btnLineLogin.addEventListener("click", () => {
      showLineAccountModal();
    });
  }

  if (typeof liff === "undefined") {
    // SDK のスクリプトが読み込めなかった（通信環境・広告ブロック等）
    liffSdkMissing = true;
    console.warn("LINE LIFF SDK が読み込まれていません");
    return;
  }
  // 注意: LINE_CONFIG は line_config.js で const 宣言されているため
  // window.LINE_CONFIG では参照できません（const/let は window のプロパティに
  // なりません）。typeof ガード付きで直接参照します。以前は window.LINE_CONFIG
  // で判定していたため、この条件で常に弾かれ LIFF が初期化されませんでした。
  if (typeof LINE_CONFIG === "undefined" || !LINE_CONFIG.liffId) {
    liffInitError = new Error("LIFF ID が設定されていません");
    return;
  }

  liff.init({ liffId: LINE_CONFIG.liffId }).then(() => {
    liffReady = true;
    if (liff.isLoggedIn()) {
      // ログイン済み（LINEアプリ内、またはログイン後に戻ってきた状態）
      applyLineProfile().then(profile => {
        showToast(`💬 LINEアカウント（${profile.displayName}様）でログイン中`);
      }).catch(err => {
        console.warn("LINE Profile fetch error:", err);
      });
    }
  }).catch(err => {
    // 初期化に失敗する主な原因: LIFF のエンドポイントURLにこのページのURLが
    // 登録されていない、LIFF ID の誤り、チャネルの設定不備など。
    // 失敗を隠さず、モーダルで理由と対処を表示する。
    liffInitError = err;
    console.warn("LINE LIFF init error:", err);
    updateLineStatusUI();
  });
}

// Show LINE Account & LIFF Status Modal
// 状態ごとに正直に表示を切り替えます:
//  - ログイン済み: 実プロフィール（名前・画像）とログアウトボタンを表示
//  - 未ログイン（初期化成功）: ログインボタンを表示
//  - SDK未読込 / 初期化失敗: エラーの内容と再試行ボタンを表示
//  - 公式アカウントURL未設定: 友だち追加ボタンは出さず、その理由を表示
function showLineAccountModal() {
  let modal = document.getElementById("lineAccountModal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "lineAccountModal";
    modal.className = "modal-overlay active";
    document.body.appendChild(modal);
  } else {
    modal.classList.add("active");
  }

  const officialUrl = (typeof LINE_CONFIG !== "undefined" && LINE_CONFIG.officialAccountUrl) || "";
  const friendAddHtml = officialUrl
    ? `<a href="${escapeHTML(officialUrl)}" target="_blank" rel="noopener" class="btn-hero-action" style="display: block; background: white; color: #06c755; border: 2px solid #06c755; width: 100%; font-weight: 800; text-align: center; text-decoration: none; box-sizing: border-box;">
         <i class="fa-solid fa-user-plus"></i> 公式LINEアカウントを友だち追加
       </a>`
    : `<div style="font-size: 0.8rem; color: var(--text-muted); background: #f8fafc; border: 1px dashed #cbd5e1; border-radius: 8px; padding: 0.6rem;">
         公式LINEアカウントは準備中のため、友だち追加はまだ利用できません（アカウント作成後にURLを設定すると、ここにボタンが表示されます）。
       </div>`;

  let statusHtml = "";
  let actionHtml = "";

  if (lineUserProfile.isLoggedIn) {
    statusHtml = `
      <div style="background: #f0fdf4; border: 1.5px solid #86efac; border-radius: 12px; padding: 1.25rem; margin-bottom: 1.25rem;">
        ${lineUserProfile.pictureUrl ? `<img src="${escapeHTML(lineUserProfile.pictureUrl)}" alt="LINEプロフィール画像" style="width: 64px; height: 64px; border-radius: 50%; object-fit: cover; margin-bottom: 0.4rem;">` : `<div style="font-size: 2.2rem; margin-bottom: 0.3rem;">💬</div>`}
        <div style="font-weight: 800; font-size: 1.15rem; color: #166534;">
          LINE連携完了: ${escapeHTML(lineUserProfile.displayName)} 様
        </div>
        <div style="font-size: 0.85rem; color: var(--text-muted); margin-top: 0.4rem; line-height: 1.5;">
          LINEアカウントでログイン中です。面倒なパスワード入力なしでご利用いただけます。
        </div>
      </div>`;
    actionHtml = `
      <button id="btnDoLineLogout" class="btn-hero-action" style="background: #e2e8f0; color: #334155; width: 100%; border: none; font-weight: 800; cursor: pointer;">
        <i class="fa-solid fa-right-from-bracket"></i> LINE連携を解除する（ログアウト）
      </button>`;
  } else if (liffSdkMissing) {
    statusHtml = `
      <div id="lineModalError" style="background: #fef2f2; border: 1.5px solid #fca5a5; border-radius: 12px; padding: 1.25rem; margin-bottom: 1.25rem;">
        <div style="font-size: 2.2rem; margin-bottom: 0.3rem;">⚠️</div>
        <div style="font-weight: 800; font-size: 1.05rem; color: #991b1b;">LINEとの接続部品（SDK）を読み込めませんでした</div>
        <div style="font-size: 0.85rem; color: var(--text-muted); margin-top: 0.4rem; line-height: 1.5;">
          通信環境の影響で読み込みに失敗した可能性があります。ページを再読み込みしてもう一度お試しください。
        </div>
      </div>`;
    actionHtml = `
      <button id="btnDoLineRetry" class="btn-hero-action" style="background: #06c755; color: white; width: 100%; border: none; font-weight: 800; font-size: 1.05rem; cursor: pointer;">
        <i class="fa-solid fa-rotate-right"></i> 再読み込みして再試行
      </button>`;
  } else if (liffInitError) {
    statusHtml = `
      <div id="lineModalError" style="background: #fef2f2; border: 1.5px solid #fca5a5; border-radius: 12px; padding: 1.25rem; margin-bottom: 1.25rem;">
        <div style="font-size: 2.2rem; margin-bottom: 0.3rem;">⚠️</div>
        <div style="font-weight: 800; font-size: 1.05rem; color: #991b1b;">LINE連携の初期化に失敗しました</div>
        <div style="font-size: 0.85rem; color: var(--text-muted); margin-top: 0.4rem; line-height: 1.5;">
          このページのURLが、LINE Developers の LIFF エンドポイントURLに登録されていない場合にこのエラーになります。本番ページ（GitHub Pages）のURLで開いているか、管理者側の設定をご確認ください。
        </div>
      </div>`;
    actionHtml = `
      <button id="btnDoLineRetry" class="btn-hero-action" style="background: #06c755; color: white; width: 100%; border: none; font-weight: 800; font-size: 1.05rem; cursor: pointer;">
        <i class="fa-solid fa-rotate-right"></i> 再読み込みして再試行
      </button>`;
  } else if (liffReady) {
    statusHtml = `
      <div style="background: #f8fafc; border: 1.5px solid #cbd5e1; border-radius: 12px; padding: 1.25rem; margin-bottom: 1.25rem;">
        <div style="font-size: 2.2rem; margin-bottom: 0.3rem;">💬</div>
        <div style="font-weight: 800; font-size: 1.15rem; color: #334155;">LINEアカウントと連携していません</div>
        <div style="font-size: 0.85rem; color: var(--text-muted); margin-top: 0.4rem; line-height: 1.5;">
          LINEで連携すると、面倒なパスワード入力なしでワンタップログインが可能になります。<br>※ログインは LINE の画面に移動して行います。このページのURLが LIFF のエンドポイントに登録されていないプレビュー環境では、ログインが完了しない場合があります。
        </div>
      </div>`;
    actionHtml = `
      <button id="btnDoLineLogin" class="btn-hero-action" style="background: #06c755; color: white; width: 100%; border: none; font-weight: 800; font-size: 1.05rem; cursor: pointer;">
        <i class="fa-brands fa-line" style="font-size: 1.2rem;"></i> LINEアカウントで簡単ログイン
      </button>`;
  } else {
    statusHtml = `
      <div style="background: #f8fafc; border: 1.5px solid #cbd5e1; border-radius: 12px; padding: 1.25rem; margin-bottom: 1.25rem;">
        <div style="font-size: 2.2rem; margin-bottom: 0.3rem;">💬</div>
        <div style="font-weight: 800; font-size: 1.15rem; color: #334155;">LINE連携の状態を確認中です…</div>
        <div style="font-size: 0.85rem; color: var(--text-muted); margin-top: 0.4rem; line-height: 1.5;">
          数秒待っても変わらない場合は、ページを再読み込みしてください。
        </div>
      </div>`;
    actionHtml = `
      <button id="btnDoLineRetry" class="btn-hero-action" style="background: #06c755; color: white; width: 100%; border: none; font-weight: 800; font-size: 1.05rem; cursor: pointer;">
        <i class="fa-solid fa-rotate-right"></i> 再読み込みして再試行
      </button>`;
  }

  modal.innerHTML = `
    <div class="modal-card" style="max-width: 480px; text-align: center; padding: 1.5rem;">
      <div class="modal-header" style="justify-content: space-between; border-bottom: 1px solid #e2e8f0; padding-bottom: 0.75rem; margin-bottom: 1rem;">
        <h3 class="modal-title" style="color: #06c755; display: flex; align-items: center; gap: 0.5rem;">
          <i class="fa-brands fa-line" style="font-size: 1.4rem;"></i> LINE連携・簡単ログイン
        </h3>
        <button class="btn-close-modal" id="btnCloseLineModalHeader">&times;</button>
      </div>

      ${statusHtml}

      <div style="display: flex; flex-direction: column; gap: 0.75rem;">
        ${actionHtml}
        ${friendAddHtml}
        <button id="btnDoLineCancel" class="btn-hero-action" style="background: #e2e8f0; color: #334155; width: 100%; border: none; margin-top: 0.25rem; cursor: pointer;">
          閉じる
        </button>
      </div>
    </div>
  `;

  // Explicit Event Listeners
  const btnDoLineLogin = document.getElementById("btnDoLineLogin");
  if (btnDoLineLogin) {
    btnDoLineLogin.addEventListener("click", (e) => {
      e.preventDefault();
      triggerLiffLoginAction();
    });
  }

  const btnDoLineLogout = document.getElementById("btnDoLineLogout");
  if (btnDoLineLogout) {
    btnDoLineLogout.addEventListener("click", (e) => {
      e.preventDefault();
      triggerLiffLogoutAction();
    });
  }

  const btnDoLineRetry = document.getElementById("btnDoLineRetry");
  if (btnDoLineRetry) {
    btnDoLineRetry.addEventListener("click", () => {
      location.reload();
    });
  }

  const btnCloseLineModalHeader = document.getElementById("btnCloseLineModalHeader");
  if (btnCloseLineModalHeader) {
    btnCloseLineModalHeader.addEventListener("click", closeLineAccountModal);
  }

  const btnDoLineCancel = document.getElementById("btnDoLineCancel");
  if (btnDoLineCancel) {
    btnDoLineCancel.addEventListener("click", closeLineAccountModal);
  }
}

function closeLineAccountModal() {
  const modal = document.getElementById("lineAccountModal");
  if (modal) modal.classList.remove("active");
}

function triggerLiffLoginAction() {
  if (lineUserProfile.isLoggedIn) {
    showToast(`✅ 既にLINEアカウント「${lineUserProfile.displayName}」で連携済みです`);
    closeLineAccountModal();
    return;
  }

  // 初期化できていない場合は、理由に応じて正直に案内する（完了したフリはしない）
  if (liffSdkMissing) {
    showToast("⚠️ LINEの読み込みに失敗しています。ページを再読み込みしてもう一度お試しください。");
    return;
  }
  if (liffInitError) {
    showToast("⚠️ LINE連携の初期化に失敗しました。このページのURLが LIFF のエンドポイントに登録されているかご確認ください。");
    return;
  }
  if (!liffReady || typeof liff === "undefined") {
    showToast("ℹ️ LINE連携の確認中です。数秒待ってからもう一度お試しください。");
    return;
  }

  try {
    if (liff.isLoggedIn()) {
      // 既に LINE 側でログイン済みなら、実プロフィールを取得して連携表示にする
      applyLineProfile().then(profile => {
        showToast(`🎉 LINEアカウント「${profile.displayName}様」と連携が完了しました！`);
        closeLineAccountModal();
      }).catch(err => {
        console.warn("LINE Profile fetch error:", err);
        showToast("⚠️ LINEプロフィールの取得に失敗しました。もう一度お試しください。");
      });
      return;
    }
    // LIFF 公式のログイン処理: LINE のログイン画面へ移動し、認証後に
    // LIFF のエンドポイントURL（登録済みのページ）へ戻ってきます。
    // そのため、開いているページのURLがエンドポイントに登録されていない
    // 環境（プレビュー等）ではログインが完結しません。
    liff.login();
  } catch (e) {
    console.warn("LIFF login failed:", e);
    showToast("⚠️ LINEログインを開始できませんでした。このページのURLが LIFF のエンドポイントに登録されているかご確認ください。");
  }
}

// LINE ログアウト（連携解除）: LIFF 公式の liff.logout() を使い、
// 状態をリセットするためにページを再読み込みします。
function triggerLiffLogoutAction() {
  try {
    if (typeof liff !== "undefined" && liffReady && liff.isLoggedIn()) {
      liff.logout();
    }
  } catch (e) {
    console.warn("LIFF logout error:", e);
  }
  lineUserProfile = { displayName: "", pictureUrl: "", userId: "", isLoggedIn: false };
  updateLineStatusUI();
  showToast("LINE連携を解除しました");
  location.reload();
}

window.showLineAccountModal = showLineAccountModal;
window.closeLineAccountModal = closeLineAccountModal;
window.triggerLiffLoginAction = triggerLiffLoginAction;
window.triggerLiffLogoutAction = triggerLiffLogoutAction;

// Render Tasks Cards Grid with Category & Ward Filters
function renderTasks() {
  if (!tasksGrid) return;
  tasksGrid.innerHTML = "";

  const filtered = tasksState.filter(t => {
    const matchCat = currentCategory === "all" || t.category === currentCategory;
    const matchWard = currentWard === "all" || (t.fuzzyLocation && t.fuzzyLocation.includes(currentWard)) || t.ward === currentWard;
    return matchCat && matchWard;
  });

  if (filtered.length === 0) {
    tasksGrid.innerHTML = `
      <div style="grid-column: 1 / -1; text-align: center; padding: 3.5rem 1.5rem; background: white; border-radius: var(--radius-lg); border: 1.5px dashed var(--border);">
        <i class="fa-solid fa-folder-open" style="font-size: 2.8rem; color: var(--primary); margin-bottom: 0.75rem;"></i>
        <div style="font-weight: 800; font-size: 1.15rem; color: var(--text-main);">現在、募集中の困りごとはありません（0件）</div>
        <div style="font-size: 0.9rem; color: var(--text-muted); margin-top: 0.4rem; max-width: 480px; margin-left: auto; margin-right: auto; line-height: 1.5;">
          右上の<b>「助けてほしい（困りごと投稿）」</b>ボタンを押して、地域の助け合い募集を新しく投稿してみましょう！
        </div>
      </div>
    `;
    return;
  }

  filtered.forEach(task => {
    const card = document.createElement("div");
    card.className = "task-card";
    card.innerHTML = `
      <div>
        <div class="task-card-header">
          <span class="task-cat-pill">${task.categoryName}</span>
          <span class="task-time-ago"><i class="fa-regular fa-clock"></i> ${task.timeAgo || '最近'}</span>
        </div>

        <h4 class="task-title">${escapeHTML(task.title)}</h4>
        <p class="task-description">${escapeHTML(task.description)}</p>

        <div class="task-location-box">
          <i class="fa-solid fa-shield-halved" style="color: var(--info);"></i>
          <span>${escapeHTML(task.fuzzyLocation || '浜松市内')}</span>
        </div>

        <div class="task-requester-info">
          <div class="user-avatar">${(task.requesterName || '浜').substring(0, 1)}</div>
          <div class="user-meta">
            <div class="user-name">${escapeHTML(task.requesterName || '浜松市民様')}</div>
            <div class="user-verified-tag">
              <i class="fa-solid fa-circle-check"></i> 本人確認・身元認証済み
            </div>
          </div>
        </div>
      </div>

      <div class="task-card-footer">
        <div class="donation-tag" title="500円は全額子ども食堂へ寄付されます">
          <i class="fa-solid fa-heart"></i> 手渡し 500円
        </div>
        <button class="btn-help-accept" onclick="openTaskDetails('${task.id}')">
          詳細を見る / 助ける
        </button>
      </div>
    `;
    tasksGrid.appendChild(card);
  });
}

// Category Filtering
categoryButtons.forEach(btn => {
  btn.addEventListener("click", () => {
    categoryButtons.forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    currentCategory = btn.getAttribute("data-cat");
    renderTasks();
  });
});

// Hamamatsu Wards Interactive Filter
function setupWardFilters() {
  const wardButtons = document.querySelectorAll(".ward-pill");
  updateWardCounts();

  wardButtons.forEach(btn => {
    btn.addEventListener("click", () => {
      wardButtons.forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      currentWard = btn.getAttribute("data-ward");
      renderTasks();
    });
  });
}

function updateWardCounts() {
  const wardCountAll = document.getElementById("wardCountAll");
  if (wardCountAll) wardCountAll.textContent = `${tasksState.length}件`;

  const wardButtons = document.querySelectorAll(".ward-pill");
  wardButtons.forEach(btn => {
    const ward = btn.getAttribute("data-ward");
    if (ward !== "all") {
      const count = tasksState.filter(t => (t.fuzzyLocation && t.fuzzyLocation.includes(ward)) || t.ward === ward).length;
      const countSpan = btn.querySelector(".ward-count");
      if (countSpan) countSpan.textContent = `${count}件`;
    }
  });
}

// Event Listeners Setup
function setupEventListeners() {
  // Senior Mode Toggle
  if (toggleSeniorModeBtn) {
    toggleSeniorModeBtn.addEventListener("click", () => {
      isSeniorMode = !isSeniorMode;
      document.body.classList.toggle("senior-mode", isSeniorMode);
      seniorModeLabel.textContent = isSeniorMode ? "通常モードに戻す" : "シニア・かんたん表示モード";
      showToast(isSeniorMode ? "👓 シニア・大文字モードに切り替えました" : "📱 通常表示モードに切り替えました");
    });
  }

  // Open / Close Modals
  if (openCreateTaskBtn) openCreateTaskBtn.addEventListener("click", () => openModal(createTaskModal));
  if (openVerifyModalBtn) openVerifyModalBtn.addEventListener("click", () => {
    resetVerifyModalUI();
    openModal(verifyModal);
  });
  if (openNpoModalBtn) openNpoModalBtn.addEventListener("click", () => openModal(npoModal));
  const linkNpoPlatform = document.getElementById("linkNpoPlatform");
  if (linkNpoPlatform) {
    linkNpoPlatform.addEventListener("click", (e) => {
      e.preventDefault();
      openModal(npoModal);
    });
  }

  document.querySelectorAll(".btn-close-modal").forEach(btn => {
    btn.addEventListener("click", (e) => {
      const modal = e.target.closest(".modal-overlay");
      if (modal) closeModal(modal);
    });
  });

  document.querySelectorAll(".modal-overlay").forEach(overlay => {
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeModal(overlay);
    });
  });

  // Create Task Form Submit
  if (createTaskForm) {
    createTaskForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const title = document.getElementById("taskTitleInput").value;
      const desc = document.getElementById("taskDescInput").value;
      const area = document.getElementById("taskAreaSelect").value;
      const categorySelect = document.getElementById("taskCategorySelect");
      const catVal = categorySelect.value;
      const catName = categorySelect.options[categorySelect.selectedIndex].text;

      await createNewTask({
        category: catVal,
        categoryName: catName,
        title: title,
        description: desc,
        area: area
      });

      // Reset filters so newly created task is 100% visible immediately
      currentCategory = "all";
      currentWard = "all";
      if (categoryButtons) {
        categoryButtons.forEach(b => b.classList.remove("active"));
        document.querySelector('.cat-btn[data-cat="all"]')?.classList.add("active");
      }
      const wardPills = document.querySelectorAll(".ward-pill");
      if (wardPills) {
        wardPills.forEach(b => b.classList.remove("active"));
        document.querySelector('.ward-pill[data-ward="all"]')?.classList.add("active");
      }
      renderTasks();
      updateWardCounts();

      closeModal(createTaskModal);
      createTaskForm.reset();
      showToast("🎉 困りごとの募集を公開しました！サポーターのマッチングをお待ちください。");
      
      updateFamilyLog(`【投稿完了通知】「${title}」の募集が開始されました（子ども食堂支援対象）`);
    });
  }

  // Document Type Radio Selection Switch (マイナンバーカード vs 運転免許証)
  const docTypeRadios = document.querySelectorAll('input[name="docType"]');
  const docLabelMynumber = document.getElementById("docLabelMynumber");
  const docLabelLicense = document.getElementById("docLabelLicense");
  const btnSubmitEkyc = document.getElementById("btnSubmitEkyc");
  const idDropzoneFrontSub = document.getElementById("idDropzoneFrontSub");
  const idDropzoneBackSub = document.getElementById("idDropzoneBackSub");

  function updateDocTypeUI(selectedVal) {
    if (selectedVal === "license") {
      if (docLabelLicense) {
        docLabelLicense.style.background = "var(--primary-light)";
        docLabelLicense.style.borderColor = "var(--primary)";
        docLabelLicense.style.borderWidth = "2px";
        docLabelLicense.style.fontWeight = "800";
        docLabelLicense.style.color = "var(--primary-hover)";
      }
      if (docLabelMynumber) {
        docLabelMynumber.style.background = "white";
        docLabelMynumber.style.borderColor = "var(--border)";
        docLabelMynumber.style.borderWidth = "1.5px";
        docLabelMynumber.style.fontWeight = "700";
        docLabelMynumber.style.color = "var(--text-main)";
      }
      if (btnSubmitEkyc) {
        btnSubmitEkyc.innerHTML = `<i class="fa-solid fa-cloud-arrow-up"></i> 運転免許証で身元確認（eKYC認証実行）`;
      }
      if (idDropzoneFrontSub) idDropzoneFrontSub.textContent = "外側カメラで写真・住所面を撮影";
      if (idDropzoneBackSub) idDropzoneBackSub.textContent = "外側カメラで裏面変更記載面を撮影";
    } else {
      if (docLabelMynumber) {
        docLabelMynumber.style.background = "var(--primary-light)";
        docLabelMynumber.style.borderColor = "var(--primary)";
        docLabelMynumber.style.borderWidth = "2px";
        docLabelMynumber.style.fontWeight = "800";
        docLabelMynumber.style.color = "var(--primary-hover)";
      }
      if (docLabelLicense) {
        docLabelLicense.style.background = "white";
        docLabelLicense.style.borderColor = "var(--border)";
        docLabelLicense.style.borderWidth = "1.5px";
        docLabelLicense.style.fontWeight = "700";
        docLabelLicense.style.color = "var(--text-main)";
      }
      if (btnSubmitEkyc) {
        btnSubmitEkyc.innerHTML = `<i class="fa-solid fa-cloud-arrow-up"></i> マイナンバーカードで身元確認（eKYC認証実行）`;
      }
      if (idDropzoneFrontSub) idDropzoneFrontSub.textContent = "外側カメラで顔写真面を撮影";
      if (idDropzoneBackSub) idDropzoneBackSub.textContent = "外側カメラで個人番号面を撮影";
    }
  }

  docTypeRadios.forEach(radio => {
    radio.addEventListener("change", (e) => {
      updateDocTypeUI(e.target.value);
    });
  });

  // ID Verification (eKYC My Number Card & Driver's License)
  const idDropzoneFront = document.getElementById("idDropzoneFront");
  const idDropzoneBack = document.getElementById("idDropzoneBack");
  const fileInputFront = document.getElementById("fileInputFront");
  const fileInputBack = document.getElementById("fileInputBack");

  let frontImageData = null;
  let backImageData = null;

  window.resetVerifyModalUI = function() {
    const simResult = document.getElementById("verificationSimResult");
    if (simResult) simResult.style.display = "none";

    // 認証実行ボタンを初期状態に戻す（認証完了時に非表示にしたままにしない）
    const ekycBtn = document.getElementById("btnSubmitEkyc");
    if (ekycBtn) {
      ekycBtn.style.display = "";
      ekycBtn.style.pointerEvents = "auto";
    }

    const selectedDocType = document.querySelector('input[name="docType"]:checked')?.value || "mynumber";
    updateDocTypeUI(selectedDocType);

    if (idDropzoneFront) {
      idDropzoneFront.style.background = "";
      idDropzoneFront.style.borderColor = "";
      idDropzoneFront.innerHTML = `
        <i class="fa-solid fa-camera" style="font-size: 2.2rem; color: var(--primary); margin-bottom: 0.4rem;"></i>
        <div style="font-weight: 800; font-size: 0.95rem; color: var(--text-main);">【表面】を撮影・選択</div>
        <div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 0.2rem;" id="idDropzoneFrontSub">タップしてカメラ撮影またはファイル選択</div>
      `;
    }

    if (idDropzoneBack) {
      idDropzoneBack.style.background = "";
      idDropzoneBack.style.borderColor = "";
      idDropzoneBack.innerHTML = `
        <i class="fa-solid fa-id-badge" style="font-size: 2.2rem; color: var(--primary); margin-bottom: 0.4rem;"></i>
        <div style="font-weight: 800; font-size: 0.95rem; color: var(--text-main);">【裏面】を撮影・選択</div>
        <div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 0.2rem;" id="idDropzoneBackSub">タップしてカメラ撮影またはファイル選択</div>
      `;
    }

    if (fileInputFront) fileInputFront.value = "";
    if (fileInputBack) fileInputBack.value = "";
    frontImageData = null;
    backImageData = null;
  };

  if (idDropzoneFront) {
    idDropzoneFront.addEventListener("click", () => {
      handleCaptureRequest("front", fileInputFront);
    });
  }

  if (idDropzoneBack) {
    idDropzoneBack.addEventListener("click", () => {
      handleCaptureRequest("back", fileInputBack);
    });
  }

  function handleFileSelected(file, target) {
    const selectedDocType = document.querySelector('input[name="docType"]:checked')?.value || "mynumber";
    const docName = selectedDocType === "license" ? "運転免許証" : "マイナンバーカード";
    if (file) {
      const reader = new FileReader();
      reader.onload = function(evt) {
        if (target === "front") {
          frontImageData = evt.target.result;
          if (idDropzoneFront) {
            idDropzoneFront.style.background = "#d1fae5";
            idDropzoneFront.style.borderColor = "#059669";
            idDropzoneFront.innerHTML = `
              <img src="${evt.target.result}" style="width: 100%; height: 75px; object-fit: cover; border-radius: var(--radius-sm); margin-bottom: 0.3rem; border: 1.5px solid #059669;">
              <div style="font-weight:800; color:#064e3b; font-size:0.85rem;"><i class="fa-solid fa-circle-check" style="color:#059669;"></i> 表面 登録完了</div>
            `;
          }
          showToast(`📸 ${docName}【表面】の画像が登録されました！`);
        } else {
          backImageData = evt.target.result;
          if (idDropzoneBack) {
            idDropzoneBack.style.background = "#d1fae5";
            idDropzoneBack.style.borderColor = "#059669";
            idDropzoneBack.innerHTML = `
              <img src="${evt.target.result}" style="width: 100%; height: 75px; object-fit: cover; border-radius: var(--radius-sm); margin-bottom: 0.3rem; border: 1.5px solid #059669;">
              <div style="font-weight:800; color:#064e3b; font-size:0.85rem;"><i class="fa-solid fa-circle-check" style="color:#059669;"></i> 裏面 登録完了</div>
            `;
          }
          showToast(`📸 ${docName}【裏面】の画像が登録されました！`);
        }
      };
      reader.readAsDataURL(file);
    }
  }

  if (fileInputFront) {
    fileInputFront.addEventListener("change", (e) => handleFileSelected(e.target.files[0], "front"));
  }

  if (fileInputBack) {
    fileInputBack.addEventListener("change", (e) => handleFileSelected(e.target.files[0], "back"));
  }

  if (btnTakeSnap) {
    btnTakeSnap.addEventListener("click", () => {
      if (!cameraStream) {
        showToast("⚠️ カメラが起動していません。下の「カメラアプリで撮影／写真から選ぶ」からお試しください。");
        return;
      }
      if (cameraVideo && cameraCanvas) {
        const context = cameraCanvas.getContext("2d");
        cameraCanvas.width = cameraVideo.videoWidth || 640;
        cameraCanvas.height = cameraVideo.videoHeight || 480;
        context.drawImage(cameraVideo, 0, 0, cameraCanvas.width, cameraCanvas.height);
        
        const capturedUrl = cameraCanvas.toDataURL("image/jpeg");
        const selectedDocType = document.querySelector('input[name="docType"]:checked')?.value || "mynumber";
        const docName = selectedDocType === "license" ? "運転免許証" : "マイナンバーカード";
        
        if (activeCaptureTarget === "front") {
          frontImageData = capturedUrl;
          idDropzoneFront.style.background = "#d1fae5";
          idDropzoneFront.style.borderColor = "#059669";
          idDropzoneFront.innerHTML = `
            <img src="${capturedUrl}" style="width: 100%; height: 75px; object-fit: cover; border-radius: var(--radius-sm); margin-bottom: 0.3rem; border: 1.5px solid #059669;">
            <div style="font-weight:800; color:#064e3b; font-size:0.85rem;"><i class="fa-solid fa-circle-check" style="color:#059669;"></i> 表面 撮影成功</div>
          `;
          showToast(`📸 ${docName}【表面】を外側カメラで撮影しました！`);
        } else {
          backImageData = capturedUrl;
          idDropzoneBack.style.background = "#d1fae5";
          idDropzoneBack.style.borderColor = "#059669";
          idDropzoneBack.innerHTML = `
            <img src="${capturedUrl}" style="width: 100%; height: 75px; object-fit: cover; border-radius: var(--radius-sm); margin-bottom: 0.3rem; border: 1.5px solid #059669;">
            <div style="font-weight:800; color:#064e3b; font-size:0.85rem;"><i class="fa-solid fa-circle-check" style="color:#059669;"></i> 裏面 撮影成功</div>
          `;
          showToast(`📸 ${docName}【裏面】を外側カメラで撮影しました！`);
        }

        stopCameraStream();
        closeModal(cameraModal);
      }
    });
  }

  if (btnCloseCameraModal) {
    btnCloseCameraModal.addEventListener("click", () => {
      stopCameraStream();
      closeModal(cameraModal);
    });
  }

  if (btnFallbackGallery) {
    btnFallbackGallery.addEventListener("click", () => {
      stopCameraStream();
      closeModal(cameraModal);
      const input = activeCaptureTarget === "back" ? fileInputBack : fileInputFront;
      if (input) input.click();
    });
  }

  // 本人確認の申請ボタン（第3弾で「写真を運営者へ送信し、目視確認を受ける」方式に変更）
  // 以前は撮影するだけで即「認証完了」になるデモ動作でしたが、写真が風景写真でも
  // 通ってしまう問題があったため、運営者が実際に写真を確認して承認する形にしました。
  // 送信できたら状態は「確認待ち（pending）」になり、承認/差し戻しはサーバー側の
  // 状態を syncMyVerificationStatus() で反映します。
  // サーバーへ送れない環境では、従来どおりこの端末内だけで完結させます
  // （プレビュー等のオフライン確認用。写真は端末の外に出ません）。
  if (btnSubmitEkyc) {
    btnSubmitEkyc.addEventListener("click", async () => {
      const selectedDocType = document.querySelector('input[name="docType"]:checked')?.value || "mynumber";
      const docName = selectedDocType === "license" ? "運転免許証" : "マイナンバーカード";
      const badgeIcon = selectedDocType === "license" ? "🚗" : "🪪";

      if (!frontImageData || !backImageData) {
        let missingMsg = "";
        if (!frontImageData && !backImageData) {
          missingMsg = `⚠️ ${docName}の【表面】と【裏面】の両方を外側カメラで撮影してください！`;
        } else if (!frontImageData) {
          missingMsg = `⚠️ ${docName}の【表面】を撮影してください！`;
        } else {
          missingMsg = `⚠️ ${docName}の【裏面】を撮影してください！`;
        }
        showToast(missingMsg);
        return;
      }

      const defaultBtnHtml = `<i class="fa-solid fa-cloud-arrow-up"></i> ${docName}で身元確認（eKYC認証実行）`;
      btnSubmitEkyc.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> 写真を送信しています...`;
      btnSubmitEkyc.style.pointerEvents = "none";

      const simResult = document.getElementById("verificationSimResult");
      const simResultTitle = document.getElementById("simResultTitle");
      const simResultText = document.getElementById("simResultText");

      // --- サーバーへ写真を送信する（運営者の目視確認を受ける） ---
      let submitted = false;
      try {
        const photoForReview = await shrinkImageToJpeg(frontImageData, 800);
        const res = await apiFetch("/api/verify-requests", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userKey: getMyUserKey(),
            displayName: getMyDisplayName(),
            docType: selectedDocType,
            photoDataUrl: photoForReview
          })
        });
        if (res) submitted = true;
      } catch (e) {
        console.warn("⚠️ verify-request submit error:", e);
      }

      if (submitted) {
        // 申請が受理されたので「確認待ち」にする。認証済みにはまだしない
        userVerification.requester = false;
        userVerification.helper = false;
        userVerification.docType = selectedDocType;
        userVerification.verifyStatus = "pending";
        userVerification.verifyReason = "";
        saveStoredVerification(userVerification);
        updateVerificationBadgesUI();

        if (simResultTitle) simResultTitle.innerHTML = `<i class="fa-solid fa-paper-plane"></i> ${docName}の写真を送信しました`;
        if (simResultText) simResultText.textContent = `運営者が写真を確認します（マイナンバーカード等の写真かどうかを目視で確認します）。確認が終わるまでステータスは「確認待ち」です。結果はこの画面のバッジに自動で反映されます。`;
        if (simResult) simResult.style.display = "block";

        btnSubmitEkyc.style.display = "none";
        btnSubmitEkyc.style.pointerEvents = "auto";
        showToast(`📨 ${docName}の写真を送信しました。運営者の確認をお待ちください（確認待ち）。`);
        return;
      }

      // --- サーバーへ送れない場合: 端末内だけで完結（従来動作） ---
      userVerification.requester = true;
      userVerification.helper = true;
      userVerification.docType = selectedDocType;
      saveStoredVerification(userVerification);
      updateVerificationBadgesUI();
      try {
        await apiFetch("/api/user/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ requester: true, helper: true, docType: selectedDocType })
        });
      } catch (e) {}

      if (simResultTitle) simResultTitle.innerHTML = `<i class="fa-solid fa-shield-check"></i> ${docName}公的身元確認 完了！`;
      if (simResultText) simResultText.textContent = `${docName}の登録情報および浜松市住所が正常に照合されました。「相互身元認証済み」バッジが有効化されました。`;
      if (simResult) simResult.style.display = "block";

      btnSubmitEkyc.style.display = "none";
      btnSubmitEkyc.style.pointerEvents = "auto";
      btnSubmitEkyc.innerHTML = defaultBtnHtml;
      showToast(`🎉 撮影された${docName}（表面・裏面）の身元確認が完了し、認証バッジが発行されました！`);
    });
  }

  // Chat Form Submit
  if (chatInputForm) {
    chatInputForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const text = chatInputText.value.trim();
      if (text) {
        sendChatMessage(text);
        chatInputText.value = "";
      }
    });
  }
}

// Open Task Details Modal with 2-Step Location Privacy Unlock
window.openTaskDetails = function(taskId) {
  const task = tasksState.find(t => t.id === taskId);
  if (!task) return;

  const modalBody = document.getElementById("modalTaskBody");
  document.getElementById("modalTaskTitle").textContent = task.title;

  modalBody.innerHTML = `
    <div style="background: var(--bg-main); padding: 1rem; border-radius: var(--radius-md); margin-bottom: 1.25rem; border: 1px solid var(--border);">
      <div style="font-size: 0.85rem; color: var(--text-muted); margin-bottom: 0.3rem;">
        <i class="fa-solid fa-user-shield" style="color: var(--primary);"></i> 依頼者の身元認証情報
      </div>
      <div style="font-weight: 800; font-size: 1.05rem;">${escapeHTML(task.requesterName)}</div>
      <div style="color: var(--primary); font-size: 0.8rem; font-weight: 700;">
        <i class="fa-solid fa-circle-check"></i> 公的身分証明書（マイナンバー/免許証）身元確認済み
      </div>
    </div>

    <div style="margin-bottom: 1.25rem;">
      <h4 style="font-weight: 800; margin-bottom: 0.5rem;">依頼内容</h4>
      <p style="color: var(--text-main); font-size: 0.95rem; line-height: 1.6;">${escapeHTML(task.description)}</p>
    </div>

    <!-- 2-Step Location Privacy Box -->
    <div id="locationPrivacyBox" style="background: #f0fdf4; border: 1.5px solid var(--primary); padding: 1.25rem; border-radius: var(--radius-md); margin-bottom: 1.5rem;">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
        <span style="font-weight: 800; color: var(--primary-hover); font-size: 0.95rem;">
          <i class="fa-solid fa-map-location-dot"></i> 場所（プライバシー保護エリア表示）
        </span>
        <span style="font-size: 0.75rem; background: white; padding: 0.2rem 0.6rem; border-radius: var(--radius-full); color: var(--text-muted); font-weight: 700;">
          二段階開示システム
        </span>
      </div>
      
      <div id="locationText" style="font-size: 0.95rem; font-weight: 700; color: var(--text-main);">
        📍 ${escapeHTML(task.fuzzyLocation || '浜松市内')}
      </div>

      <div id="privacyExplanation" style="font-size: 0.8rem; color: var(--text-muted); margin-top: 0.5rem;">
        ※防犯・プライバシーのため、あなたが「手助けを申し出る」を押し、依頼者が承認した後に正確な住所・部屋番号が開示されます。
      </div>
    </div>

    <!-- 500 Yen Donation Info Box -->
    <div style="background: linear-gradient(135deg, #fef3c7 0%, #fee2e2 100%); padding: 1rem; border-radius: var(--radius-md); margin-bottom: 1.5rem; border: 1px solid rgba(245, 158, 11, 0.4);">
      <div style="font-weight: 800; color: var(--accent-dark); font-size: 0.95rem; margin-bottom: 0.25rem;">
        <i class="fa-solid fa-gift"></i> お礼500円 ➔ 100% 子ども食堂寄付の流れ
      </div>
      <div style="font-size: 0.85rem; color: var(--text-main); line-height: 1.5;">
        作業完了時に依頼者様から500円（手渡し現金または応援封筒）をお受け取りいただき、指定回収場所または事務局へ届けていただきます。あなたの手助けが子どもたちの笑顔に変わります！
      </div>
    </div>

    <div id="modalActionArea">
      <button class="btn-hero-action" style="width: 100%; background: var(--primary); color: white;" onclick="acceptTaskMatch('${task.id}')">
        <i class="fa-solid fa-handshake-angle"></i> この困りごとを助ける（マッチング申請）
      </button>
    </div>
  `;

  openModal(taskDetailModal);
};

// Accept Task Match & Unlock Privacy Location & Enable Chat Button
window.acceptTaskMatch = function(taskId) {
  const task = tasksState.find(t => t.id === taskId);
  if (!task) return;

  const locationPrivacyBox = document.getElementById("locationPrivacyBox");
  const modalActionArea = document.getElementById("modalActionArea");

  locationPrivacyBox.style.background = "#d1fae5";
  locationPrivacyBox.innerHTML = `
    <div style="font-weight: 800; color: var(--primary-hover); font-size: 1rem; margin-bottom: 0.4rem;">
      🎉 マッチング成立！詳細住所が開示されました
    </div>
    <div style="font-size: 1.1rem; font-weight: 900; color: #064e3b; background: white; padding: 0.75rem; border-radius: var(--radius-sm); border: 1px solid #6ee7b7;">
      🏡 正確な目的地: ${escapeHTML(task.exactLocation || '浜松市 登録住所')}
    </div>
    <div style="font-size: 0.8rem; color: var(--primary-hover); margin-top: 0.5rem; font-weight: 700;">
      <i class="fa-solid fa-shield-check"></i> 本人確認済み同士の安心マッチングです。下記のチャットボタンから連絡が可能です。
    </div>
  `;

  modalActionArea.innerHTML = `
    <button class="btn-hero-action" style="width: 100%; background: var(--info); color: white; margin-bottom: 0.75rem;" onclick="openChatModal('${task.id}')">
      <i class="fa-solid fa-comments"></i> 💬 依頼者とメッセージでチャットする
    </button>

    <button class="btn-hero-action" style="width: 100%; background: var(--secondary); color: white;" onclick="completeTaskAndDonate('${task.id}')">
      <i class="fa-solid fa-circle-check"></i> 作業完了！500円を受け取り子ども食堂へ寄付
    </button>
  `;

  showToast("🤝 マッチングが成立しました！チャット機能が解放されました。");
  updateFamilyLog(`【安心通知】サポーターとのマッチングが完了し、チャットでの事前連絡が開始されました。`);
};

// Open LINE-Style Chat Modal with Real-Time Polling
window.openChatModal = function(taskId) {
  const task = tasksState.find(t => t.id === taskId);
  if (!task) return;

  currentChatTaskId = taskId;
  chatAvatar.textContent = (task.requesterName || "浜").substring(0, 1);
  chatUserName.textContent = task.requesterName || "依頼者様";
  chatContextTitle.textContent = `📌 依頼「${task.title}」のメッセージ`;

  fetchChatMessages(taskId);

  if (chatPollingTimer) clearInterval(chatPollingTimer);
  chatPollingTimer = setInterval(() => {
    if (currentChatTaskId === taskId) {
      fetchChatMessages(taskId);
    }
  }, 2500);

  openModal(chatModal);
};

// Render Chat Messages Timeline
function renderChatMessages() {
  if (!currentChatTaskId || !chatMessagesContainer) return;

  const messages = chatHistories[currentChatTaskId] || [];
  chatMessagesContainer.innerHTML = "";

  if (messages.length === 0) {
    chatMessagesContainer.innerHTML = `
      <div style="text-align: center; color: var(--text-muted); font-size: 0.85rem; padding: 2rem 0;">
        まだメッセージはありません。下部のメッセージ欄またはワンタップ返信から連絡してみましょう！
      </div>
    `;
    return;
  }

  messages.forEach(msg => {
    const bubble = document.createElement("div");
    bubble.className = `chat-bubble ${msg.sender === 'me' ? 'outgoing' : 'incoming'}`;
    bubble.innerHTML = `
      <div>${escapeHTML(msg.text)}</div>
      <div class="chat-time">${msg.time || ''} ${msg.sender === 'me' ? '既読' : ''}</div>
    `;
    chatMessagesContainer.appendChild(bubble);
  });

  chatMessagesContainer.scrollTop = chatMessagesContainer.scrollHeight;
}

window.sendQuickMessage = function(text) {
  sendChatMessage(text);
};

function sendChatMessage(text) {
  if (!currentChatTaskId) return;
  postChatMessage(currentChatTaskId, text);
}

// Complete Task & Update Children's Kitchen Impact Counter
window.completeTaskAndDonate = async function(taskId) {
  await completeTaskApi(taskId);
  closeModal(taskDetailModal);
  closeModal(chatModal);

  showToast("🌟 作業完了お疲れ様でした！500円が子ども食堂へ送られ、1食分の笑顔が増えました！");
  updateFamilyLog(`【作業完了通知】助け合い作業が完了し、手渡し500円が「子ども食堂」運営資金へ寄付されました！`);
};

// Helper Functions & Utilities

// --- Camera (本人確認書類の撮影) ---
function stopCameraStream() {
  if (cameraStream) {
    cameraStream.getTracks().forEach(track => track.stop());
    cameraStream = null;
  }
  if (cameraVideo) {
    cameraVideo.srcObject = null;
  }
}

// getUserMedia の失敗理由ごとに、利用者向けの日本語メッセージを返す
function cameraErrorMessage(err) {
  const name = (err && err.name) || "";
  switch (name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
      return "カメラの使用が許可されませんでした。ブラウザや端末の設定で、このサイトへのカメラ許可をオンにしてから、もう一度お試しください。アプリ内ブラウザでは許可できない場合があります。";
    case "NotFoundError":
    case "DevicesNotFoundError":
    case "OverconstrainedError":
      return "使えるカメラが見つかりませんでした。カメラ付きの端末でお試しください。";
    case "NotReadableError":
    case "TrackStartError":
      return "カメラが他のアプリで使用中のため起動できませんでした。他のカメラアプリを終了してから、もう一度お試しください。";
    case "SecurityError":
      return "このページの表示方法ではカメラを使えません（安全な接続が必要です）。";
    default:
      if (err && err.message === "camera unsupported") {
        return "このブラウザではページ内カメラに対応していません。";
      }
      return "カメラの起動中に問題が発生しました。";
  }
}

function showCameraError(err) {
  const box = document.getElementById("cameraErrorBox");
  const text = document.getElementById("cameraErrorText");
  if (text) text.textContent = cameraErrorMessage(err);
  if (box) box.style.display = "block";
  if (btnTakeSnap) btnTakeSnap.style.display = "none";
}

function hideCameraError() {
  const box = document.getElementById("cameraErrorBox");
  if (box) box.style.display = "none";
  if (btnTakeSnap) btnTakeSnap.style.display = "";
}

// 撮影ボタンが押されたときの入口。
// ・ページ内カメラ（getUserMedia）が使える環境では、ユーザーのタップ操作の
//   ハンドラ内からそのまま権限リクエストまで進める（権限ダイアログが出やすい）。
// ・使えない環境（アプリ内ブラウザ等）では、非同期処理を挟まずタップの流れの
//   中で直接ファイル入力を開く。capture="environment" 付きなので、Android では
//   端末のカメラアプリが起動する。非同期の後から input.click() を呼ぶ方式は
//   ブラウザにブロックされて「何も起きない」ことがあるため避ける。
function handleCaptureRequest(target, fallbackFileInput) {
  activeCaptureTarget = target === "back" ? "back" : "front";
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showToast("ℹ️ このブラウザではページ内カメラが使えないため、カメラアプリ／写真選択を開きます");
    if (fallbackFileInput) fallbackFileInput.click();
    return;
  }
  openCameraForCapture(target, fallbackFileInput);
}

async function startCameraStream(target) {
  activeCaptureTarget = target === "back" ? "back" : "front";

  const titleEl = document.getElementById("cameraModalTitle");
  const guideEl = document.getElementById("cameraGuideText");
  const sideLabel = activeCaptureTarget === "back" ? "【裏面】" : "【表面】";
  if (titleEl) titleEl.textContent = `📷 カメラでカードの${sideLabel}を撮影`;
  if (guideEl) guideEl.textContent = `枠内にカードの${sideLabel}を合わせて「写真を撮影する」を押してください`;

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !cameraVideo) {
    const err = new Error("camera unsupported");
    err.name = "NotSupportedError";
    throw err;
  }
  stopCameraStream();
  // 権限リクエストはユーザーのタップから直接たどれるよう、余計な非同期処理を
  // 挟まずに getUserMedia を呼ぶ
  cameraStream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "environment" },
    audio: false
  });
  cameraVideo.muted = true;
  cameraVideo.srcObject = cameraStream;
  try {
    await cameraVideo.play();
  } catch (playErr) {
    // autoplay / playsinline / muted が揃っていれば通常は再生できる。
    // 再生開始だけ失敗しても映像自体は表示される場合があるため、致命扱いにしない
    console.warn("camera video play() warning:", playErr);
  }
}

// カメラモーダルを開く。起動に失敗した場合はモーダル内に理由を表示し、
// 「カメラアプリで撮影／写真から選ぶ」ボタン（利用者のタップで確実に開ける）
// へ誘導する。以前は非同期処理の後で自動的にファイル選択を開いていたが、
// ブラウザにブロックされて何も起きないケースがあったため変更した。
async function openCameraForCapture(target, fallbackFileInput) {
  activeCaptureTarget = target === "back" ? "back" : "front";
  hideCameraError();
  openModal(cameraModal);
  try {
    await startCameraStream(target);
    hideCameraError();
  } catch (err) {
    console.warn("Camera unavailable:", err);
    stopCameraStream();
    showCameraError(err);
    showToast("⚠️ " + cameraErrorMessage(err));
  }
}

function openModal(modal) {
  if (modal) modal.classList.add("active");
}

function closeModal(modal) {
  if (modal) modal.classList.remove("active");
  if (modal === cameraModal) {
    // どの閉じ方（×ボタン・外側タップ等）でもカメラは確実に止める
    stopCameraStream();
  }
  if (modal === chatModal) {
    if (chatPollingTimer) {
      clearInterval(chatPollingTimer);
      chatPollingTimer = null;
    }
    currentChatTaskId = null;
  }
}

function showToast(message) {
  if (!toastContainer) return;
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.innerHTML = message;
  toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.classList.add("show");
  }, 10);

  setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

function updateFamilyLog(message) {
  if (!familyNotificationLog) return;
  const now = new Date();
  const timeStr = `${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}`;
  familyNotificationLog.innerHTML = `
    <div style="color: var(--primary); font-weight: 700;">
      <i class="fa-solid fa-paper-plane"></i> 最終通知履歴 (本日 ${timeStr})
    </div>
    <div>${escapeHTML(message)}</div>
  `;
}

function escapeHTML(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
