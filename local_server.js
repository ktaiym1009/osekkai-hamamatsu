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
    // ★ 本番（Vercel）では、デプロイ時の依存関係トレースが静的に読み取れる
    // 「文字列リテラルの require」でないとパッケージが同梱されず、実行時に
    // "Cannot find module '@vercel/blob'" になります（2026-11-11 に実発生）。
    // そのため本番パスは必ずリテラルで require してください。
    if (process.env.OSEKKAI_BLOB_MODULE_PATH) {
      blobClientCache = require(process.env.OSEKKAI_BLOB_MODULE_PATH);
    } else {
      blobClientCache = require('@vercel/blob');
    }
  } catch (err) {
    console.error('⚠️ @vercel/blob を読み込めませんでした。写真は従来方式（db.json）で保存します:', err.message);
    blobClientCache = null;
  }
  return blobClientCache;
}
function blobStorageEnabled() { return !!loadBlobClient(); }

// --- 共有データの Blob 復元（hydrate）の再読み込み制御（第9弾） ---
// 第5〜8弾の hydrate は「プロセス（= Vercel のサーバーインスタンス）ごとに
// 初回だけ Blob を読む」設計でした。そのため、あるインスタンスが読み込み
// 済みの状態で別インスタンスが新しいレコードを Blob へ書いても、既存
// インスタンスの一覧には永遠に反映されませんでした（2026-11-11 の本番
// 実機確認で、応答するインスタンスによって投稿一覧が食い違う問題として
// 顕在化。本人確認・ワンコインでは書き込み頻度が低く目立ちませんでした）。
// 第9弾では全ての hydrate に「TTL付き再読み込み」を導入します:
//   - コレクションごとに最終読み込み時刻を保持し、TTL を過ぎていたら
//     次回の呼び出しで list+get し直して取り込みます。
//   - 同時に複数リクエストが来ても再読み込みは1回に重ねます
//     （in-flight Promise の共有は維持します）。
//   - 取り込みは従来どおり「メモリ側を種に、Blob 側を正として同IDを
//     置き換えるマージ」なので、Blob の list にまだ現れていない自
//     インスタンスの新規レコードが再読み込みで消えることはありません。
//   - 読み込みに失敗した場合は最終読み込み時刻を更新しないため、次回の
//     呼び出しで再試行されます。
//   - options.force = true で TTL 内でも強制的に読み直します（完了API
//     のように、最新の状態を前提に書き込む経路で使います）。
// TTL は定数 HYDRATION_TTL_MS（既定15秒）。環境変数
// OSEKKAI_HYDRATION_TTL_MS（ミリ秒）で変更でき、テストでは 0（毎回
// 読み直す）や極小値を指定できます。他インスタンスの書き込みが一覧へ
// 伝わるまでの遅延は、最大で「TTL + Blob の list 反映遅延」程度です。
const HYDRATION_TTL_MS = (() => {
  const raw = process.env.OSEKKAI_HYDRATION_TTL_MS;
  if (raw === undefined || raw === '') return 15000;
  const n = Number(raw);
  return (Number.isFinite(n) && n >= 0) ? Math.floor(n) : 15000;
})();

// loadOnce(db, blob) は「1回分の list+get+マージ」を行い成否を boolean で
// 返す関数。それを TTL 付き再読み込みで包んだ hydrate 関数を作ります。
function createHydrationReloader(label, loadOnce) {
  let inFlight = null;
  let lastLoadedAt = 0;
  let lastOk = false;
  return function hydrate(db, options) {
    const blob = loadBlobClient();
    if (!blob) return Promise.resolve(false);
    if (inFlight) return inFlight;
    const force = !!(options && options.force);
    if (!force && lastLoadedAt > 0 && (Date.now() - lastLoadedAt) < HYDRATION_TTL_MS) {
      return Promise.resolve(lastOk);
    }
    inFlight = (async () => {
      try {
        const ok = await loadOnce(db, blob);
        if (ok) {
          lastLoadedAt = Date.now();
          lastOk = true;
        }
        return ok;
      } catch (err) {
        console.error('⚠️ Blob からのデータ復元に失敗しました:', label, err.message);
        return false;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };
}

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

// 申請者の表示名の検証（第13弾）。文字列のみを受け付け、前後の空白を除去し、
// 最大50文字に切り詰めます。空文字・未送信・文字列でない値は ''（名前なし）
// として扱います。名前は運営者確認画面での見分け専用で、利用者向けAPIには
// 一切含めません（publicVerifyRequest を参照）。
function sanitizeVerifyDisplayName(value) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, 50);
}

// 本人確認の新規申請に使える利用者キーかどうか（第14弾）。
// 利用者キーの生成はクライアント（app.js の getMyUserKey）が一元的に行い、
// LINE 連携済みなら "line:<LINEユーザーID>"、未連携なら
// "device:<端末ID>"（保存に失敗した場合は "device:ephemeral"）を返します。
// 本人確認は LINE アカウントに結び付けることが前提のため、新規申請では
// line: 形式で ID 部分が空でないキーだけを受け付けます。
// この判定は申請POSTの入口でのみ使い、既存レコードの読み取り・承認・
// 削除には一切影響させません。
function isLineUserKey(userKey) {
  return typeof userKey === 'string' && userKey.startsWith('line:') && userKey.length > 'line:'.length;
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
    const got = await blob.get(record.photoBlobPathname, { access: 'private', token: process.env.BLOB_READ_WRITE_TOKEN });
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
// 残っている申請を復元するため）。読み込みのタイミングは第9弾の TTL
// 付き再読み込み（createHydrationReloader）が制御し、別インスタンスが
// 書いた申請も最大で TTL 程度の遅延で取り込まれます。
async function loadVerifyRequestsOnceFromBlob(db, blob) {
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
        const got = await blob.get(pathname, { access: 'private', token: process.env.BLOB_READ_WRITE_TOKEN });
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
    return false;
  }
}
const hydrateVerifyRequestsFromBlob = createHydrationReloader('verify-requests', loadVerifyRequestsOnceFromBlob);

// --- ワンコイン寄付（第6弾）: 受け取り記録・寄付記録の Blob 永続化 ---
// 本人確認（verify-requests）と同じ方式で、レコード1件ごとにメタデータJSONを
// 非公開（private）で Blob に保存します:
//   coin-payments/<記録ID>/meta.json  … ワンコイン受け取り記録
//   donations/<記録ID>/meta.json      … 子ども食堂への寄付記録
// Blob が使えない環境（ローカル・テスト）では db.json / インメモリのみで
// 動作します（従来モード）。コールドスタート時は Blob から復元します。
const COIN_BLOB_PREFIX = 'coin-payments/';
const DONATION_BLOB_PREFIX = 'donations/';

function coinMetaPathname(id) { return COIN_BLOB_PREFIX + id + '/meta.json'; }
function donationMetaPathname(id) { return DONATION_BLOB_PREFIX + id + '/meta.json'; }

async function putRecordMetaToBlob(pathname, record) {
  const blob = loadBlobClient();
  if (!blob) throw new Error('blob storage is not available');
  await blob.put(pathname, JSON.stringify(record), {
    access: 'private',
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true,
    token: process.env.BLOB_READ_WRITE_TOKEN
  });
}

// verify-requests の hydrateVerifyRequestsFromBlob と同じ考え方で、
// 指定プレフィックス配下の meta.json 群を db の配列フィールドへ復元する。
// Blob 側を正として同IDのメモリ側レコードを置き換えます。読み込みの
// タイミングは第9弾の TTL 付き再読み込みが制御します（フィールドごとに
// リローダーを保持し、prefix はフィールドに対して固定です）。
const collectionHydrationReloaders = {};
function hydrateCollectionFromBlob(db, field, prefix, options) {
  if (!collectionHydrationReloaders[field]) {
    collectionHydrationReloaders[field] = createHydrationReloader(field, async (db, blob) => {
      try {
        const pathnames = [];
        let cursor = undefined;
        do {
          const listed = await blob.list({
            prefix: prefix,
            limit: 1000,
            cursor: cursor,
            token: process.env.BLOB_READ_WRITE_TOKEN
          });
          for (const b of (listed.blobs || [])) {
            if (b.pathname && b.pathname.endsWith('/meta.json')) pathnames.push(b.pathname);
          }
          cursor = listed.hasMore ? listed.cursor : undefined;
        } while (cursor);
        const byId = new Map();
        for (const r of (db[field] || [])) byId.set(r.id, r);
        for (const pathname of pathnames) {
          try {
            const got = await blob.get(pathname, { access: 'private', token: process.env.BLOB_READ_WRITE_TOKEN });
            if (!got || !got.stream) continue;
            const meta = JSON.parse(await new Response(got.stream).text());
            if (meta && meta.id) byId.set(meta.id, meta);
          } catch (err) {
            console.error('⚠️ Blob のメタデータ読み込みに失敗（読み飛ばします）:', pathname, err.message);
          }
        }
        db[field] = [...byId.values()];
        return true;
      } catch (err) {
        console.error('⚠️ Blob からのデータ復元に失敗しました:', field, err.message);
        return false;
      }
    });
  }
  return collectionHydrationReloaders[field](db, options);
}

// 金額（円）の検証: 1〜1,000,000 の整数のみ。不正なら null。
function parseYenAmount(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = (typeof value === 'number') ? value : Number(String(value).trim());
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 1000000) return null;
  return n;
}

