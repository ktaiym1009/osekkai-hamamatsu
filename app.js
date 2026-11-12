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

// 本人確認「確認待ち」の自動更新ポーリング（第12弾）
// 間隔の根拠: サーバー側の読み込みキャッシュ（ハイドレーションTTL 15秒・
// 第9弾）より短い間隔で問い合わせても、サーバーは最大で15秒前の状態しか
// 返せないため無駄が多い。TTL を少し上回る20秒にすると、連続する問い合
// わせはほぼ毎回サーバー側の再読み込み間隔を超え、新しい状態が返る。
// 承認の反映に気づくまでの遅延は、概ね「間隔20秒＋TTLの残り最大15秒」
// 程度が目安（あわせて第9弾の伝播遅延の項も参照）。
const VERIFY_POLL_INTERVAL_MS = 20000;
let verifyPollingTimer = null;

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
  // 第17弾: 自分で削除したタスクのID記録（完了とは別枠。実績カウンターに
  // 一切影響させないため completedIds とは混ぜない）
  deletedIds: "osekkai_v2_deleted_task_ids",
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

// --- 第14弾: 本人確認は LINE 連携済みを前提にする ---
// LINE 内ブラウザと Chrome では保存領域が分かれている（別の入れ物）ため、
// 端末キーで申請すると、後から LINE で開いたときに同じ人の申請として
// 見つけられず「Chromeでは認証済みなのに LINE では未承認」という事故が
// 起きました。本人確認は、自分の鍵が LINE アカウント（line: 形式）に
// なる状態でのみ進められるようにします。サーバー側でも端末キー等の
// 新規申請は 400 で断ります（local_server.js の isLineUserKey）。
function isLineLinkedForVerify() {
  return !!(lineUserProfile && lineUserProfile.isLoggedIn && lineUserProfile.userId);
}

// 連携のために LINE の画面へ移動する前に付けておく「連携が終わったら
// 本人確認に戻る」印。戻ってきたとき（LIFF 初期化でプロフィールが
// 反映されたとき）に、本人確認モーダルを開き直して続けられるようにする。
const VERIFY_LINK_PENDING_KEY = "osekkai_v2_verify_link_pending";

function markVerifyLinkPending() {
  try { sessionStorage.setItem(VERIFY_LINK_PENDING_KEY, "1"); } catch (e) {}
}

function consumeVerifyLinkPending() {
  try {
    const v = sessionStorage.getItem(VERIFY_LINK_PENDING_KEY);
    if (v) sessionStorage.removeItem(VERIFY_LINK_PENDING_KEY);
    return !!v;
  } catch (e) { return false; }
}

// 本人確認モーダル内の「LINE 連携が必要です」案内の表示を、連携状態に合わせる
function updateVerifyLinkGateUI() {
  const guide = document.getElementById("verifyLineLinkGuide");
  if (guide) guide.style.display = isLineLinkedForVerify() ? "none" : "block";
}

// 本人確認に戻る印が付いていれば、本人確認モーダルを開き直す（連携完了後の続行用）
function reopenVerifyModalIfPending() {
  if (!consumeVerifyLinkPending()) return;
  if (typeof window.resetVerifyModalUI === "function") window.resetVerifyModalUI();
  openModal(verifyModal);
}

window.isLineLinkedForVerify = isLineLinkedForVerify;
window.updateVerifyLinkGateUI = updateVerifyLinkGateUI;

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
    if (res) {
      const data = await res.json();
      const req = data && data.request;
      if (req) {
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
      }
    }
  } catch (err) {
    console.warn("⚠️ verify-requests/mine sync error:", err);
  }
  // 第12弾: 同期後の状態に合わせて自動更新ポーリングを開始/停止する
  updateVerifyStatusPolling();
}

// ==========================================================================
// 本人確認「確認待ち」の自動更新ポーリング（第12弾）
// - 申請が「確認待ち（pending）」の間だけ状態を取り直し、運営の承認／
//   差し戻しが、アプリを開いたままでもバッジに自動で反映されるようにする。
// - 開始条件は「自分の申請が確認待ちであること」のみ。未申請・状態未取得
//   の端末では一切動かず、確定（承認/差し戻し）したら停止する。
// - 画面が非表示の間は停止し、前面に戻ったら即時に1回確認して再開する。
// ==========================================================================
function startVerifyStatusPolling() {
  if (verifyPollingTimer) return;
  if (userVerification.verifyStatus !== "pending") return;
  verifyPollingTimer = setInterval(() => pollVerifyStatusNow(), VERIFY_POLL_INTERVAL_MS);
}

function stopVerifyStatusPolling() {
  if (verifyPollingTimer) {
    clearInterval(verifyPollingTimer);
    verifyPollingTimer = null;
  }
}

