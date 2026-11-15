'use strict';
/* ==========================================================================
   おせっ会 浜松 - S3 互換ストレージクライアント（第21弾）
   - Vercel Blob の無料枠（Advanced Requests 月2,000回）を使い切って
     ストアが30日間停止したため、保存先を S3 互換ストレージ
     （Backblaze B2）へ差し替えられるようにするための薄い実装です。
   - 追加の npm 依存は無く、AWS Signature V4 署名付きの fetch だけで
     PutObject / GetObject / ListObjectsV2 / DeleteObject を叩きます。
   - インターフェースは @vercel/blob のうち本サーバーが使う範囲
     （put / get / list / del）に揃えてあります。local_server.js 側は
     どちらのバックエンドでも同じ呼び出しで動作します。
   - B2 の S3 互換で使える操作だけを使います（ACL・タグ付け・公開設定
     等は使いません）。バケットは非公開前提で、put の access 指定は
     受け取るだけで意味を持ちません（B2 側はバケット設定が正）。
   - URL の組み立てはパス形式（<endpoint>/<bucket>/<key>）です。
     Backblaze B2 の S3 エンドポイントはパス形式を受け付けます。
   ========================================================================== */

const crypto = require('crypto');

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function hmacSha256(key, data) {
  return crypto.createHmac('sha256', key).update(data, 'utf-8').digest();
}

// SigV4 の署名鍵を導出する（単体テストで AWS 公式の既知ベクトルと照合）。
function deriveSigningKey(secretAccessKey, dateStamp, region, service) {
  const kDate = hmacSha256('AWS4' + secretAccessKey, dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  return hmacSha256(kService, 'aws4_request');
}

function encodeKey(key) {
  // パス区切り '/' は残し、各セグメントだけをエンコードする
  return String(key).split('/').map(encodeURIComponent).join('/');
}

function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function unescapeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function xmlTag(xml, tag) {
  const m = new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>').exec(xml);
  return m ? unescapeXml(m[1]) : '';
}

// ListObjectsV2 の XML 応答を { keys: [{key, size, lastModified}], isTruncated, nextContinuationToken } に変換する
function parseListObjectsV2(xml) {
  const keys = [];
  const contentsRe = /<Contents>([\s\S]*?)<\/Contents>/g;
  let m;
  while ((m = contentsRe.exec(xml)) !== null) {
    const block = m[1];
    keys.push({
      key: xmlTag(block, 'Key'),
      size: Number(xmlTag(block, 'Size') || 0),
      lastModified: xmlTag(block, 'LastModified') || ''
    });
  }
  return {
    keys: keys,
    isTruncated: /<IsTruncated>true<\/IsTruncated>/.test(xml),
    nextContinuationToken: xmlTag(xml, 'NextContinuationToken') || undefined
  };
}

// SigV4 の正規クエリ文字列を作る。
// pathAndQuery 側のクエリは既にパーセントエンコード済み（例: prefix=verify-requests%2F）
// なので、そのまま encodeURIComponent すると % が二重にエンコードされて
// 署名が一致しなくなります（2026-11-15 本番で ListObjectsV2 が
// SignatureDoesNotMatch になった原因）。一度デコードしてから
// 1回だけエンコードし直すことで正規化します。
function canonicalQueryOf(rawQuery) {
  const dec = s => { try { return decodeURIComponent(s); } catch (e) { return s; } };
  const params = [];
  for (const pair of String(rawQuery || '').split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    if (eq === -1) params.push([encodeURIComponent(dec(pair)), '']);
    else params.push([encodeURIComponent(dec(pair.slice(0, eq))), encodeURIComponent(dec(pair.slice(eq + 1)))]);
  }
  params.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)));
  return params.map(p => p[0] + '=' + p[1]).join('&');
}

function toBuffer(body) {
  if (body === undefined || body === null) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === 'string') return Buffer.from(body, 'utf-8');
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  throw new Error('s3 storage: unsupported body type');
}