// --- 投稿（タスク）とチャットメッセージの共有化（第7弾・A方式） ---
// ロードマップ②: タスクとチャットを端末ごと（localStorage 中心）から
// サーバー側へ集約し、違うスマホ同士でも同じ投稿・同じ会話が見られるように
// します。方式は本人確認・ワンコインで実績のある「Vercel Blob 非公開保存＋
// 起動時復元」の拡張で、新しい外部サービスは導入しません。
// Blob 上の配置（レコード1件ごとに1ファイル、access: 'private'）:
//   tasks/<タスクID>.json                          … タスク1件
//   task-messages/<タスクID>/<メッセージID>.json   … チャットメッセージ1件
// Blob が使えない環境（ローカル・テスト）では従来どおり db.json /
// インメモリで動作します。書き込みは「先に Blob、失敗したら受け付けない」
// という既存機能と同じ方針で、中途半端な状態を作りません。
// 注意（A方式の既知の制限）: サーバーレスの複数インスタンスが同時に
// 書き込むと競合しうるため、同時書き込みへの耐性はベストエフォートです。
// 人数が増えたら専用データベース（B方式）へ移行する前提で、レコードは
// 1件ずつの素直な JSON にしてあります（移行しやすさのため）。
const TASK_BLOB_PREFIX = 'tasks/';
const CHAT_BLOB_PREFIX = 'task-messages/';

function taskBlobPathname(id) { return TASK_BLOB_PREFIX + id + '.json'; }
function chatMessageBlobPathname(taskId, msgId) { return CHAT_BLOB_PREFIX + taskId + '/' + msgId + '.json'; }

// API レスポンス用に、内部の保存情報（storage / blobPathname）を除いた
// タスクを返す。それ以外の項目はそのまま通す（前方互換のため）。
function publicTask(t) {
  if (!t) return null;
  const view = { ...t };
  delete view.storage;
  delete view.blobPathname;
  return view;
}

// --- チャットの当事者制限（第10弾） ---
// 第7弾でチャットを共有化した結果、投稿を開いた人なら誰でも履歴の閲覧・
// 送信ができる状態になっていました。住所や電話番号の打ち合わせをする場
// として危険なため、第10弾で「投稿者（requesterKey）と、確定した手伝う人
// （helperKey）だけが読み書きできる」ように制限します。
// 方針:
//   - userKey は必須。GET はクエリ、POST/claim/release は body で受けます。
//     無い場合は 400、当事者でない場合は 403、タスク自体が無い場合は 404。
//   - requesterKey が null の旧タスク（第7弾より前の互換データ）は、投稿者
//     本人を特定できないため「誰も投稿者にはなれない」扱いで安全側に倒し
//     ます（手伝う人が claim すれば、その人だけが当事者になります）。
//   - 正直な限界: userKey はクライアント申告制（LIFF の利用者ID / 端末ID）
//     で、強い本人認証ではありません。他人のキーを知れば成りすませてしま
//     います。それでも「誰でも見られる」状態からは大きく改善します。
//     本格的な認証強化は B方式（専用データベース＋認証基盤）移行時の課題
//     です（詳細は REPORT.md 第10弾）。
function getChatPartyRole(task, userKey) {
  if (!task || !userKey) return null;
  if (task.requesterKey && task.requesterKey === userKey) return 'requester';
  if (task.helperKey && task.helperKey === userKey) return 'helper';
  return null;
}

// タスクを ID で探す。見つからない場合は TTL 内の未取り込みの可能性が
// あるため、強制再読み込みしてもう一度探す（第9弾の review/confirm と
// 同じ方針）。それでも無ければ null。
async function findTaskWithReload(db, taskId) {
  let task = (db.tasks || []).find(t => t.id === taskId);
  if (!task) {
    await hydrateTasksFromBlob(db, { force: true });
    task = (db.tasks || []).find(t => t.id === taskId);
  }
  return task || null;
}

// タスクの変更（claim / release など）を保存する。Blob 保存のタスクは
// 先に Blob 側を更新し、失敗したら例外を投げる（メモリ側は変えない。
// 完了APIと同じ方針）。
async function persistTaskUpdate(task, updated) {
  if (loadBlobClient() && updated.storage === 'blob') {
    await putRecordMetaToBlob(updated.blobPathname || taskBlobPathname(updated.id), updated);
  }
  Object.assign(task, updated);
}

// タスク本体とそのタスクのチャットを、Blob とメモリの両方から削除する
// （第17弾で共通化。管理者削除＝第10弾 4.8 と、投稿者本人の削除＝第17弾
// 4.65 が同じ中身を使う）。
// 統計の扱いは管理者削除の判断（第10弾）をそのまま踏襲します: 削除後は
// 「残った完了済みタスクからの再導出」を正として統計を再計算し、保存
// します。第8弾の復元フォールバック（保存値と導出値の大きい方）は
// 「事故からの自動修復」のための仕組みで、意図的な削除には適用しません
// （適用すると、消したはずの完了分が数字だけ復活してしまいます）。
// 保存の順序: 先に再計算後の統計を Blob へ保存し、次にチャットとタスクの
// Blob を削除し、最後にメモリへ反映します。Blob 操作が失敗したら例外を
// 投げ、メモリは一切変えません（呼び出し側は 500 を返します）。
async function deleteTaskWithChats(db, task) {
  const remaining = (db.tasks || []).filter(t => t.id !== task.id);
  const derived = deriveStatsFromTasks({ tasks: remaining });
  const newStats = {
    ...db.npoStats,
    totalMealsServed: derived.totalMealsServed,
    totalDonationYen: derived.totalDonationYen
  };
  const blob = loadBlobClient();
  if (blob) {
    await putStatsToBlob(newStats);
    // チャットメッセージの Blob を削除する
    const msgPrefix = CHAT_BLOB_PREFIX + task.id + '/';
    const pathnames = [];
    let cursor = undefined;
    do {
      const listed = await blob.list({
        prefix: msgPrefix,
        limit: 1000,
        cursor: cursor,
        token: process.env.BLOB_READ_WRITE_TOKEN
      });
      for (const b of (listed.blobs || [])) {
        if (b.pathname) pathnames.push(b.pathname);
      }
      cursor = listed.hasMore ? listed.cursor : undefined;
    } while (cursor);
    if (pathnames.length > 0) {
      await blob.del(pathnames, { token: process.env.BLOB_READ_WRITE_TOKEN });
    }
    await blob.del(task.blobPathname || taskBlobPathname(task.id), { token: process.env.BLOB_READ_WRITE_TOKEN });
  }
  db.tasks = remaining;
  if (db.chatStore) delete db.chatStore[task.id];
  db.npoStats = newStats;
  return newStats;
}

// タスクの並び順キー（新しい順）。createdAt が無い旧レコードは、ID に
// 埋め込まれた作成時刻（task-<ミリ秒>-...）で代用する。
function taskSortKey(t) {
  if (t && t.createdAt) return String(t.createdAt);
  const m = /^task-(\d+)/.exec((t && t.id) || '');
  if (m) {
    try { return new Date(Number(m[1])).toISOString(); } catch (e) {}
  }
  return '';
}