// 現在の状態に合わせてポーリングを開始/停止する（状態同期のたびに呼ばれる）
function updateVerifyStatusPolling() {
  if (userVerification.verifyStatus === "pending" && !document.hidden) {
    startVerifyStatusPolling();
  } else {
    stopVerifyStatusPolling();
  }
}

// ポーリング1回分: 状態を取り直し、確定への変化があれば利用者に知らせる
async function pollVerifyStatusNow() {
  const before = userVerification.verifyStatus;
  await syncMyVerificationStatus();
  const after = userVerification.verifyStatus;
  if (before === "pending" && after === "approved") {
    showToast("🎉 本人確認が承認されました！バッジが「認証済み」になりました。");
  } else if (before === "pending" && after === "rejected") {
    showToast("📨 本人確認の結果が届きました。「再提出のお願い」をご確認ください。");
  }
  if (after !== "pending") stopVerifyStatusPolling();
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    // バックグラウンドではポーリングを止める（電池・通信量の節約）
    stopVerifyStatusPolling();
  } else if (userVerification.verifyStatus === "pending") {
    // 前面に戻ったら、その場で1回確認してからポーリングを再開する
    pollVerifyStatusNow();
    updateVerifyStatusPolling();
  }
});

window.getMyUserKey = getMyUserKey;
window.syncMyVerificationStatus = syncMyVerificationStatus;
window.startVerifyStatusPolling = startVerifyStatusPolling;
window.stopVerifyStatusPolling = stopVerifyStatusPolling;
window.pollVerifyStatusNow = pollVerifyStatusNow;
window.VERIFY_POLL_INTERVAL_MS = VERIFY_POLL_INTERVAL_MS;

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

// ステータスコードを判定したい場合用（第10弾）。apiFetch と同じ順序
// （相対 → クラウド）で試すが、ok でなくても応答を返す。相対URLの応答は
// 本物のAPI（JSON）のときだけ採用する（GitHub Pages の HTML 404 を
// 本物の 404 と取り違えないため。admin.html の adminFetch と同じ方針）。
async function apiFetchRaw(endpoint, options = {}) {
  const isApiJson = (res) => {
    try {
      const ct = res && res.headers && typeof res.headers.get === "function" ? res.headers.get("content-type") : null;
      return !!ct && ct.indexOf("json") !== -1;
    } catch (e) { return false; }
  };
  try {
    const res = await fetch(endpoint, options);
    if (res && isApiJson(res)) return res;
  } catch (err) {}
  try {
    const res = await fetch(BACKEND_CLOUD_API + endpoint, options);
    if (res) return res;
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

// 削除済みタスクのID記録（第17弾）
// 完了済みとは別枠にするのが肝心です: completedIds に入れた記録は「作業が
// 終わった投稿」の扱いで、完了フロー側の集計と結びついています。削除は
// 「無かったことにする」操作なので、実績カウンター（助け合い実績・寄付額）
// が増えるような副作用を絶対に起こさないよう、専用の記録に分けます。
// fetchTasks はこの記録にあるIDを、サーバー分・端末内分の両方から
// 常に除外するため、削除した投稿がローカルマージで復活することは
// ありません。
function getDeletedTaskIds() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.deletedIds);
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  return [];
}

function addDeletedTaskId(taskId) {
  try {
    const ids = getDeletedTaskIds();
    if (!ids.includes(taskId)) {
      ids.push(taskId);
      localStorage.setItem(STORAGE_KEYS.deletedIds, JSON.stringify(ids));
    }
  } catch (e) {}
}

// --- 端末内のみタスクの判定（第18弾） ---
// fetchTasks が直近でAPI取得に成功したときの「サーバーに実在するタスク
// IDの集合」を保持します。tasksState のうちこの集合に無いタスクは、
// サーバーには無くこの端末の保存データにだけある「端末内のみ
// （localOnly）」の投稿です（共有化より前に作られたテスト投稿など）。
// 第17弾の削除ボタンは requesterKey が現在の自分のキーと一致する投稿に
// しか出なかったため、キーが null・連携前の旧キーで記録された端末内のみ
// の投稿にはボタンが出ず、消せないまま残っていました。第18弾ではこの
// 判定を使って、端末内のみの投稿にも削除ボタンを出します。その削除は
// この端末のコピーを消すだけの操作で、サーバーや他の利用者の画面には
// 一切影響しません（サーバーに実在する他人の投稿には出さない）。
// 直近の取得が失敗（オフライン等）のフォールバック時は、サーバーの
// 実在を確認できないため、保存済みタスクをすべて端末内のみとして
// 扱います（この場合の削除も端末内のみです）。
let serverTaskIds = null;
let tasksFetchUsedFallback = false;