/**
 * S3 互換クライアントを作る。
 * config: { endpoint, region, bucket, accessKeyId, secretAccessKey }
 * fetchImpl: テスト差し替え用（省略時は global fetch）。
 * 返り値は @vercel/blob 互換の { put, get, list, del }。
 */
function createS3Client(config, fetchImpl) {
  const cfg = config || {};
  // 環境変数へコピー＆ペーストで値を入れると、末尾に改行や空白が紛れることが
  // あります（2026-11-15 の本番障害の原因: keyID 末尾の改行が Authorization
  // ヘッダーへ混入し、Headers.append が例外を投げて全リクエストが失敗した）。
  // ここで必ず前後の空白・改行を取り除いてから使います。
  const endpoint = String(cfg.endpoint || '').trim().replace(/\/+$/, '');
  const region = String(cfg.region || 'us-east-1').trim();
  const bucket = String(cfg.bucket || '').trim();
  const accessKeyId = String(cfg.accessKeyId || '').trim();
  const secretAccessKey = String(cfg.secretAccessKey || '').trim();
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    throw new Error('s3 storage: endpoint / bucket / accessKeyId / secretAccessKey are all required');
  }
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) throw new Error('s3 storage: global fetch is not available');
  const host = new URL(endpoint).host;

  // SigV4 署名付きリクエストを送る。extraHeaders は署名対象に含める。
  async function signedFetch(method, pathAndQuery, bodyBuf, extraHeaders) {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ''); // YYYYMMDDTHHMMSSZ
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = sha256Hex(bodyBuf || Buffer.alloc(0));

    const headers = {
      'host': host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate
    };
    if (extraHeaders) {
      for (const k of Object.keys(extraHeaders)) headers[k.toLowerCase()] = String(extraHeaders[k]);
    }
    const signedHeaderNames = Object.keys(headers).sort();
    const canonicalHeaders = signedHeaderNames.map(n => n + ':' + String(headers[n]).trim() + '\n').join('');
    const signedHeaders = signedHeaderNames.join(';');

    const qIndex = pathAndQuery.indexOf('?');
    const canonicalUri = qIndex === -1 ? pathAndQuery : pathAndQuery.slice(0, qIndex);
    const canonicalQuery = qIndex === -1 ? '' : canonicalQueryOf(pathAndQuery.slice(qIndex + 1));

    const canonicalRequest = [method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
    const scope = dateStamp + '/' + region + '/s3/aws4_request';
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
    const signingKey = deriveSigningKey(secretAccessKey, dateStamp, region, 's3');
    const signature = crypto.createHmac('sha256', signingKey).update(stringToSign, 'utf-8').digest('hex');
    headers['authorization'] = 'AWS4-HMAC-SHA256 Credential=' + accessKeyId + '/' + scope +
      ', SignedHeaders=' + signedHeaders + ', Signature=' + signature;

    const url = endpoint + pathAndQuery;
    const init = { method: method, headers: headers };
    if (bodyBuf && bodyBuf.length > 0) init.body = bodyBuf;
    return doFetch(url, init);
  }

  function objectPath(key) {
    return '/' + encodeURIComponent(bucket) + '/' + encodeKey(key);
  }

  function publicUrlFor(key) {
    // バケットは非公開のため、この URL 自体は署名なしでは開けません
    // （Vercel Blob の private 保存と同じ位置づけで、内部記録専用）。
    return endpoint + '/' + bucket + '/' + String(key);
  }

  async function readErrorBody(res) {
    try { return (await res.text()).slice(0, 300); } catch (e) { return ''; }
  }

  // @vercel/blob の put と同じ形: { url, downloadUrl, pathname, contentType, contentDisposition }
  // S3 の PutObject は常に上書きします（サーバー側は全ての put で
  // allowOverwrite: true を指定しているため、実挙動に差はありません）。
  async function put(pathname, body, options = {}) {
    const buf = toBuffer(body);
    const contentType = options.contentType || 'application/octet-stream';
    const res = await signedFetch('PUT', objectPath(pathname), buf, { 'content-type': contentType });
    if (!res.ok) {
      throw new Error('s3 storage: PutObject failed (' + res.status + '): ' + (await readErrorBody(res)));
    }
    return {
      url: publicUrlFor(pathname),
      downloadUrl: publicUrlFor(pathname),
      pathname: pathname,
      contentType: contentType,
      contentDisposition: 'inline'
    };
  }

  // @vercel/blob の get と同じ形: 存在すれば { stream, headers, blob }、無ければ null。
  async function get(pathname, options = {}) {
    const res = await signedFetch('GET', objectPath(pathname), Buffer.alloc(0), null);
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error('s3 storage: GetObject failed (' + res.status + '): ' + (await readErrorBody(res)));
    }
    const contentType = (res.headers && typeof res.headers.get === 'function')
      ? (res.headers.get('content-type') || '') : '';
    return {
      stream: res.body,
      headers: res.headers,
      blob: {
        url: publicUrlFor(pathname),
        downloadUrl: publicUrlFor(pathname),
        pathname: pathname,
        contentDisposition: 'inline',
        contentType: contentType,
        cacheControl: '',
        uploadedAt: new Date(),
        etag: (res.headers && typeof res.headers.get === 'function') ? (res.headers.get('etag') || '') : ''
      }
    };
  }

  // @vercel/blob の list と同じ形: { blobs: [{pathname, size, uploadedAt, url}], cursor, hasMore }
  async function list(options = {}) {
    const prefix = options.prefix || '';
    const limit = options.limit || 1000;
    let qs = 'list-type=2&max-keys=' + encodeURIComponent(String(limit)) + '&prefix=' + encodeURIComponent(prefix);
    if (options.cursor) qs += '&continuation-token=' + encodeURIComponent(options.cursor);
    const res = await signedFetch('GET', '/' + encodeURIComponent(bucket) + '?' + qs, Buffer.alloc(0), null);
    if (!res.ok) {
      throw new Error('s3 storage: ListObjectsV2 failed (' + res.status + '): ' + (await readErrorBody(res)));
    }
    const parsed = parseListObjectsV2(await res.text());
    return {
      blobs: parsed.keys.map(k => ({
        url: publicUrlFor(k.key),
        downloadUrl: publicUrlFor(k.key),
        pathname: k.key,
        size: k.size,
        uploadedAt: k.lastModified ? new Date(k.lastModified) : new Date()
      })),
      cursor: parsed.isTruncated ? parsed.nextContinuationToken : undefined,
      hasMore: parsed.isTruncated
    };
  }

  // @vercel/blob の del と同じ形: 文字列または配列を受け取り、1件ずつ消す。
  async function del(pathnameOrArray, options = {}) {
    const targets = Array.isArray(pathnameOrArray) ? pathnameOrArray : [pathnameOrArray];
    for (const p of targets) {
      const res = await signedFetch('DELETE', objectPath(p), Buffer.alloc(0), null);
      // S3 の DeleteObject は、対象が無くても 204 を返すのが仕様。
      // それ以外のエラーだけを失敗として扱います。
      if (!res.ok && res.status !== 404) {
        throw new Error('s3 storage: DeleteObject failed (' + res.status + '): ' + (await readErrorBody(res)));
      }
    }
  }

  return { put, get, list, del };
}

// 環境変数から接続情報を読む（local_server.js から使う）。
// 必須: S3_ENDPOINT / S3_BUCKET / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY
// 任意: S3_REGION（既定 us-east-1。B2 ではエンドポイント側のリージョン名）
function configFromEnv(env) {
  const e = env || process.env;
  return {
    endpoint: e.S3_ENDPOINT || '',
    region: e.S3_REGION || 'us-east-1',
    bucket: e.S3_BUCKET || '',
    accessKeyId: e.S3_ACCESS_KEY_ID || '',
    secretAccessKey: e.S3_SECRET_ACCESS_KEY || ''
  };
}

module.exports = {
  createS3Client,
  configFromEnv,
  // 単体テスト用に内部関数も公開する
  _internals: { sha256Hex, hmacSha256, deriveSigningKey, parseListObjectsV2, encodeKey, canonicalQueryOf }
};
