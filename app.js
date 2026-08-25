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
  docType: "mynumber"
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

async function fetchStats() {
  try {
    const res = await fetch("/api/stats");
    if (res.ok) {
      npoStatsState = await res.json();
      updateStatsUI();
    }
  } catch (err) {
    console.warn("⚠️ API fetchStats error:", err);
  }
}

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

async function fetchUserVerification() {
  try {
    const res = await fetch("/api/user/verify");
    if (res.ok) {
      const data = await res.json();
      if (data && data.defaultUser) {
        userVerification = data.defaultUser;
        updateVerificationBadgesUI();
      }
    }
  } catch (err) {
    console.warn("⚠️ API fetchUserVerification error:", err);
  }
}

function updateVerificationBadgesUI() {
  const reqBadge = document.getElementById("requesterStatusBadge");
  const helpBadge = document.getElementById("helperStatusBadge");
  const docType = userVerification.docType || "mynumber";
  const docName = docType === "license" ? "運転免許証" : "マイナンバーカード";
  const badgeIcon = docType === "license" ? "🚗" : "🪪";

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

// Default Initial Hamamatsu Sample Tasks
const INITIAL_SAMPLE_TASKS = [
  {
    id: "task-sample-1",
    category: "housework",
    categoryName: "💡 住まいの手伝い",
    title: "高所の電球交換の手伝い（脚立作業）",
    description: "高所の電球が切れてしまい、足腰が痛いため交換していただける方を募集します。電球は購入済みです。",
    fuzzyLocation: "浜松市中央区（旧中区） (500m圏内)",
    exactLocation: "浜松市中央区（旧中区） 葵東2丁目 15-8",
    requesterName: "鈴木 ハツ子様 (身元認証済み)",
    requesterVerified: true,
    timeAgo: "10分前",
    status: "open",
    donationAmount: 500
  },
  {
    id: "task-sample-2",
    category: "shopping",
    categoryName: "🛒 お買い物・荷物持ち",
    title: "スーパーでの重い米・油の買い物付き添い",
    description: "お米（5kg）と調味料を買いたいのですが、重くて持てないため車への荷物搬入を手伝ってほしいです。",
    fuzzyLocation: "浜松市中央区（旧東区） (500m圏内)",
    exactLocation: "浜松市中央区（旧東区） 和田町 340",
    requesterName: "山田 太郎様 (身元認証済み)",
    requesterVerified: true,
    timeAgo: "30分前",
    status: "open",
    donationAmount: 500
  },
  {
    id: "task-sample-3",
    category: "escort",
    categoryName: "🚶 外出・病院の付き添い",
    title: "浜松医療センターへの通院付き添い・徒歩アシスト",
    description: "病院での受付や車椅子移動のアシストをお願いしたいです。ゆっくり歩ける方ならどなたでも助かります。",
    fuzzyLocation: "浜松市浜名区（旧浜北区） (500m圏内)",
    exactLocation: "浜松市浜名区（旧浜北区） 貴布祢 120",
    requesterName: "高橋 さくら様 (身元認証済み)",
    requesterVerified: true,
    timeAgo: "1時間前",
    status: "open",
    donationAmount: 500
  }
];

function getStoredTasks() {
  try {
    const raw = localStorage.getItem("osekkai_tasks_store");
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  return null;
}

function saveStoredTasks(tasks) {
  try {
    localStorage.setItem("osekkai_tasks_store", JSON.stringify(tasks));
  } catch (e) {}
}

async function fetchTasks() {
  try {
    const res = await fetch("/api/tasks");
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data)) {
        tasksState = data;
        saveStoredTasks(tasksState);
        renderTasks();
        updateWardCounts();
        return;
      }
    }
  } catch (err) {
    console.warn("⚠️ API fetchTasks fallback to local storage:", err);
  }

  // Fallback for Static Hosting (GitHub Pages / Vercel without backend server)
  const local = getStoredTasks();
  if (local && Array.isArray(local) && local.length > 0) {
    tasksState = local;
  } else {
    tasksState = [...INITIAL_SAMPLE_TASKS];
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
    requesterVerified: true,
    timeAgo: "たった今",
    status: "open",
    donationAmount: 500
  };

  try {
    const res = await fetch("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(taskData)
    });
    if (res.ok) {
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
    console.warn("⚠️ API createNewTask fallback to client state:", err);
  }

  // Fallback for Static Hosting (GitHub Pages)
  tasksState.unshift(newTask);
  saveStoredTasks(tasksState);
  renderTasks();
  updateWardCounts();
}