function isLocalOnlyTask(task) {
  if (!task) return false;
  if (tasksFetchUsedFallback) return true;
  if (serverTaskIds === null) return true; // まだ一度も取得に成功していない
  return !serverTaskIds.has(task.id);
}

async function fetchTasks() {
  const completedIds = getCompletedTaskIds();
  // 第17弾: 自分で削除した投稿は、サーバー分・端末内分のどちらからも
  // 二度と表示しない（サーバー側の削除が届かなかった場合の保険も兼ねる）
  const deletedIds = getDeletedTaskIds();
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
    // 第18弾: 直近の取得成功として「サーバーに実在するタスクIDの集合」を
    // 更新する（端末内のみ判定 isLocalOnlyTask が使う）
    serverTaskIds = new Set(apiTasks.map(t => t.id));
    tasksFetchUsedFallback = false;
    // APIが使える場合: APIの内容を正としつつ、APIにまだ無い（または
    // サーバー側で保持されなかった）自分のローカル投稿もマージして保持する
    const apiIds = serverTaskIds;
    const stored = getStoredTasks();
    const localOnly = (stored || []).filter(t => !apiIds.has(t.id) && !completedIds.includes(t.id) && !deletedIds.includes(t.id));
    tasksState = [...localOnly, ...apiTasks.filter(t => !completedIds.includes(t.id) && !deletedIds.includes(t.id))];
    // 0件なら正直に0件表示する（デモ募集は置かない）
    saveStoredTasks(tasksState);
    renderTasks();
    updateWardCounts();
    return;
  }

  // Fallback for offline/client state
  // 第18弾: フォールバック時はサーバーの実在を確認できないため、保存済み
  // タスクをすべて端末内のみとして扱う（isLocalOnlyTask が参照する）
  tasksFetchUsedFallback = true;
  const local = getStoredTasks();
  if (local && Array.isArray(local)) {
    tasksState = local.filter(t => !completedIds.includes(t.id) && !deletedIds.includes(t.id));
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
    // 第10弾: 手伝う人の確定状態（サーバー側レコードと形を揃える）
    helperKey: null,
    helperName: "",
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

// --- 自分の投稿の削除（第17弾） ---
// これまで投稿を取り下げ・削除する手段は運営者の管理画面しかなく、共有化
// より前に端末内だけで作った投稿（テスト投稿など）が、本人の画面にだけ
// 残り続けていました。自分の投稿のカードにだけ削除ボタンを出し、
// 本人が自分の手で消せるようにします。
// 削除の流れ:
//   1. サーバーにもある投稿は POST /api/tasks/:id/delete でサーバーからも
//      消す（サーバー側で requesterKey と自分のキーの一致を検証する。
//      他人の投稿はボタン自体が出ず、万一呼ばれてもサーバーが 403）。
//   2. サーバーに無い（404）= 端末内だけの投稿は、そのまま端末側の削除で
//      完了とする。サーバーへ届かない（オフライン等）場合も、claim /
//      release と同じ方針で端末側の削除に進む（自分の画面からは消える。
//      ただしその場合サーバー側のコピーは残りうるため、完全な削除は
//      運営者の管理削除でも担保する）。
//   3. 端末側は tasksState と保存データから除き、削除済みID記録
//      （deletedIds）にも入れる。fetchTasks はこの記録を常に除外する
//      ため、端末内マージで復活することは二度とない。完了済みID記録
//      （completedIds）には絶対に入れない（「完了」として実績カウンター
//      が増える副作用を避けるため）。
// 第18弾の追加: 端末内のみの投稿（isLocalOnlyTask）は、requesterKey が
// null や連携前の旧キーで自分の投稿と判定できない場合でも、削除ボタン
// を出して消せるようにします。この端末の保存データにしか無いコピーを
// 消すだけなので、サーバー削除APIは呼ばず（サーバーに実在しないため
// 呼んでも 404 になるだけ）、端末側の削除だけで完了します。自分の投稿
// と判定できるものは従来どおり上記 1〜3 の流れ（サーバー削除API経由）
// で処理し、第17弾の挙動は変えません。
function applyLocalTaskDelete(taskId) {
  tasksState = tasksState.filter(t => t.id !== taskId);
  addDeletedTaskId(taskId);
  // 端末内に残っている、その投稿のチャット履歴も一緒に消す
  // （サーバー側の削除がタスク＋チャットを消すのと揃える）
  if (chatHistories && chatHistories[taskId]) {
    delete chatHistories[taskId];
    saveStoredChats();
  }
  chatForbiddenTaskIds.delete(taskId);
  saveStoredTasks(tasksState);
  renderTasks();
  updateWardCounts();
}

window.deleteOwnTask = async function(taskId) {
  const task = tasksState.find(t => t.id === taskId);
  if (!task) return;
  const isMine = !!task.requesterKey && task.requesterKey === getMyUserKey();
  // 第18弾: 端末内のみの投稿は、自分の投稿と判定できなくても削除対象に
  // する（ボタンもその条件で出している）。サーバーに実在する他人の投稿
  // だけは対象外で、何もしない。
  const localOnly = isLocalOnlyTask(task);
  if (!isMine && !localOnly) return;
  if (!window.confirm("この投稿を削除しますか？")) return;

  if (localOnly && !isMine) {
    // 端末内のみの投稿はサーバーに実在しないため、サーバー削除APIは
    // 呼ばない。端末側の削除（deletedIds 登録＋チャット履歴の削除）で
    // 完了し、再取得でも復活しない。
    applyLocalTaskDelete(taskId);
    showToast("投稿を削除しました");
    return;
  }

  let serverRefused = false;
  try {
    const res = await apiFetchRaw(`/api/tasks/${taskId}/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userKey: getMyUserKey() })
    });
    if (res && res.status === 403) {
      // サーバー側の記録では自分の投稿ではない（鍵が食い違っている）。
      // 端末側だけ消すと実態と食い違うため、削除自体を中止する。
      serverRefused = true;
    }
    // 200: サーバーからも削除済み
    // 404: サーバーには無い（端末内だけの投稿）→ 端末側の削除で完了
    // それ以外（500・応答なし）: 端末側の削除に進む（上の方針コメント参照）
  } catch (err) {
    console.warn("⚠️ API deleteOwnTask error:", err);
  }
  if (serverRefused) {
    showToast("この投稿は削除できませんでした");
    return;
  }
  applyLocalTaskDelete(taskId);
  showToast("投稿を削除しました");
};

// --- チャット履歴のローカル保存（APIが使えない環境でも会話が消えないように） ---
// 第10弾: ローカル動作時の「自動返信の再現」も廃止しました（サーバー側と
// 同様、本物の相手の返事に見えて紛らわしいため）。APIが使えない場合は
// 自分の送信分だけを端末に残します。
// 第10弾: サーバーから 403 が返った（当事者でない）タスクを記録し、
// チャット画面に「当事者だけが見られます」の案内を出すために使います。
const chatForbiddenTaskIds = new Set();

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
    // 第10弾: チャットは当事者だけが読めるため、自分の利用者キーを付けて
    // 取得する。403（当事者でない）は「接続できない」場合と区別して扱う
    // 必要があるため、ステータスが取れる apiFetchRaw を使う。
    const res = await apiFetchRaw(`/api/chat/${taskId}?userKey=${encodeURIComponent(getMyUserKey())}`);
    if (res && res.status === 403) {
      chatForbiddenTaskIds.add(taskId);
      chatHistories[taskId] = [];
      if (currentChatTaskId === taskId) {
        renderChatMessages();
      }
      return;
    }
    if (res && res.ok) {
      chatForbiddenTaskIds.delete(taskId);
      const serverMessages = await res.json();
      if (Array.isArray(serverMessages)) {
        // 第7弾: サーバー履歴は当事者の端末で共有される。メッセージの sender は
        // 「送った端末から見た相対表記（me/them）」のため、そのままでは
        // 他人の発言が自分の吹き出しになってしまう。senderKey（送信者の
        // 利用者キー）があるメッセージは、自分のキーと比べて表示側を
        // 決め直す（過去の自動返信 system:auto-reply は常に相手側になる）。
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
    // res が 404（サーバーに無いタスク＝端末内だけの投稿）や接続不可の
    // 場合は、下のローカル表示にフォールバックする
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
    // 第10弾: 送信も当事者だけに制限されるため、403 を区別できる
    // apiFetchRaw を使う（userKey は body で送る。第7弾と同じ）
    const res = await apiFetchRaw(`/api/chat/${taskId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // 第7弾: 送信者の利用者キーと表示名も送り、受け取った側の端末で
      // 「誰の発言か」が分かるようにする
      body: JSON.stringify({ text: text, sender: "me", userKey: getMyUserKey(), displayName: getMyDisplayName() })
    });
    if (res && res.ok) {
      // 送信がサーバーに反映された状態で履歴を取り直す（第10弾で自動
      // 返信は廃止したため、再取得は1回で十分。定期ポーリングもある）
      setTimeout(() => fetchChatMessages(taskId), 400);
      return;
    }
    if (res && res.status === 403) {
      showToast("🔒 やり取りは当事者だけが使えます");
      fetchChatMessages(taskId);
      return;
    }
    // res が無い（接続不可）/ 404（サーバーに無いタスク）などは下の
    // ローカル動作にフォールバックする
  } catch (err) {
    console.warn("⚠️ API postChatMessage error:", err);
  }

  // APIが使えない場合のローカル動作: 自分のメッセージだけを端末に残す
  // （第10弾で、相手の返事を装う自動返信の再現は廃止した）
  if (!chatHistories[taskId]) chatHistories[taskId] = getStoredChats()[taskId] || [];
  chatHistories[taskId].push({ sender: "me", text: text, time: chatTimeNow(), _local: true });
  saveStoredChats();
  renderChatMessages();
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
    // 本人確認状態はこの5秒ポーリングには含めない。確認待ちの間だけ動く
    // 専用ポーリング（20秒・第12弾）で自動更新する（updateVerifyStatusPolling）
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
  // 第14弾: 連携が成立したので、本人確認モーダルの連携案内は隠す
  updateVerifyLinkGateUI();
  // 第16弾: プロフィールが反映されたら、LINE の鍵で自分の申請状態を
  // 取り直す。起動直後の同期（fetchUserVerification）は LIFF 初期化より
  // 先に走るため、その時点では端末キーで問い合わせてしまい、サーバーに
  // 承認済みの申請があっても「未認証」のままになっていた（実地症状）。
  // プロフィール反映の共通経路であるここで再同期すれば、自動初期化・
  // 手動ログインのどちらの経路でも LINE の鍵で問い直せる。
  await syncMyVerificationStatus();
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
        // 第14弾: 本人確認の途中で連携するために移動し、戻ってきた場合は
        // 本人確認モーダルを開き直して、そのまま続けられるようにする
        reopenVerifyModalIfPending();
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
        // 第14弾: 本人確認から連携しに来た場合は、本人確認へ戻す
        reopenVerifyModalIfPending();
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
    // 第10弾: 手伝う人の確定状態をカードでも見分けられるようにする
    const myKeyForBadge = getMyUserKey();
    let helperBadge = "";
    if (task.helperKey && task.helperKey === myKeyForBadge) {
      helperBadge = `<div style="font-size: 0.8rem; font-weight: 800; color: var(--primary-hover); margin-top: 0.5rem;">🤝 あなたが手伝う人です</div>`;
    } else if (task.helperKey) {
      helperBadge = `<div style="font-size: 0.8rem; font-weight: 700; color: var(--text-muted); margin-top: 0.5rem;">🤝 手伝う人決定済み</div>`;
    }
    // 第17弾: 自分の投稿のカードにだけ削除ボタンを出す（他人の投稿には
    // 一切出ない。サーバー側でも所有者キーを照合するため二重に安全）
    // 第18弾: 端末内のみの投稿（サーバーに実在せず、この端末の保存データ
    // にだけ残っている投稿）にも削除ボタンを出す。共有化より前のテスト
    // 投稿は requesterKey が null や連携前の旧キーで記録されており、第17弾
    // の条件ではボタンが出なかった。端末内のみの投稿の削除はこの端末の
    // コピーを消すだけなので、他人のサーバー上の投稿には一切影響しない。
    // サーバーに実在する他人の投稿には引き続き出さない。
    const isMyTask = !!task.requesterKey && task.requesterKey === myKeyForBadge;
    const canDeleteTask = isMyTask || isLocalOnlyTask(task);
    const deleteButton = canDeleteTask ? `
      <div style="text-align: right; margin-top: 0.6rem;">
        <button class="btn-delete-own-task" onclick="deleteOwnTask('${task.id}')" style="background: white; color: #b91c1c; border: 1.5px solid var(--border); border-radius: var(--radius-md); padding: 0.4rem 0.8rem; font-size: 0.82rem; font-weight: 700; cursor: pointer;">
          <i class="fa-solid fa-trash"></i> この投稿を削除
        </button>
      </div>` : "";
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
        ${helperBadge}
      </div>

      <div class="task-card-footer">
        <div class="donation-tag" title="500円は全額子ども食堂へ寄付されます">
          <i class="fa-solid fa-heart"></i> 手渡し 500円
        </div>
        <button class="btn-help-accept" onclick="openTaskDetails('${task.id}')">
          詳細を見る / 助ける
        </button>
      </div>
      ${deleteButton}
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
  // 第14弾: 本人確認モーダル内の「LINE連携する」ボタン。連携のために移動する
  // 前に「本人確認に戻る」印を付け、既存の連携フロー（LIFF ログイン）を開始する
  const btnVerifyLineLink = document.getElementById("btnVerifyLineLink");
  if (btnVerifyLineLink) {
    btnVerifyLineLink.addEventListener("click", () => {
      markVerifyLinkPending();
      triggerLiffLoginAction();
    });
  }
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

    // 第14弾: 開くたびに連携状態に合わせて「LINE 連携が必要です」案内を出し直す
    updateVerifyLinkGateUI();

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

      // 第14弾: 本人確認は LINE 連携済みが前提。撮影開始時点でも止めているが、
      // 送信直前にも再確認し、未連携なら送らない（端末キーの申請はサーバー
      // でも 400 で断られる）。
      if (!isLineLinkedForVerify()) {
        updateVerifyLinkGateUI();
        const guideEl = document.getElementById("verifyLineLinkGuide");
        if (guideEl && guideEl.scrollIntoView) guideEl.scrollIntoView({ behavior: "smooth", block: "center" });
        showToast("ℹ️ 本人確認には LINE 連携が必要です。LINE連携を済ませてから申請してください。");
        return;
      }

      // 第14弾（第13弾の名前表示を実際に機能させるための担保）: 連携済みでも
      // 表示名がまだ読み込めていない場合は、プロフィールを再取得してから
      // 送る。再取得しても名前が取れない場合は送信を止める（そのまま送ると
      // 運営画面で「名前なしさん」になり、誰の申請か見分けられなくなる）。
      if (!getMyDisplayName()) {
        try {
          if (typeof liff !== "undefined" && liffReady && liff.isLoggedIn()) {
            await applyLineProfile();
          }
        } catch (e) {
          console.warn("LINE profile refetch error:", e);
        }
        if (!getMyDisplayName()) {
          showToast("ℹ️ LINEプロフィールを取得しています。数秒待ってから、もう一度ボタンを押してください。");
          return;
        }
      }

      const defaultBtnHtml = `<i class="fa-solid fa-cloud-arrow-up"></i> ${docName}で身元確認（eKYC認証実行）`;
      btnSubmitEkyc.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> 写真を送信しています...`;
      btnSubmitEkyc.style.pointerEvents = "none";

      const simResult = document.getElementById("verificationSimResult");
      const simResultTitle = document.getElementById("simResultTitle");
      const simResultText = document.getElementById("simResultText");

      // --- サーバーへ写真を送信する（運営者の目視確認を受ける） ---
      // 第14弾: 「サーバーが明示的に断った（400等）」場合と「サーバーへ届か
      // なかった」場合を区別するため、ステータスが取れる apiFetchRaw を使う
      // （第10弾と同じ方針）。断られたのに端末内だけで「認証完了」にして
      // しまう事故を防ぐためです。
      let submitted = false;
      let serverRejectMessage = "";
      try {
        const photoForReview = await shrinkImageToJpeg(frontImageData, 800);
        const res = await apiFetchRaw("/api/verify-requests", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userKey: getMyUserKey(),
            displayName: getMyDisplayName(),
            docType: selectedDocType,
            photoDataUrl: photoForReview
          })
        });
        if (res && res.ok) {
          submitted = true;
        } else if (res) {
          try {
            const j = await res.json();
            serverRejectMessage = (j && (j.message || j.error)) || "";
          } catch (e) {}
          if (!serverRejectMessage) serverRejectMessage = "サーバーが申請を受け付けませんでした。時間をおいてもう一度お試しください。";
        }
      } catch (e) {
        console.warn("⚠️ verify-request submit error:", e);
      }

      if (!submitted && serverRejectMessage) {
        // サーバーに明示的に断られた: 端末内フォールバック（認証完了扱い）には
        // 進まず、理由を利用者に表示する。写真は保持されるので直して再送できる
        if (simResultTitle) simResultTitle.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> 申請できませんでした`;
        if (simResultText) simResultText.textContent = serverRejectMessage;
        if (simResult) simResult.style.display = "block";
        btnSubmitEkyc.style.pointerEvents = "auto";
        btnSubmitEkyc.innerHTML = defaultBtnHtml;
        showToast("⚠️ " + serverRejectMessage);
        return;
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
        // 第12弾: 確認待ちになったので、承認/差し戻しの自動反映ポーリングを開始
        updateVerifyStatusPolling();

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

    <div id="modalActionArea"></div>
  `;

  // 第10弾: 自分の役割（投稿者 / 確定した手伝う人 / 第三者）に応じて
  // アクションボタンと場所の開示範囲を切り替える
  renderTaskDetailActions(task);
  openModal(taskDetailModal);
};

// 場所ボックスを「正確な住所が開示された」表示にする共通部品
function unlockedLocationHtml(task, heading) {
  return `
    <div style="font-weight: 800; color: var(--primary-hover); font-size: 1rem; margin-bottom: 0.4rem;">
      ${heading}
    </div>
    <div style="font-size: 1.1rem; font-weight: 900; color: #064e3b; background: white; padding: 0.75rem; border-radius: var(--radius-sm); border: 1px solid #6ee7b7;">
      🏡 正確な目的地: ${escapeHTML(task.exactLocation || '浜松市 登録住所')}
    </div>
    <div style="font-size: 0.8rem; color: var(--primary-hover); margin-top: 0.5rem; font-weight: 700;">
      <i class="fa-solid fa-shield-check"></i> 本人確認済み同士の安心マッチングです。下記のチャットボタンから連絡が可能です。
    </div>
  `;
}

// 投稿詳細のアクション領域を、自分の役割に応じて描く（第10弾）
// - 投稿者本人: チャットと完了ボタン（手伝う人の確定状況も表示）
// - 確定した手伝う人: チャット・完了・辞退ボタン、正確な住所を開示
// - 手伝う人が既に決まっている第三者: その旨の表示のみ（チャットは見せない）
// - それ以外の第三者: 「手伝います」ボタン（claim API を呼ぶ）
function renderTaskDetailActions(task) {
  const modalActionArea = document.getElementById("modalActionArea");
  if (!modalActionArea) return;
  const locationPrivacyBox = document.getElementById("locationPrivacyBox");
  const myKey = getMyUserKey();
  const isMine = !!task.requesterKey && task.requesterKey === myKey;
  const isHelper = !!task.helperKey && task.helperKey === myKey;

  const chatButton = `
    <button class="btn-hero-action" style="width: 100%; background: var(--info); color: white; margin-bottom: 0.75rem;" onclick="openChatModal('${task.id}')">
      <i class="fa-solid fa-comments"></i> 💬 メッセージでチャットする
    </button>`;
  const completeButton = `
    <button class="btn-hero-action" style="width: 100%; background: var(--secondary); color: white;" onclick="completeTaskAndDonate('${task.id}')">
      <i class="fa-solid fa-circle-check"></i> 作業完了！500円を受け取り子ども食堂へ寄付
    </button>`;

  if (isMine) {
    if (locationPrivacyBox) {
      locationPrivacyBox.style.background = "#d1fae5";
      locationPrivacyBox.innerHTML = unlockedLocationHtml(task, "📝 あなたの投稿です（正確な場所）");
    }
    const helperLine = task.helperKey
      ? `<div style="font-size: 0.9rem; font-weight: 700; color: var(--primary-hover); margin-bottom: 0.75rem;">🤝 手伝う人: ${escapeHTML(task.helperName || 'サポーター')} さんが確定しています</div>`
      : `<div style="font-size: 0.9rem; color: var(--text-muted); margin-bottom: 0.75rem;">手伝う人はまだ決まっていません。決まると、ここからやり取りができます。</div>`;
    modalActionArea.innerHTML = helperLine + chatButton + completeButton;
    return;
  }

  if (isHelper) {
    if (locationPrivacyBox) {
      locationPrivacyBox.style.background = "#d1fae5";
      locationPrivacyBox.innerHTML = unlockedLocationHtml(task, "🎉 マッチング成立！詳細住所が開示されました");
    }
    modalActionArea.innerHTML = chatButton + completeButton + `
      <button class="btn-hero-action" style="width: 100%; background: white; color: var(--text-muted); border: 1.5px solid var(--border);" onclick="releaseTaskHelper('${task.id}')">
        手伝うのを辞退する
      </button>`;
    return;
  }

  if (task.helperKey) {
    modalActionArea.innerHTML = `
      <div style="background: var(--bg-main); border: 1.5px solid var(--border); padding: 1rem; border-radius: var(--radius-md); font-size: 0.9rem; color: var(--text-muted); line-height: 1.6;">
        🤝 すでに手伝う人が決まっています（${escapeHTML(task.helperName || 'サポーター')} さん）。<br>
        やり取りは当事者だけが見られます。
      </div>`;
    return;
  }

  modalActionArea.innerHTML = `
    <button class="btn-hero-action" style="width: 100%; background: var(--primary); color: white;" onclick="acceptTaskMatch('${task.id}')">
      <i class="fa-solid fa-handshake-angle"></i> この困りごとを助ける（手伝います）
    </button>`;
}

// 「手伝います」の申し出: サーバーに手伝う人として確定してもらう（第10弾）
// サーバーに届かない（接続不可・サーバーに無い端末内だけの投稿）場合は、
// 従来どおり端末内だけでマッチング表示にして作業を止めない。
window.acceptTaskMatch = async function(taskId) {
  const task = tasksState.find(t => t.id === taskId);
  if (!task) return;

  const applyLocalMatch = () => {
    task.helperKey = getMyUserKey();
    task.helperName = getMyDisplayName();
    saveStoredTasks(tasksState);
    renderTasks();
    renderTaskDetailActions(task);
    showToast("🤝 マッチングが成立しました！チャット機能が解放されました。");
    updateFamilyLog(`【安心通知】サポーターとのマッチングが完了し、チャットでの事前連絡が開始されました。`);
  };

  try {
    const res = await apiFetchRaw(`/api/tasks/${taskId}/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userKey: getMyUserKey(), displayName: getMyDisplayName() })
    });
    if (res && res.ok) {
      const data = await res.json().catch(() => null);
      if (data && data.task) {
        Object.assign(task, data.task);
        saveStoredTasks(tasksState);
        renderTasks();
      } else {
        task.helperKey = getMyUserKey();
        task.helperName = getMyDisplayName();
      }
      renderTaskDetailActions(task);
      showToast("🤝 マッチングが成立しました！チャット機能が解放されました。");
      updateFamilyLog(`【安心通知】サポーターとのマッチングが完了し、チャットでの事前連絡が開始されました。`);
      return;
    }
    if (res && res.status === 409) {
      showToast("🤝 すでに手伝う人が決まっています");
      await fetchTasks();
      openTaskDetails(taskId);
      return;
    }
    if (res && res.status === 400) {
      showToast("自分の投稿には申し出できません");
      return;
    }
    applyLocalMatch();
  } catch (err) {
    console.warn("⚠️ API claim error:", err);
    applyLocalMatch();
  }
};