// Blob 上の tasks/<id>.json 群を db.tasks に取り込む（コールドスタート対策）。
// Blob 側を正として同IDのメモリ側レコードを置き換え、新しい順に並べ替える。
// 読み込みのタイミングは第9弾の TTL 付き再読み込みが制御します。
async function loadTasksOnceFromBlob(db, blob) {
  try {
    const pathnames = [];
    let cursor = undefined;
    do {
      const listed = await blob.list({
        prefix: TASK_BLOB_PREFIX,
        limit: 1000,
        cursor: cursor,
        token: process.env.BLOB_READ_WRITE_TOKEN
      });
      for (const b of (listed.blobs || [])) {
        if (b.pathname && b.pathname.endsWith('.json') && !b.pathname.endsWith('/meta.json')) pathnames.push(b.pathname);
      }
      cursor = listed.hasMore ? listed.cursor : undefined;
    } while (cursor);
    const byId = new Map();
    for (const t of (db.tasks || [])) byId.set(t.id, t);
    for (const pathname of pathnames) {
      try {
        const got = await blob.get(pathname, { access: 'private', token: process.env.BLOB_READ_WRITE_TOKEN });
        if (!got || !got.stream) continue;
        const rec = JSON.parse(await new Response(got.stream).text());
        if (rec && rec.id) byId.set(rec.id, rec);
      } catch (err) {
        console.error('⚠️ Blob のタスク読み込みに失敗（読み飛ばします）:', pathname, err.message);
      }
    }
    db.tasks = [...byId.values()].sort((a, b) => taskSortKey(b).localeCompare(taskSortKey(a)));
    return true;
  } catch (err) {
    console.error('⚠️ Blob からのタスク復元に失敗しました:', err.message);
    return false;
  }
}
const hydrateTasksFromBlob = createHydrationReloader('tasks', loadTasksOnceFromBlob);

// Blob 上の task-messages/<タスクID>/<メッセージID>.json 群を
// db.chatStore に取り込む（コールドスタート対策）。メッセージIDで重複を
// 除き、Blob 側を正として置き換え、createdAt の古い順に並べる。
// ID の無い旧レコード（db.json 由来）は先頭にそのまま残す。
// 読み込みのタイミングは第9弾の TTL 付き再読み込みが制御します。
async function loadChatMessagesOnceFromBlob(db, blob) {
  try {
    const pathnames = [];
    let cursor = undefined;
    do {
      const listed = await blob.list({
        prefix: CHAT_BLOB_PREFIX,
        limit: 1000,
        cursor: cursor,
        token: process.env.BLOB_READ_WRITE_TOKEN
      });
      for (const b of (listed.blobs || [])) {
        if (b.pathname && b.pathname.endsWith('.json')) pathnames.push(b.pathname);
      }
      cursor = listed.hasMore ? listed.cursor : undefined;
    } while (cursor);
    const fromBlob = {}; // taskId -> messages[]
    for (const pathname of pathnames) {
      try {
        const got = await blob.get(pathname, { access: 'private', token: process.env.BLOB_READ_WRITE_TOKEN });
        if (!got || !got.stream) continue;
        const msg = JSON.parse(await new Response(got.stream).text());
        const parts = pathname.split('/');
        const taskId = (msg && msg.taskId) || parts[1];
        if (!msg || !taskId || !msg.id) continue;
        (fromBlob[taskId] = fromBlob[taskId] || []).push(msg);
      } catch (err) {
        console.error('⚠️ Blob のチャットメッセージ読み込みに失敗（読み飛ばします）:', pathname, err.message);
      }
    }
    db.chatStore = db.chatStore || {};
    for (const taskId of Object.keys(fromBlob)) {
      const existing = db.chatStore[taskId] || [];
      const legacy = existing.filter(m => !m || !m.id);
      const byId = new Map();
      for (const m of existing) if (m && m.id) byId.set(m.id, m);
      for (const m of fromBlob[taskId]) byId.set(m.id, m);
      const merged = [...byId.values()].sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
      db.chatStore[taskId] = [...legacy, ...merged];
    }
    return true;
  } catch (err) {
    console.error('⚠️ Blob からのチャット復元に失敗しました:', err.message);
    return false;
  }
}
const hydrateChatMessagesFromBlob = createHydrationReloader('task-messages', loadChatMessagesOnceFromBlob);

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
  verificationRequests: [],
  // ワンコイン受け取り記録（第6弾）。手伝った人が「500円を受け取った」ことを
  // 記録し、運営が受け取り確認（現金/振込）をすると handed_over になります。
  // 各要素: { id, userKey, displayName, amount, memo, taskId,
  //           status: 'held'|'handed_over', createdAt, handedOverAt, handoverMethod }
  coinPayments: [],
  // 子ども食堂への寄付記録（第6弾）。運営だけが登録できます。
  // 各要素: { id, amount, recipient, donatedAt, note, createdAt }
  donations: []
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
  if (!Array.isArray(db.coinPayments)) db.coinPayments = [];
  if (!Array.isArray(db.donations)) db.donations = [];
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

// --- 実績カウンター（統計 npoStats）の Blob 永続化（第8弾） ---
// npoStats は従来 db.json / インメモリだけに保持され、Vercel のコールド
// スタートで初期値（全て0）に戻ってしまう制限がありました（タスク・チャット
// 自体は第7弾で復元されるのに、実績の数字だけが消える状態）。第8弾で
// 本人確認・ワンコイン・タスクと同じ「Vercel Blob 非公開保存＋復元」方式を
// 統計にも広げます:
//   stats/global.json … 統計オブジェクト全体を1ファイルで保存（access: 'private'）
// 復元時の値の決め方:
//   - 保存済みの値を原則として正とします。特にタスクから導出できない
//     supportedCafeterias / registeredSupporters は保存値だけが根拠です。
//   - タスクから導出できる2項目（totalMealsServed = 完了タスク数、
//     totalDonationYen = 完了タスクの donationAmount 合計）は、保存値と
//     導出値の「大きい方」を採用します。第8弾より前に完了したタスク
//     （統計が未保存のまま Blob に残っている分）の取りこぼしや、完了時の
//     書き込みが途中で失敗した場合の不整合を、次のコールドスタートで
//     自動修復するためです（カウンターは増えるだけで減らない前提）。
//   - 保存済み統計が無い／壊れている場合は導出値で再構築し、ベスト
//     エフォートで Blob に書き戻します（修復。以後の起動は保存値から
//     復元できます。書き戻しに失敗しても応答は止めません）。
// Blob が使えない環境では従来どおり db.json / インメモリで動作します。
const STATS_BLOB_PATHNAME = 'stats/global.json';
const STATS_DERIVABLE_KEYS = ['totalMealsServed', 'totalDonationYen'];