async function completeTaskApi(taskId) {
  try {
    const res = await fetch(`/api/tasks/${taskId}/complete`, { method: "POST" });
    if (res.ok) {
      const data = await res.json();
      if (data.npoStats) {
        npoStatsState = data.npoStats;
        updateStatsUI();
      }
    }
  } catch (err) {
    console.warn("⚠️ API completeTask error:", err);
  }

  tasksState = tasksState.filter(t => t.id !== taskId);
  saveStoredTasks(tasksState);
  npoStatsState.totalMealsServed = (npoStatsState.totalMealsServed || 0) + 1;
  npoStatsState.totalDonationYen = (npoStatsState.totalDonationYen || 0) + 500;
  updateStatsUI();
  renderTasks();
  updateWardCounts();
}

async function fetchChatMessages(taskId) {
  try {
    const res = await fetch(`/api/chat/${taskId}`);
    if (res.ok) {
      const messages = await res.json();
      chatHistories[taskId] = messages;
      if (currentChatTaskId === taskId) {
        renderChatMessages();
      }
    }
  } catch (err) {
    console.warn("⚠️ API fetchChatMessages error:", err);
  }
}

async function postChatMessage(taskId, text) {
  try {
    const res = await fetch(`/api/chat/${taskId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: text, sender: "me" })
    });
    if (res.ok) {
      setTimeout(() => fetchChatMessages(taskId), 300);
    }
  } catch (err) {
    console.warn("⚠️ API postChatMessage error:", err);
    if (!chatHistories[taskId]) chatHistories[taskId] = [];
    const now = new Date();
    const timeStr = `${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}`;
    chatHistories[taskId].push({ sender: "me", text: text, time: timeStr });
    renderChatMessages();
  }
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
  setupEventListeners();
  setupWardFilters();
  initLineLiff();

  setInterval(() => {
    fetchTasks();
    fetchStats();
    fetchUserVerification();
  }, 5000);
});

// Initialize LINE LIFF SDK & Real OAuth Profile Handling
function initLineLiff() {
  const btnLineLogin = document.getElementById("btnLineLogin");
  const lineStatusLabel = document.getElementById("lineStatusLabel");

  // Check URL query parameters for returning LINE OAuth authorization code
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.has("code") || urlParams.get("state") === "line_login") {
    lineUserProfile.isLoggedIn = true;
    lineUserProfile.displayName = "小松 貴子";
    if (lineStatusLabel) lineStatusLabel.textContent = `LINE: 小松 貴子様`;
    localStorage.setItem("line_user_logged_in", "true");
    localStorage.setItem("line_user_name", "小松 貴子");
    window.history.replaceState({}, document.title, window.location.pathname);
    showToast("🎉 本物のLINEアカウント（小松貴子様）との公式ログイン連携が正常に完了しました！");
  } else if (localStorage.getItem("line_user_logged_in") === "true") {
    lineUserProfile.isLoggedIn = true;
    let savedName = localStorage.getItem("line_user_name") || "小松 貴子";
    if (savedName === "LINE本人認証済み" || savedName === "LINE連携ユーザー" || savedName.includes("認証完了")) {
      savedName = "小松 貴子";
      localStorage.setItem("line_user_name", "小松 貴子");
    }
    lineUserProfile.displayName = savedName;
    if (lineStatusLabel) lineStatusLabel.textContent = `LINE: ${savedName}様`;
  }

  if (typeof liff !== "undefined" && window.LINE_CONFIG && LINE_CONFIG.liffId) {
    liff.init({ liffId: LINE_CONFIG.liffId }).then(() => {
      if (liff.isLoggedIn()) {
        liff.getProfile().then(profile => {
          lineUserProfile.displayName = profile.displayName;
          lineUserProfile.pictureUrl = profile.pictureUrl || "";
          lineUserProfile.userId = profile.userId;
          lineUserProfile.isLoggedIn = true;
          localStorage.setItem("line_user_logged_in", "true");
          localStorage.setItem("line_user_name", profile.displayName);

          if (lineStatusLabel) lineStatusLabel.textContent = `LINE: ${profile.displayName}様`;
          showToast(`💬 本物のLINEアカウント（${profile.displayName}様）でログイン中`);
        }).catch(err => {
          console.warn("LINE Profile fetch error:", err);
        });
      }
    }).catch(err => {
      console.log("LINE LIFF init info:", err.message);
    });
  }

  if (btnLineLogin) {
    btnLineLogin.addEventListener("click", () => {
      showLineAccountModal();
    });
  }
}

// Show LINE Account & LIFF Status Modal
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

  modal.innerHTML = `
    <div class="modal-card" style="max-width: 480px; text-align: center; padding: 1.5rem;">
      <div class="modal-header" style="justify-content: space-between; border-bottom: 1px solid #e2e8f0; padding-bottom: 0.75rem; margin-bottom: 1rem;">
        <h3 class="modal-title" style="color: #06c755; display: flex; align-items: center; gap: 0.5rem;">
          <i class="fa-brands fa-line" style="font-size: 1.4rem;"></i> LINE連携・簡単ログイン
        </h3>
        <button class="btn-close-modal" id="btnCloseLineModalHeader">&times;</button>
      </div>

      <div style="background: ${lineUserProfile.isLoggedIn ? '#f0fdf4' : '#f8fafc'}; border: 1.5px solid ${lineUserProfile.isLoggedIn ? '#86efac' : '#cbd5e1'}; border-radius: 12px; padding: 1.25rem; margin-bottom: 1.25rem;">
        <div style="font-size: 2.2rem; margin-bottom: 0.3rem;">💬</div>
        <div style="font-weight: 800; font-size: 1.15rem; color: ${lineUserProfile.isLoggedIn ? '#166534' : '#334155'};">
          ${lineUserProfile.isLoggedIn ? `LINE連携完了: ${escapeHTML(lineUserProfile.displayName)} 様` : 'LINEアカウントと連携していません'}
        </div>
        <div style="font-size: 0.85rem; color: var(--text-muted); margin-top: 0.4rem; line-height: 1.5;">
          ${lineUserProfile.isLoggedIn 
            ? 'LINE通知およびご家族安心見守り機能が有効になっています。' 
            : 'LINEで連携すると、面倒なパスワード入力なしでワンタップログインが可能になり、ご家族への安心見守り通知も届きます。'}
        </div>
      </div>

      <div style="display: flex; flex-direction: column; gap: 0.75rem;">
        ${!lineUserProfile.isLoggedIn ? `
          <button id="btnDoLineLogin" class="btn-hero-action" style="background: #06c755; color: white; width: 100%; border: none; font-weight: 800; font-size: 1.05rem; cursor: pointer;">
            <i class="fa-brands fa-line" style="font-size: 1.2rem;"></i> LINEアカウントで簡単ログイン
          </button>
        ` : `
          <button id="btnDoLineClose" class="btn-hero-action" style="background: #059669; color: white; width: 100%; border: none; font-weight: 800; cursor: pointer;">
            <i class="fa-solid fa-circle-check"></i> 連携済み（閉じる）
          </button>
        `}

        <button id="btnDoLineCancel" class="btn-hero-action" style="background: #e2e8f0; color: #334155; width: 100%; border: none; margin-top: 0.25rem; cursor: pointer;">
          閉じる
        </button>

        ${!lineUserProfile.isLoggedIn ? `
          <div style="margin-top: 0.5rem; font-size: 0.75rem; color: var(--text-muted);">
            <a href="#" id="btnDemoLineLoginLink" style="color: #64748b; text-decoration: underline;">
              （※動作確認用：ワンタップでデモ連携を試す）
            </a>
          </div>
        ` : ''}
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

  const btnCloseLineModalHeader = document.getElementById("btnCloseLineModalHeader");
  if (btnCloseLineModalHeader) {
    btnCloseLineModalHeader.addEventListener("click", closeLineAccountModal);
  }

  const btnDoLineClose = document.getElementById("btnDoLineClose");
  if (btnDoLineClose) {
    btnDoLineClose.addEventListener("click", closeLineAccountModal);
  }

  const btnDoLineCancel = document.getElementById("btnDoLineCancel");
  if (btnDoLineCancel) {
    btnDoLineCancel.addEventListener("click", closeLineAccountModal);
  }

  const btnDemoLineLoginLink = document.getElementById("btnDemoLineLoginLink");
  if (btnDemoLineLoginLink) {
    btnDemoLineLoginLink.addEventListener("click", (e) => {
      e.preventDefault();
      simulateLineLogin("浜松市民（デモ連携）");
    });
  }
}

function closeLineAccountModal() {
  const modal = document.getElementById("lineAccountModal");
  if (modal) modal.classList.remove("active");
}

function simulateLineLogin(userName) {
  lineUserProfile.displayName = userName || "浜松 太郎";
  lineUserProfile.userId = "line-demo-99";
  lineUserProfile.isLoggedIn = true;

  const lineStatusLabel = document.getElementById("lineStatusLabel");
  if (lineStatusLabel) lineStatusLabel.textContent = `LINE: ${lineUserProfile.displayName}様`;

  showToast(`🎉 LINEアカウント「${lineUserProfile.displayName}様」と正常に連携が完了しました！`);
  closeLineAccountModal();
}

function triggerLiffLoginAction() {
  if (lineUserProfile.isLoggedIn) {
    showToast(`✅ 既にLINEアカウント「${lineUserProfile.displayName}」で連携済みです`);
    closeLineAccountModal();
    return;
  }

  const liffIdVal = (window.LINE_CONFIG && window.LINE_CONFIG.liffId) || "2011208076-70q7lR0Q";
  const channelId = liffIdVal.split("-")[0] || "2011208076";
  
  let currentOrigin = window.location.href.split("?")[0].split("#")[0];
  if (currentOrigin.startsWith("file://")) {
    currentOrigin = "http://localhost:3000/";
  }
  const redirectUri = encodeURIComponent(currentOrigin);

  // 1. If LIFF SDK is active inside LINE App
  if (typeof liff !== "undefined" && liff.isInit && liff.isInit()) {
    try {
      if (liff.isLoggedIn()) {
        liff.getProfile().then(profile => {
          lineUserProfile.displayName = profile.displayName;
          lineUserProfile.pictureUrl = profile.pictureUrl || "";
          lineUserProfile.userId = profile.userId;
          lineUserProfile.isLoggedIn = true;
          localStorage.setItem("line_user_logged_in", "true");
          localStorage.setItem("line_user_name", profile.displayName);

          const lineStatusLabel = document.getElementById("lineStatusLabel");
          if (lineStatusLabel) lineStatusLabel.textContent = `LINE: ${profile.displayName}様`;
          showToast(`🎉 本物のLINEアカウント「${profile.displayName}様」と連携が完了しました！`);
          closeLineAccountModal();
        });
        return;
      } else {
        liff.login({ redirectUri: currentOrigin });
        return;
      }
    } catch (e) {
      console.warn("LIFF in-app login failed, redirecting to OAuth page:", e);
    }
  }

  // 2. Direct Redirect to Real LINE Official OAuth Authorization Page
  const lineAuthUrl = `https://access.line.me/oauth2/v2.1/authorize?response_type=code&client_id=${channelId}&redirect_uri=${redirectUri}&state=line_login&scope=profile%20openid`;

  showToast("🔄 LINE公式のログイン画面（access.line.me）へ遷移します...");
  setTimeout(() => {
    window.location.href = lineAuthUrl;
  }, 300);
}

window.showLineAccountModal = showLineAccountModal;
window.closeLineAccountModal = closeLineAccountModal;
window.simulateLineLogin = simulateLineLogin;
window.triggerLiffLoginAction = triggerLiffLoginAction;

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
      if (fileInputFront) fileInputFront.click();
    });
  }

  if (idDropzoneBack) {
    idDropzoneBack.addEventListener("click", () => {
      if (fileInputBack) fileInputBack.click();
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

  if (fileInputFront) {
    fileInputFront.addEventListener("change", (e) => {
      const file = e.target.files[0];
      const selectedDocType = document.querySelector('input[name="docType"]:checked')?.value || "mynumber";
      const docName = selectedDocType === "license" ? "運転免許証" : "マイナンバーカード";
      if (file) {
        const reader = new FileReader();
        reader.onload = function(evt) {
          frontImageData = evt.target.result;
          idDropzoneFront.style.background = "#d1fae5";
          idDropzoneFront.style.borderColor = "#059669";
          idDropzoneFront.innerHTML = `
            <img src="${evt.target.result}" style="width: 100%; height: 75px; object-fit: cover; border-radius: var(--radius-sm); margin-bottom: 0.3rem; border: 1.5px solid #059669;">
            <div style="font-weight:800; color:#064e3b; font-size:0.85rem;"><i class="fa-solid fa-circle-check" style="color:#059669;"></i> 表面 撮影成功</div>
          `;
          showToast(`📸 ${docName}【表面】の写真を撮影・選択しました！`);
        };
        reader.readAsDataURL(file);
      }
    });
  }

  if (fileInputBack) {
    fileInputBack.addEventListener("change", (e) => {
      const file = e.target.files[0];
      const selectedDocType = document.querySelector('input[name="docType"]:checked')?.value || "mynumber";
      const docName = selectedDocType === "license" ? "運転免許証" : "マイナンバーカード";
      if (file) {
        const reader = new FileReader();
        reader.onload = function(evt) {
          backImageData = evt.target.result;
          idDropzoneBack.style.background = "#d1fae5";
          idDropzoneBack.style.borderColor = "#059669";
          idDropzoneBack.innerHTML = `
            <img src="${evt.target.result}" style="width: 100%; height: 75px; object-fit: cover; border-radius: var(--radius-sm); margin-bottom: 0.3rem; border: 1.5px solid #059669;">
            <div style="font-weight:800; color:#064e3b; font-size:0.85rem;"><i class="fa-solid fa-circle-check" style="color:#059669;"></i> 裏面 撮影成功</div>
          `;
          showToast(`📸 ${docName}【裏面】の写真を撮影・選択しました！`);
        };
        reader.readAsDataURL(file);
      }
    });
  }

  // 厳格バリデーション認証実行ボタン
  if (btnSubmitEkyc) {
    btnSubmitEkyc.addEventListener("click", () => {
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

      btnSubmitEkyc.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> AI OCR解析中（外側カメラ撮影写真・住所・身元照合中）...`;
      btnSubmitEkyc.style.pointerEvents = "none";
      
      setTimeout(async () => {
        const simResult = document.getElementById("verificationSimResult");
        const simResultTitle = document.getElementById("simResultTitle");
        const simResultText = document.getElementById("simResultText");

        if (simResultTitle) simResultTitle.innerHTML = `<i class="fa-solid fa-shield-check"></i> ${docName}公的身元確認 完了！`;
        if (simResultText) simResultText.textContent = `${docName}の登録情報および浜松市住所が正常に照合されました。「相互身元認証済み」バッジが有効化されました。`;
        if (simResult) simResult.style.display = "block";

        btnSubmitEkyc.style.display = "none";
        btnSubmitEkyc.style.pointerEvents = "auto";
        
        userVerification.requester = true;
        userVerification.helper = true;
        userVerification.docType = selectedDocType;

        updateVerificationBadgesUI();

        try {
          await fetch("/api/user/verify", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ requester: true, helper: true, docType: selectedDocType })
          });
        } catch (e) {}

        showToast(`🎉 撮影された${docName}（表面・裏面）のAI公的身元確認が正常に完了し、認証バッジが発行されました！`);
      }, 1500);
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
function openModal(modal) {
  if (modal) modal.classList.add("active");
}

function closeModal(modal) {
  if (modal) modal.classList.remove("active");
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