// 手伝う人の辞退: サーバーの確定を取り消す（第10弾）
window.releaseTaskHelper = async function(taskId) {
  const task = tasksState.find(t => t.id === taskId);
  if (!task) return;

  const applyLocalRelease = () => {
    task.helperKey = null;
    task.helperName = "";
    saveStoredTasks(tasksState);
    renderTasks();
    showToast("手伝う人を辞退しました");
    openTaskDetails(taskId);
  };

  try {
    const res = await apiFetchRaw(`/api/tasks/${taskId}/release`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userKey: getMyUserKey() })
    });
    if (res && res.ok) {
      const data = await res.json().catch(() => null);
      if (data && data.task) {
        Object.assign(task, data.task);
        saveStoredTasks(tasksState);
        renderTasks();
      } else {
        task.helperKey = null;
        task.helperName = "";
      }
      showToast("手伝う人を辞退しました");
      openTaskDetails(taskId);
      return;
    }
    if (res && res.status === 403) {
      showToast("取り消せるのは、確定した手伝う人だけです");
      return;
    }
    applyLocalRelease();
  } catch (err) {
    console.warn("⚠️ API release error:", err);
    applyLocalRelease();
  }
};

// Open LINE-Style Chat Modal with Real-Time Polling
window.openChatModal = function(taskId) {
  const task = tasksState.find(t => t.id === taskId);
  if (!task) return;

  currentChatTaskId = taskId;
  // 第10弾: 自分が投稿者の場合は、相手（手伝う人）の名前を出す
  const iAmRequester = !!task.requesterKey && task.requesterKey === getMyUserKey();
  const counterpartName = (iAmRequester && task.helperName) ? (task.helperName + " さん（手伝う人）") : (task.requesterName || "依頼者様");
  chatAvatar.textContent = (counterpartName || "浜").substring(0, 1);
  chatUserName.textContent = counterpartName;
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

  // 第10弾: 当事者でないタスクでは、履歴の代わりに案内を出す
  if (chatForbiddenTaskIds.has(currentChatTaskId)) {
    chatMessagesContainer.innerHTML = `
      <div style="text-align: center; color: var(--text-muted); font-size: 0.9rem; padding: 2rem 1rem; line-height: 1.7;">
        🔒 やり取りは当事者だけが見られます。<br>
        投稿した人と、手伝う人として確定した人だけがこの画面を開けます。
      </div>
    `;
    return;
  }

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
  // 第14弾: 本人確認は LINE 連携済みが前提。未連携の間は、ページ内カメラにも
  // カメラアプリ／ファイル選択にも進めず、連携の案内を出す（連携して戻って
  // くれば、そのまま撮影を続けられる）。
  if (!isLineLinkedForVerify()) {
    updateVerifyLinkGateUI();
    const guide = document.getElementById("verifyLineLinkGuide");
    if (guide && guide.scrollIntoView) guide.scrollIntoView({ behavior: "smooth", block: "center" });
    showToast("ℹ️ 本人確認には LINE 連携が必要です。まず「LINE連携する」ボタンから連携してください。");
    return;
  }
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