function isValidStatValue(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

// 永続化済みタスクから導出できる統計（完了タスク基準）。
// donationAmount が無い／不正なタスクは従来の加算額に合わせて 500円とする。
function deriveStatsFromTasks(db) {
  let meals = 0;
  let yen = 0;
  for (const t of (db.tasks || [])) {
    if (t && t.status === 'completed') {
      meals += 1;
      yen += (typeof t.donationAmount === 'number' && Number.isFinite(t.donationAmount) && t.donationAmount > 0) ? t.donationAmount : 500;
    }
  }
  return { totalMealsServed: meals, totalDonationYen: yen };
}

async function putStatsToBlob(stats) {
  // putRecordMetaToBlob は Blob が無い環境では例外を投げる（呼び出し側で判定）
  await putRecordMetaToBlob(STATS_BLOB_PATHNAME, stats);
}

// Blob 上の stats/global.json を db.npoStats に取り込む（コールドスタート
// 対策）。読み込みのタイミングは第9弾の TTL 付き再読み込みが制御します。
// 導出にはタスクの復元が先に必要です（内側で hydrateTasksFromBlob を
// 呼びます。そちらも TTL 制御下にあります）。
// 統計の整合について（第9弾の判断）: 導出できる2項目は「保存値と導出値の
// 大きい方」を採るため、TTL 内の古い読みでも加算が巻き戻ることはありま
// せん。それでも完了APIでは、加算の前提を最新に揃えるため force で強制
// 再読み込みしてから加算します（エンドポイント側のコメント参照）。
async function loadStatsOnceFromBlob(db, blob) {
  try {
    await hydrateTasksFromBlob(db);
    let saved = null;
    try {
      const got = await blob.get(STATS_BLOB_PATHNAME, { access: 'private', token: process.env.BLOB_READ_WRITE_TOKEN });
      if (got && got.stream) {
        const parsed = JSON.parse(await new Response(got.stream).text());
        if (parsed && typeof parsed === 'object') saved = parsed;
      }
    } catch (err) {
      console.error('⚠️ Blob の統計データ読み込みに失敗しました（導出値で再構築します）:', err.message);
    }
    const derived = deriveStatsFromTasks(db);
    const current = (db.npoStats && typeof db.npoStats === 'object') ? db.npoStats : {};
    const merged = {};
    for (const key of Object.keys(SEED_DB.npoStats)) {
      const savedVal = saved ? saved[key] : undefined;
      if (STATS_DERIVABLE_KEYS.indexOf(key) !== -1) {
        const d = derived[key] || 0;
        merged[key] = isValidStatValue(savedVal) ? Math.max(savedVal, d) : d;
      } else {
        merged[key] = isValidStatValue(savedVal) ? savedVal
          : (isValidStatValue(current[key]) ? current[key] : SEED_DB.npoStats[key]);
      }
    }
    db.npoStats = merged;
    const savedComplete = !!saved && Object.keys(SEED_DB.npoStats).every(k => isValidStatValue(saved[k]));
    if (!savedComplete) {
      // 保存済み統計が無い／不完全な場合は、再構築した値を書き戻して
      // おきます（ベストエフォート。失敗しても次回また導出できます）。
      try {
        await putStatsToBlob(merged);
      } catch (err) {
        console.error('⚠️ Blob への統計データの修復保存に失敗しました:', err.message);
      }
    }
    return true;
  } catch (err) {
    console.error('⚠️ Blob からの統計データ復元に失敗しました:', err.message);
    return false;
  }
}
const hydrateStatsFromBlob = createHydrationReloader('stats', loadStatsOnceFromBlob);

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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
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
    // 第8弾: コールドスタート後は Blob に保存した統計を復元してから返す
    // （復元できない環境では従来どおり db.json / メモリの値を返す）
    await hydrateStatsFromBlob(db);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
    res.end(JSON.stringify(db.npoStats || {}));
    return;
  }

  // 2. GET /api/tasks
  if (pathname === '/api/tasks' && req.method === 'GET') {
    const db = loadDB();
    // 第7弾: 共有タスクを Blob から復元してから一覧を作る（他端末の投稿も含む）
    await hydrateTasksFromBlob(db);
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
    res.end(JSON.stringify(filtered.map(publicTask)));
    return;
  }

  // 3. POST /api/tasks
  if (pathname === '/api/tasks' && req.method === 'POST') {
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
        if (!data.title || !String(data.title).trim() || !data.description || !String(data.description).trim()) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=UTF-8' });
          res.end(JSON.stringify({ error: "title and description are required" }));
          return;
        }
        const db = loadDB();
        await hydrateTasksFromBlob(db);
        // 第7弾: 投稿者情報（表示名・利用者キー）が送られてきた場合は保持し、
        // 共有先の端末でも「誰の投稿か」が分かるようにする。未指定の場合は
        // 従来の既定表示名を使う（従来の呼び出し方との互換を保つ）。
        const requesterName = String(data.requesterName || '').trim().slice(0, 100);
        const newTask = {
          id: "task-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8),
          category: data.category || "housework",
          categoryName: data.categoryName || "💡 住まいの手伝い",
          title: data.title,
          description: data.description,
          fuzzyLocation: `${data.area || '浜松市'}（約500m圏内）`,
          exactLocation: `${data.area || '浜松市'} 登録住所`,
          requesterName: requesterName || "あなた (浜松市民・本人確認済み)",
          requesterKey: data.userKey ? String(data.userKey).trim().slice(0, 128) : null,
          // 第10弾: マッチング状態をサーバー側に持たせる。手伝う人が
          // 確定したら helperKey / helperName に入り、チャットの閲覧・
          // 送信は投稿者とこの手伝う人だけに制限される。
          helperKey: null,
          helperName: '',
          requesterVerified: true,
          timeAgo: "たった今",
          status: "open",
          donationAmount: 500,
          createdAt: new Date().toISOString()
        };

        // 第7弾: Blob が使える環境では先にタスクを保存する（失敗したら
        // 受け付けない。本人確認・ワンコインと同じ方針）。
        if (loadBlobClient()) {
          newTask.storage = 'blob';
          newTask.blobPathname = taskBlobPathname(newTask.id);
          try {
            await putRecordMetaToBlob(newTask.blobPathname, newTask);
          } catch (err) {
            console.error('⚠️ Blob へのタスク保存に失敗しました:', err.message);
            res.writeHead(500, { 'Content-Type': 'application/json; charset=UTF-8' });
            res.end(JSON.stringify({ error: "failed to store task" }));
            return;
          }
        }

        db.tasks = db.tasks || [];
        db.tasks.unshift(newTask);
        saveDB(db);

        res.writeHead(201, { 'Content-Type': 'application/json; charset=UTF-8' });
        res.end(JSON.stringify({ success: true, task: publicTask(newTask) }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=UTF-8' });
        res.end(JSON.stringify({ error: "Internal Server Error" }));
      }
    });
    return;
  }

  // 4. POST /api/tasks/:id/complete
  if (pathname.startsWith('/api/tasks/') && pathname.endsWith('/complete') && req.method === 'POST') {
    const parts = pathname.split('/');
    const taskId = parts[3];
    const db = loadDB();
    // 第9弾: 完了判定と統計加算は「最新の状態」が前提のため、TTL 内でも
    // 強制的に読み直してから処理する（他インスタンスが書いたタスクが
    // 見つからない、統計の加算が古い値から始まって実績を上書きする、
    // といった事故を防ぐ）。
    await hydrateTasksFromBlob(db, { force: true });
    // 第8弾: 統計も復元してから加算する（復元前の初期値に加算して保存すると
    // それまでの実績を上書きで消してしまうため）
    await hydrateStatsFromBlob(db, { force: true });

    // Only count the donation when the task transitions from open to
    // completed, so repeated or unknown completions never inflate the
    // counters (idempotent).
    // 第7弾: 完了はレコードの削除ではなく status: 'completed' への遷移として
    // 記録し、Blob にも反映します。削除方式だと Blob 側に残ったレコードが
    // コールドスタート時に「未完了」として復活してしまうためで、完了の
    // 履歴が残ることで将来のデータ移行もしやすくなります。一覧APIは
    // status === 'open' のみを返すため、完了した募集は表示されません。
    const task = (db.tasks || []).find(t => t.id === taskId);
    const transitioned = !!(task && task.status !== 'completed');
    if (transitioned) {
      const updated = { ...task, status: 'completed', completedAt: new Date().toISOString() };
      // Blob 保存のタスクは、先に Blob 側を更新してからメモリ側に反映する
      // （失敗したら 500 で、状態も統計も変えない）
      if (loadBlobClient() && updated.storage === 'blob') {
        try {
          await putRecordMetaToBlob(updated.blobPathname || taskBlobPathname(updated.id), updated);
        } catch (err) {
          console.error('⚠️ Blob へのタスク完了の保存に失敗しました:', err.message);
          res.writeHead(500, { 'Content-Type': 'application/json; charset=UTF-8' });
          res.end(JSON.stringify({ error: "failed to store completion" }));
          return;
        }
      }
      // 第8弾: 加算後の統計を、メモリへ反映する前に Blob へ先行保存する
      // （タスク本体の保存と同じ「失敗したら 500 で、状態も統計も変えない」
      // 方針）。タスク側だけが Blob に残って統計の保存に失敗した場合は、
      // 次回のコールドスタート時に「導出値との大きい方」を採る復元
      // （hydrateStatsFromBlob）が不整合を自動修復します。
      const newStats = {
        ...db.npoStats,
        totalMealsServed: db.npoStats.totalMealsServed + 1,
        totalDonationYen: db.npoStats.totalDonationYen + 500
      };
      if (loadBlobClient()) {
        try {
          await putStatsToBlob(newStats);
        } catch (err) {
          console.error('⚠️ Blob への統計保存に失敗しました:', err.message);
          res.writeHead(500, { 'Content-Type': 'application/json; charset=UTF-8' });
          res.end(JSON.stringify({ error: "failed to store stats" }));
          return;
        }
      }
      Object.assign(task, updated);
      db.npoStats = newStats;
      saveDB(db);
    }

    res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
    res.end(JSON.stringify({ success: true, completed: transitioned, npoStats: db.npoStats }));
    return;
  }

  // 4.5 POST /api/tasks/:id/claim （第10弾: 手伝う人の確定）
  // 「手伝います」と申し出た人を、そのタスクの手伝う人としてサーバー側に
  // 確定します。確定した人だけが投稿者とチャットできるようになります。
  if (pathname.startsWith('/api/tasks/') && pathname.endsWith('/claim') && req.method === 'POST') {
    const taskId = pathname.split('/')[3];
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
        if (!userKey) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=UTF-8' });
          res.end(JSON.stringify({ error: "userKey is required" }));
          return;
        }
        const db = loadDB();
        await hydrateTasksFromBlob(db);
        const task = await findTaskWithReload(db, taskId);
        if (!task) {
          res.writeHead(404, { 'Content-Type': 'application/json; charset=UTF-8' });
          res.end(JSON.stringify({ error: "task not found" }));
          return;
        }
        if (task.status === 'completed') {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=UTF-8' });
          res.end(JSON.stringify({ error: "task is already completed" }));
          return;
        }
        // 投稿者本人は自分の投稿の手伝う人にはなれない
        if (task.requesterKey && task.requesterKey === userKey) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=UTF-8' });
          res.end(JSON.stringify({ error: "requester cannot claim own task" }));
          return;
        }
        if (task.helperKey) {
          if (task.helperKey === userKey) {
            // 自分が既に確定済みなら、そのまま現在の状態を返す（冪等）
            res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
            res.end(JSON.stringify({ success: true, task: publicTask(task) }));
            return;
          }
          res.writeHead(409, { 'Content-Type': 'application/json; charset=UTF-8' });
          res.end(JSON.stringify({ error: "task already has a helper" }));
          return;
        }
        const updated = {
          ...task,
          helperKey: userKey,
          helperName: String(data.displayName || '').trim().slice(0, 100)
        };
        try {
          await persistTaskUpdate(task, updated);
        } catch (err) {
          console.error('⚠️ Blob への手伝う人確定の保存に失敗しました:', err.message);
          res.writeHead(500, { 'Content-Type': 'application/json; charset=UTF-8' });
          res.end(JSON.stringify({ error: "failed to store claim" }));
          return;
        }
        saveDB(db);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
        res.end(JSON.stringify({ success: true, task: publicTask(task) }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=UTF-8' });
        res.end(JSON.stringify({ error: "Internal Server Error" }));
      }
    });
    return;
  }

  // 4.6 POST /api/tasks/:id/release （第10弾: 手伝う人の取り消し）
  // 確定した手伝う人本人が、確定を取り消して枠を空に戻します。
  if (pathname.startsWith('/api/tasks/') && pathname.endsWith('/release') && req.method === 'POST') {
    const taskId = pathname.split('/')[3];
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
        if (!userKey) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=UTF-8' });
          res.end(JSON.stringify({ error: "userKey is required" }));
          return;
        }
        const db = loadDB();
        await hydrateTasksFromBlob(db);
        const task = await findTaskWithReload(db, taskId);
        if (!task) {
          res.writeHead(404, { 'Content-Type': 'application/json; charset=UTF-8' });
          res.end(JSON.stringify({ error: "task not found" }));
          return;
        }
        if (!task.helperKey) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=UTF-8' });
          res.end(JSON.stringify({ error: "task has no helper to release" }));
          return;
        }
        if (task.helperKey !== userKey) {
          res.writeHead(403, { 'Content-Type': 'application/json; charset=UTF-8' });
          res.end(JSON.stringify({ error: "only the confirmed helper can release" }));
          return;
        }
        const updated = { ...task, helperKey: null, helperName: '' };
        try {
          await persistTaskUpdate(task, updated);
        } catch (err) {
          console.error('⚠️ Blob への手伝う人取り消しの保存に失敗しました:', err.message);
          res.writeHead(500, { 'Content-Type': 'application/json; charset=UTF-8' });
          res.end(JSON.stringify({ error: "failed to store release" }));
          return;
        }
        saveDB(db);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
        res.end(JSON.stringify({ success: true, task: publicTask(task) }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=UTF-8' });
        res.end(JSON.stringify({ error: "Internal Server Error" }));
      }
    });
    return;
  }

  // 4.65 POST /api/tasks/:id/delete （第17弾: 投稿者本人による投稿の削除）
  // 投稿者本人が、自分の投稿を取り下げられるようにします。これまで削除は
  // 運営者の管理削除（4.8）しか無く、共有化より前に端末内だけで作った
  // テスト投稿などが本人の画面に残り続けていました。
  // 所有権の検証: body の userKey が、そのタスクの requesterKey と一致する
  // 場合だけ削除します。不一致は 403、タスクが無い場合は 404、userKey が
  // 無い場合は 400 です。requesterKey が null の旧タスク（第7弾より前）は
  // 所有者を証明できないため 403 とし、削除は運営者の管理削除に委ねます。
  // 正直な限界: userKey はクライアント申告制（第10弾のチャット制限と同じ）
  // で、強い本人認証ではありません。他人のキーを知れば成りすませてしまい
  // ますが、「誰でも消せる」状態にはせず、サーバー側で必ず照合します。
  // 削除の中身（タスク本体＋そのタスクのチャットを Blob / メモリから消し、
  // 統計を残ったタスクから再導出する）は管理者削除と共通の
  // deleteTaskWithChats を使います。募集中の投稿はもともと統計に数え
  // られていないため、通常この再計算で数字は変わりません。
  if (pathname.startsWith('/api/tasks/') && pathname.endsWith('/delete') && req.method === 'POST') {
    const taskId = pathname.split('/')[3];
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
        if (!userKey) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=UTF-8' });
          res.end(JSON.stringify({ error: "userKey is required" }));
          return;
        }
        const db = loadDB();
        await hydrateTasksFromBlob(db);
        await hydrateChatMessagesFromBlob(db);
        // 統計のうち導出できない2項目（supportedCafeterias 等）を古い
        // メモリ値で潰さないよう、再計算の前に統計も最新化しておく
        // （管理者削除と同じ順序）
        await hydrateStatsFromBlob(db, { force: true });
        const task = await findTaskWithReload(db, taskId);
        if (!task) {
          res.writeHead(404, { 'Content-Type': 'application/json; charset=UTF-8' });
          res.end(JSON.stringify({ error: "task not found" }));
          return;
        }
        if (!task.requesterKey || task.requesterKey !== userKey) {
          res.writeHead(403, { 'Content-Type': 'application/json; charset=UTF-8' });
          res.end(JSON.stringify({ error: "only the requester can delete this task" }));
          return;
        }
        try {
          await deleteTaskWithChats(db, task);
        } catch (err) {
          console.error('⚠️ Blob からの投稿削除に失敗しました:', err.message);
          res.writeHead(500, { 'Content-Type': 'application/json; charset=UTF-8' });
          res.end(JSON.stringify({ error: "failed to delete task" }));
          return;
        }
        saveDB(db);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=UTF-8' });
        res.end(JSON.stringify({ error: "Internal Server Error" }));
      }
    });
    return;
  }

  // 4.7 GET /api/admin/tasks （第10弾: 運営者: 投稿の一覧。パスコード必須）
  // 公開の一覧APIは募集中（open）のみ返すため、完了済みを含む全件を
  // 運営画面（削除・訂正用）に返す専用の一覧を用意します。
  if (pathname === '/api/admin/tasks' && req.method === 'GET') {
    if (!hasAdminPasscode(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ error: "admin passcode required" }));
      return;
    }
    const db = loadDB();
    await hydrateTasksFromBlob(db);
    const list = (db.tasks || []).map(publicTask);
    list.sort((a, b) => taskSortKey(b).localeCompare(taskSortKey(a)));
    res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
    res.end(JSON.stringify(list));
    return;
  }

  // 4.8 DELETE /api/admin/tasks/:id （第10弾: 運営者: 投稿の削除。パスコード必須）
  // テスト投稿などの掃除用です。タスク本体と、そのタスクのチャット
  // メッセージを Blob / メモリの両方から削除します。
  // 統計の扱い（第10弾の判断）: 削除後は「残った完了済みタスクからの
  // 再導出」を正として統計を再計算し、保存します。第8弾の復元フォール
  // バック（保存値と導出値の大きい方）は「事故からの自動修復」のための
  // 仕組みで、管理者が意図的にデータを消す操作には適用しません（適用
  // すると、消したはずのテスト完了分が数字だけ復活してしまいます）。
  // 保存の順序: 先に再計算後の統計を Blob へ保存し、次にチャットと
  // タスクの Blob を削除し、最後にメモリへ反映します。途中で失敗した
  // 場合はメモリを変えず、次回の復元（大きい方ルール）が実態に合わせて
  // 自動修復します。
  if (pathname.startsWith('/api/admin/tasks/') && req.method === 'DELETE') {
    if (!hasAdminPasscode(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ error: "admin passcode required" }));
      return;
    }
    const taskId = pathname.split('/')[4];
    try {
      const db = loadDB();
      await hydrateTasksFromBlob(db);
      await hydrateChatMessagesFromBlob(db);
      // 統計のうち導出できない2項目（supportedCafeterias 等）を古い
      // メモリ値で潰さないよう、再計算の前に統計も最新化しておく
      await hydrateStatsFromBlob(db, { force: true });
      const task = await findTaskWithReload(db, taskId);
      if (!task) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=UTF-8' });
        res.end(JSON.stringify({ error: "task not found" }));
        return;
      }
      // 削除の実処理（統計の再計算・Blob 削除・メモリ反映）は第17弾で
      // 共通化した deleteTaskWithChats を使う（投稿者本人の削除と同一の
      // 中身・同一の順序）。Blob 側で失敗したらメモリは変えず 500。
      let newStats;
      try {
        newStats = await deleteTaskWithChats(db, task);
      } catch (err) {
        console.error('⚠️ Blob からのタスク削除に失敗しました:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json; charset=UTF-8' });
        res.end(JSON.stringify({ error: "failed to delete task" }));
        return;
      }
      saveDB(db);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ success: true, npoStats: db.npoStats }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ error: "Internal Server Error" }));
    }
    return;
  }

  // 5. GET /api/chat/:id （第10弾: 当事者だけが閲覧可）
  // userKey（クエリ必須）が、そのタスクの投稿者または確定した手伝う人と
  // 一致する場合だけ履歴を返します。方針の詳細は getChatPartyRole の
  // コメント（第10弾）を参照してください。
  if (pathname.startsWith('/api/chat/') && req.method === 'GET') {
    const taskId = pathname.split('/')[3];
    const userKey = String(parsedUrl.searchParams.get('userKey') || '').trim().slice(0, 128);
    if (!userKey) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ error: "userKey is required" }));
      return;
    }
    const db = loadDB();
    await hydrateTasksFromBlob(db);
    // 第7弾: Blob から復元し、当事者の端末では同じ履歴が見えるようにする
    await hydrateChatMessagesFromBlob(db);
    const task = await findTaskWithReload(db, taskId);
    if (!task) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ error: "task not found" }));
      return;
    }
    if (!getChatPartyRole(task, userKey)) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ error: "chat is only visible to the requester and the confirmed helper" }));
      return;
    }
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
        // 第10弾: 送信も当事者だけに制限する（GET と同じ方針）
        const userKey = String(data.userKey || data.senderKey || '').trim().slice(0, 128);
        if (!userKey) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=UTF-8' });
          res.end(JSON.stringify({ error: "userKey is required" }));
          return;
        }
        const db = loadDB();
        await hydrateTasksFromBlob(db);
        await hydrateChatMessagesFromBlob(db);
        const task = await findTaskWithReload(db, taskId);
        if (!task) {
          res.writeHead(404, { 'Content-Type': 'application/json; charset=UTF-8' });
          res.end(JSON.stringify({ error: "task not found" }));
          return;
        }
        if (!getChatPartyRole(task, userKey)) {
          res.writeHead(403, { 'Content-Type': 'application/json; charset=UTF-8' });
          res.end(JSON.stringify({ error: "chat is only visible to the requester and the confirmed helper" }));
          return;
        }
        db.chatStore = db.chatStore || {};
        if (!db.chatStore[taskId]) db.chatStore[taskId] = [];

        const now = new Date();
        const timeStr = `${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}`;

        // 第7弾: メッセージには ID・作成日時・送信者の利用者キー（senderKey）と
        // 表示名を持たせます。従来の sender（'me'/'them'）は「送った端末から
        // 見た相対表記」で、他人の端末では自分と相手が逆になってしまうため、
        // クライアントは senderKey と自分のキーを比べて表示側を決め直します
        // （senderKey が無い旧メッセージは従来どおり sender を使います）。
        const userMsg = {
          id: "msg-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8),
          taskId: taskId,
          sender: data.sender || "me",
          senderKey: (data.userKey || data.senderKey) ? String(data.userKey || data.senderKey).trim().slice(0, 128) : null,
          senderName: String(data.displayName || data.senderName || '').trim().slice(0, 100),
          text: data.text,
          time: timeStr,
          createdAt: now.toISOString()
        };

        // 第7弾: Blob が使える環境では先にメッセージを保存する（失敗したら
        // 受け付けない。本人確認・ワンコインと同じ方針）。
        if (loadBlobClient()) {
          try {
            await putRecordMetaToBlob(chatMessageBlobPathname(taskId, userMsg.id), userMsg);
          } catch (err) {
            console.error('⚠️ Blob へのチャットメッセージ保存に失敗しました:', err.message);
            res.writeHead(500, { 'Content-Type': 'application/json; charset=UTF-8' });
            res.end(JSON.stringify({ error: "failed to store message" }));
            return;
          }
        }
        db.chatStore[taskId].push(userMsg);

        // 第10弾: 自動返信は廃止しました。決まった文句の返信が本物の
        // 相手の返事に見えて紛らわしい、と実機確認で指摘されたためです。
        // 過去に生成された自動返信（senderKey: 'system:auto-reply'）は
        // 履歴に残りますが、今後は新規に生成しません。

        saveDB(db);

        res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
        res.end(JSON.stringify({ success: true, message: userMsg }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=UTF-8' });
        res.end(JSON.stringify({ error: "Internal Server Error" }));
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
  // 申請者の表示名（displayName）も第13弾から同じ扱いにし、運営者用の
  // 一覧API（パスコード必須）でのみ返します。利用者向けの応答には、
  // 本人の申請であっても名前を含めません。
  function publicVerifyRequest(r) {
    if (!r) return null;
    return {
      id: r.id,
      userKey: r.userKey,
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
        // 第14弾: 本人確認の新規申請は、LINE 連携済み（line: 形式のキー）の
        // 利用者だけが送れます。端末キー等の申請を受け付けてしまうと、その
        // 承認が LINE アカウント側の申請として見つけられず、「Chromeでは
        // 認証済みなのに LINE から開くと未承認」という事故になるため、
        // 理由が分かるメッセージ付きで 400 で断ります。既存レコードの
        // 読み取り・承認・削除はこの制限の対象外です。
        if (!isLineUserKey(userKey)) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=UTF-8' });
          res.end(JSON.stringify({
            error: 'line_required',
            message: '本人確認の申請にはLINE連携が必要です。LINE連携を済ませてから、もう一度申請してください。'
          }));
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
          displayName: sanitizeVerifyDisplayName(data.displayName),
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
        let target = (db.verificationRequests || []).find(r => r.id === requestId);
        if (!target) {
          // 第9弾: 別インスタンスが書いた申請が TTL 内でまだ取り込まれて
          // いない可能性があるため、見つからない場合だけ強制再読み込み
          // してもう一度探す（本当に存在しない申請はそのまま 404）。
          await hydrateVerifyRequestsFromBlob(db, { force: true });
          target = (db.verificationRequests || []).find(r => r.id === requestId);
        }
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

  // 12.5 DELETE /api/admin/verify-requests/:id （第11弾: 運営者: 本人確認申請の削除。パスコード必須）
  // 不要になった申請（テスト申請・確認が済んで保管不要になった申請など）の
  // 掃除用です。申請レコードと、Blob に保存した写真・メタデータを削除します。
  // 削除の意味論は第10弾の運営削除と同じです:
  //   - 先に Blob を削除し、失敗したら 500 でメモリは一切変更しません。
  //   - 削除した申請は Blob にもメモリにも残らないため、再起動後の復元
  //     （ハイドレーション）で復活することはありません。
  // 認証状態の扱い: 利用者の認証状態は「その利用者の最新申請の status」
  // から導出されます（GET /api/verify-requests/mine）。そのため申請を
  // 消せば導出結果は自動で追随します。既存の userVerifications（バッジ
  // 表示用・全体で1つ）については、確認API（#12）の差し戻し時と同じ
  // 考え方で、削除した申請がその利用者の最新だった場合だけ、残った
  // 最新申請から再導出して整合させます（最新でない申請の削除では、
  // 現在の認証状態は変わらないため触れません）。
  if (pathname.startsWith('/api/admin/verify-requests/') && req.method === 'DELETE') {
    if (!hasAdminPasscode(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ error: "admin passcode required" }));
      return;
    }
    const requestId = pathname.split('/')[4];
    try {
      const db = loadDB();
      await hydrateVerifyRequestsFromBlob(db);
      let target = (db.verificationRequests || []).find(r => r.id === requestId);
      if (!target) {
        // 第9弾: 別インスタンスが書いた申請が TTL 内でまだ取り込まれて
        // いない可能性があるため、見つからない場合だけ強制再読み込み
        // してもう一度探す（本当に存在しない申請はそのまま 404）。
        await hydrateVerifyRequestsFromBlob(db, { force: true });
        target = (db.verificationRequests || []).find(r => r.id === requestId);
      }
      if (!target) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=UTF-8' });
        res.end(JSON.stringify({ error: "request not found" }));
        return;
      }
      // 削除対象が、その利用者の最新申請かどうか（認証状態の再導出が要るか）
      const latestBefore = findLatestVerifyRequest(db, target.userKey);
      const wasLatest = !!(latestBefore && latestBefore.id === target.id);

      const blob = loadBlobClient();
      if (blob) {
        try {
          // verify-requests/<申請ID>/ 配下（写真バイナリと meta.json）を
          // まとめて削除する。レコードに残っているパス名も合算し、
          // list の反映遅延で写真だけ取りこぼすことがないようにする。
          const pathnames = new Set();
          if (target.photoBlobPathname) pathnames.add(target.photoBlobPathname);
          if (target.photoMetaBlobPathname) pathnames.add(target.photoMetaBlobPathname);
          const prefix = VERIFY_BLOB_PREFIX + target.id + '/';
          let cursor = undefined;
          do {
            const listed = await blob.list({
              prefix: prefix,
              limit: 1000,
              cursor: cursor,
              token: process.env.BLOB_READ_WRITE_TOKEN
            });
            for (const b of (listed.blobs || [])) {
              if (b.pathname) pathnames.add(b.pathname);
            }
            cursor = listed.hasMore ? listed.cursor : undefined;
          } while (cursor);
          if (pathnames.size > 0) {
            await blob.del([...pathnames], { token: process.env.BLOB_READ_WRITE_TOKEN });
          }
        } catch (err) {
          console.error('⚠️ Blob からの本人確認申請の削除に失敗しました:', err.message);
          res.writeHead(500, { 'Content-Type': 'application/json; charset=UTF-8' });
          res.end(JSON.stringify({ error: "failed to delete verify request" }));
          return;
        }
      }

      db.verificationRequests = (db.verificationRequests || []).filter(r => r.id !== requestId);

      // 認証状態の整合（上記コメント参照）: 削除した申請が利用者の最新
      // だった場合だけ、残った最新申請から userVerifications を再導出する。
      // 承認済みの最新申請を消した場合は未認証に戻り、過去の承認済み申請が
      // 残っていればその認証が引き続き有効になります。
      if (wasLatest) {
        const remaining = findLatestVerifyRequest(db, target.userKey);
        db.userVerifications = db.userVerifications || {};
        if (remaining && remaining.status === 'approved') {
          db.userVerifications.defaultUser = { requester: true, helper: true, verifiedAt: remaining.reviewedAt };
        } else {
          db.userVerifications.defaultUser = { requester: false, helper: false, verifiedAt: undefined };
        }
      }
      saveDB(db);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ success: true }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ error: "Internal Server Error" }));
    }
    return;
  }

  // === ワンコイン寄付（第6弾） ===
  // 助け合いのお礼500円の流れを記録します:
  //   利用者（手伝った人）が受け取りを記録（status: 'held' = 預かり中）
  //   → 運営が台帳で受け取りを確認（status: 'handed_over'、方法は現金/振込）
  //   → 運営が子ども食堂へ寄付した分を寄付記録として登録
  //   → 寄付累計は公開サマリーAPIで誰でも見られます（個人名は含みません）。
  function publicCoinPayment(r) {
    if (!r) return null;
    return {
      id: r.id,
      userKey: r.userKey,
      displayName: r.displayName,
      amount: r.amount,
      memo: r.memo || '',
      taskId: r.taskId || null,
      status: r.status,
      createdAt: r.createdAt,
      handedOverAt: r.handedOverAt || null,
      handoverMethod: r.handoverMethod || null
    };
  }

  function publicDonation(d) {
    if (!d) return null;
    return {
      id: d.id,
      amount: d.amount,
      recipient: d.recipient,
      donatedAt: d.donatedAt,
      note: d.note || '',
      createdAt: d.createdAt
    };
  }

  function computeDonationSummary(db) {
    let totalHandedOver = 0;
    let currentlyHeld = 0;
    let totalReceived = 0;
    for (const c of (db.coinPayments || [])) {
      const amt = (typeof c.amount === 'number') ? c.amount : 0;
      totalReceived += amt;
      if (c.status === 'handed_over') totalHandedOver += amt;
      else currentlyHeld += amt;
    }
    let totalDonated = 0;
    for (const d of (db.donations || [])) {
      totalDonated += (typeof d.amount === 'number') ? d.amount : 0;
    }
    return {
      totalDonated: totalDonated,
      donationCount: (db.donations || []).length,
      totalHandedOver: totalHandedOver,
      currentlyHeld: currentlyHeld,
      totalReceived: totalReceived,
      // 運営の手元に集まっていて、まだ寄付していない合計
      awaitingDonation: Math.max(0, totalHandedOver - totalDonated)
    };
  }

  // 13. POST /api/coin-payments （利用者: ワンコインの受け取りを記録する）
  if (pathname === '/api/coin-payments' && req.method === 'POST') {
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
        if (!userKey) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=UTF-8' });
          res.end(JSON.stringify({ error: "userKey is required" }));
          return;
        }
        // 金額は原則500円。指定がある場合だけ検証して使う（1〜1,000,000円の整数）
        let amount = 500;
        if (data.amount !== undefined && data.amount !== null && data.amount !== '') {
          amount = parseYenAmount(data.amount);
          if (amount === null) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=UTF-8' });
            res.end(JSON.stringify({ error: "amount must be an integer between 1 and 1000000" }));
            return;
          }
        }
        const db = loadDB();
        db.coinPayments = db.coinPayments || [];
        const record = {
          id: "coin-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8),
          userKey: userKey,
          displayName: String(data.displayName || '').trim().slice(0, 100),
          amount: amount,
          memo: String(data.memo || '').trim().slice(0, 500),
          taskId: data.taskId ? String(data.taskId).trim().slice(0, 128) : null,
          status: 'held',
          createdAt: new Date().toISOString(),
          handedOverAt: null,
          handoverMethod: null
        };

        // Blob が使える環境では先にメタデータを保存する（失敗したら受け付けない。
        // 本人確認の写真申請と同じ「中途半端な状態を作らない」方針）。
        if (loadBlobClient()) {
          record.storage = 'blob';
          record.metaBlobPathname = coinMetaPathname(record.id);
          try {
            await putRecordMetaToBlob(record.metaBlobPathname, record);
          } catch (err) {
            console.error('⚠️ Blob へのワンコイン記録の保存に失敗しました:', err.message);
            res.writeHead(500, { 'Content-Type': 'application/json; charset=UTF-8' });
            res.end(JSON.stringify({ error: "failed to store coin payment" }));
            return;
          }
        }

        db.coinPayments.push(record);
        saveDB(db);
        res.writeHead(201, { 'Content-Type': 'application/json; charset=UTF-8' });
        res.end(JSON.stringify({ success: true, payment: publicCoinPayment(record) }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=UTF-8' });
        res.end(JSON.stringify({ error: "Internal Server Error" }));
      }
    });
    return;
  }

  // 14. GET /api/coin-payments/mine?userKey=... （利用者: 自分の受け取り記録）
  if (pathname === '/api/coin-payments/mine' && req.method === 'GET') {
    const db = loadDB();
    await hydrateCollectionFromBlob(db, 'coinPayments', COIN_BLOB_PREFIX);
    const userKey = String(parsedUrl.searchParams.get('userKey') || '').trim().slice(0, 128);
    const list = userKey
      ? (db.coinPayments || []).filter(c => c.userKey === userKey).map(publicCoinPayment)
      : [];
    list.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
    res.end(JSON.stringify({ payments: list }));
    return;
  }

  // 15. GET /api/admin/coin-payments （運営者: 台帳一覧。パスコード必須）
  if (pathname === '/api/admin/coin-payments' && req.method === 'GET') {
    if (!hasAdminPasscode(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ error: "admin passcode required" }));
      return;
    }
    const db = loadDB();
    await hydrateCollectionFromBlob(db, 'coinPayments', COIN_BLOB_PREFIX);
    const list = (db.coinPayments || []).map(publicCoinPayment);
    list.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
    res.end(JSON.stringify(list));
    return;
  }

  // 16. POST /api/admin/coin-payments/:id/confirm （運営者: 受け取り確認。パスコード必須）
  if (pathname.startsWith('/api/admin/coin-payments/') && pathname.endsWith('/confirm') && req.method === 'POST') {
    if (!hasAdminPasscode(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ error: "admin passcode required" }));
      return;
    }
    const paymentId = pathname.split('/')[4];
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
        const method = data.method;
        if (method !== 'cash' && method !== 'transfer') {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=UTF-8' });
          res.end(JSON.stringify({ error: "method must be 'cash' or 'transfer'" }));
          return;
        }
        const db = loadDB();
        await hydrateCollectionFromBlob(db, 'coinPayments', COIN_BLOB_PREFIX);
        let target = (db.coinPayments || []).find(c => c.id === paymentId);
        if (!target) {
          // 第9弾: 別インスタンスが書いた記録が TTL 内でまだ取り込まれて
          // いない可能性があるため、見つからない場合だけ強制再読み込み
          // してもう一度探す（本当に存在しない記録はそのまま 404）。
          await hydrateCollectionFromBlob(db, 'coinPayments', COIN_BLOB_PREFIX, { force: true });
          target = (db.coinPayments || []).find(c => c.id === paymentId);
        }
        if (!target) {
          res.writeHead(404, { 'Content-Type': 'application/json; charset=UTF-8' });
          res.end(JSON.stringify({ error: "payment not found" }));
          return;
        }
        // 既に確認済みの場合は、そのまま現在の状態を返す（二重確認で状態を壊さない）
        if (target.status === 'handed_over') {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
          res.end(JSON.stringify({ success: true, alreadyConfirmed: true, payment: publicCoinPayment(target) }));
          return;
        }
        const updated = {
          ...target,
          status: 'handed_over',
          handedOverAt: new Date().toISOString(),
          handoverMethod: method
        };
        // Blob 保存の記録は、先に Blob 側を更新してからメモリ側に反映する
        if (loadBlobClient() && updated.storage === 'blob' && updated.metaBlobPathname) {
          try {
            await putRecordMetaToBlob(updated.metaBlobPathname, updated);
          } catch (err) {
            console.error('⚠️ Blob への受け取り確認の保存に失敗しました:', err.message);
            res.writeHead(500, { 'Content-Type': 'application/json; charset=UTF-8' });
            res.end(JSON.stringify({ error: "failed to store confirmation" }));
            return;
          }
        }
        Object.assign(target, updated);
        saveDB(db);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
        res.end(JSON.stringify({ success: true, payment: publicCoinPayment(target) }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=UTF-8' });
        res.end(JSON.stringify({ error: "Internal Server Error" }));
      }
    });
    return;
  }

  // 16.5 DELETE /api/admin/coin-payments/:id （第10弾: 運営者: ワンコイン記録の削除。パスコード必須）
  // テスト記録などの掃除・誤記録の訂正用です。Blob とメモリの両方から
  // 削除します（公開サマリーは記録の配列から都度計算されるため、削除
  // すれば集計にも自動で反映されます）。
  if (pathname.startsWith('/api/admin/coin-payments/') && req.method === 'DELETE') {
    if (!hasAdminPasscode(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ error: "admin passcode required" }));
      return;
    }
    const paymentId = pathname.split('/')[4];
    try {
      const db = loadDB();
      await hydrateCollectionFromBlob(db, 'coinPayments', COIN_BLOB_PREFIX);
      let target = (db.coinPayments || []).find(c => c.id === paymentId);
      if (!target) {
        await hydrateCollectionFromBlob(db, 'coinPayments', COIN_BLOB_PREFIX, { force: true });
        target = (db.coinPayments || []).find(c => c.id === paymentId);
      }
      if (!target) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=UTF-8' });
        res.end(JSON.stringify({ error: "payment not found" }));
        return;
      }
      const blob = loadBlobClient();
      if (blob && target.storage === 'blob') {
        try {
          await blob.del(target.metaBlobPathname || coinMetaPathname(target.id), { token: process.env.BLOB_READ_WRITE_TOKEN });
        } catch (err) {
          console.error('⚠️ Blob からのワンコイン記録の削除に失敗しました:', err.message);
          res.writeHead(500, { 'Content-Type': 'application/json; charset=UTF-8' });
          res.end(JSON.stringify({ error: "failed to delete coin payment" }));
          return;
        }
      }
      db.coinPayments = (db.coinPayments || []).filter(c => c.id !== paymentId);
      saveDB(db);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ success: true }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ error: "Internal Server Error" }));
    }
    return;
  }

  // 17. POST /api/admin/donations （運営者: 寄付の登録。パスコード必須）
  if (pathname === '/api/admin/donations' && req.method === 'POST') {
    if (!hasAdminPasscode(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ error: "admin passcode required" }));
      return;
    }
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
        const amount = parseYenAmount(data.amount);
        if (amount === null) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=UTF-8' });
          res.end(JSON.stringify({ error: "amount must be an integer between 1 and 1000000" }));
          return;
        }
        const recipient = String(data.recipient || '').trim().slice(0, 200);
        if (!recipient) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=UTF-8' });
          res.end(JSON.stringify({ error: "recipient is required" }));
          return;
        }
        // 寄付日は任意。指定があれば日付として解釈できること（不正なら400）
        let donatedAt = new Date().toISOString();
        if (data.donatedAt !== undefined && data.donatedAt !== null && String(data.donatedAt).trim() !== '') {
          const parsed = new Date(String(data.donatedAt).trim());
          if (isNaN(parsed.getTime())) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=UTF-8' });
            res.end(JSON.stringify({ error: "donatedAt must be a valid date" }));
            return;
          }
          donatedAt = parsed.toISOString();
        }
        const db = loadDB();
        db.donations = db.donations || [];
        const record = {
          id: "don-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8),
          amount: amount,
          recipient: recipient,
          donatedAt: donatedAt,
          note: String(data.note || '').trim().slice(0, 500),
          createdAt: new Date().toISOString()
        };
        if (loadBlobClient()) {
          record.storage = 'blob';
          record.metaBlobPathname = donationMetaPathname(record.id);
          try {
            await putRecordMetaToBlob(record.metaBlobPathname, record);
          } catch (err) {
            console.error('⚠️ Blob への寄付記録の保存に失敗しました:', err.message);
            res.writeHead(500, { 'Content-Type': 'application/json; charset=UTF-8' });
            res.end(JSON.stringify({ error: "failed to store donation" }));
            return;
          }
        }
        db.donations.push(record);
        saveDB(db);
        res.writeHead(201, { 'Content-Type': 'application/json; charset=UTF-8' });
        res.end(JSON.stringify({ success: true, donation: publicDonation(record) }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=UTF-8' });
        res.end(JSON.stringify({ error: "Internal Server Error" }));
      }
    });
    return;
  }

  // 18. GET /api/admin/donations （運営者: 寄付履歴。パスコード必須）
  if (pathname === '/api/admin/donations' && req.method === 'GET') {
    if (!hasAdminPasscode(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ error: "admin passcode required" }));
      return;
    }
    const db = loadDB();
    await hydrateCollectionFromBlob(db, 'donations', DONATION_BLOB_PREFIX);
    const list = (db.donations || []).map(publicDonation);
    list.sort((a, b) => String(b.donatedAt).localeCompare(String(a.donatedAt)));
    res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
    res.end(JSON.stringify(list));
    return;
  }

  // 18.5 DELETE /api/admin/donations/:id （第10弾: 運営者: 寄付記録の削除。パスコード必須）
  // 誤記録の訂正・テスト記録の掃除用です。Blob とメモリの両方から削除
  // します（寄付累計は記録の配列から都度計算されるため自動で追随）。
  if (pathname.startsWith('/api/admin/donations/') && req.method === 'DELETE') {
    if (!hasAdminPasscode(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ error: "admin passcode required" }));
      return;
    }
    const donationId = pathname.split('/')[4];
    try {
      const db = loadDB();
      await hydrateCollectionFromBlob(db, 'donations', DONATION_BLOB_PREFIX);
      let target = (db.donations || []).find(d => d.id === donationId);
      if (!target) {
        await hydrateCollectionFromBlob(db, 'donations', DONATION_BLOB_PREFIX, { force: true });
        target = (db.donations || []).find(d => d.id === donationId);
      }
      if (!target) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=UTF-8' });
        res.end(JSON.stringify({ error: "donation not found" }));
        return;
      }
      const blob = loadBlobClient();
      if (blob && target.storage === 'blob') {
        try {
          await blob.del(target.metaBlobPathname || donationMetaPathname(target.id), { token: process.env.BLOB_READ_WRITE_TOKEN });
        } catch (err) {
          console.error('⚠️ Blob からの寄付記録の削除に失敗しました:', err.message);
          res.writeHead(500, { 'Content-Type': 'application/json; charset=UTF-8' });
          res.end(JSON.stringify({ error: "failed to delete donation" }));
          return;
        }
      }
      db.donations = (db.donations || []).filter(d => d.id !== donationId);
      saveDB(db);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ success: true }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ error: "Internal Server Error" }));
    }
    return;
  }

  // 19. GET /api/donations/summary （公開: トップ表示用の集計。個人名は含まない）
  if (pathname === '/api/donations/summary' && req.method === 'GET') {
    const db = loadDB();
    await hydrateCollectionFromBlob(db, 'coinPayments', COIN_BLOB_PREFIX);
    await hydrateCollectionFromBlob(db, 'donations', DONATION_BLOB_PREFIX);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
    res.end(JSON.stringify(computeDonationSummary(db)));
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
