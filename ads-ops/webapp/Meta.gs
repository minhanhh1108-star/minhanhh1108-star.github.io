/**
 * Thin Meta Graph API client. The token lives only in Script Properties (META_TOKEN).
 */

function metaToken_() {
  var t = PropertiesService.getScriptProperties().getProperty('META_TOKEN');
  if (!t) throw new Error('Thiếu META_TOKEN trong Script Properties.');
  return t;
}

function graphUrl_(path) {
  return path.indexOf('https://') === 0 ? path : 'https://graph.facebook.com/' + API_VERSION + '/' + path.replace(/^\//, '');
}

function encodeParams_(params) {
  return Object.keys(params || {}).filter(function (k) { return params[k] !== undefined && params[k] !== null; })
    .map(function (k) {
      var v = params[k];
      if (typeof v === 'object') v = JSON.stringify(v);
      return encodeURIComponent(k) + '=' + encodeURIComponent(v);
    }).join('&');
}

function parseGraph_(res) {
  var body = res.getContentText();
  var data;
  try { data = JSON.parse(body); } catch (e) { throw new Error('Meta trả về dữ liệu lạ (HTTP ' + res.getResponseCode() + ').'); }
  if (data.error) {
    var e = data.error;
    var msg = e.error_user_msg || e.message;
    var err = new Error('Meta: ' + msg + ' (mã ' + e.code + (e.error_subcode ? '/' + e.error_subcode : '') + ')');
    err.code = e.code;
    throw err;
  }
  return data;
}

/** GET with automatic retry on rate limits. */
function gget(path, params, token) {
  var q = encodeParams_(Object.assign({ access_token: token || metaToken_() }, params || {}));
  var url = graphUrl_(path) + (graphUrl_(path).indexOf('?') >= 0 ? '&' : '?') + q;
  return withRetry_(function () { return parseGraph_(UrlFetchApp.fetch(url, { muteHttpExceptions: true })); });
}

/** GET following paging.next. */
function gall(path, params, token, maxPages) {
  var out = [];
  var data = gget(path, params, token);
  var pages = 0;
  while (true) {
    out = out.concat(data.data || []);
    var next = data.paging && data.paging.next;
    if (!next || ++pages >= (maxPages || 20)) break;
    data = withRetry_(function () { return parseGraph_(UrlFetchApp.fetch(next, { muteHttpExceptions: true })); });
  }
  return out;
}

/** POST form-encoded (objects are JSON-encoded), or multipart when a Blob is present. */
function gpost(path, params, token) {
  var p = Object.assign({ access_token: token || metaToken_() }, params || {});
  var hasBlob = Object.keys(p).some(function (k) { return p[k] && typeof p[k].getBytes === 'function'; });
  var payload;
  if (hasBlob) {
    payload = {};
    Object.keys(p).forEach(function (k) {
      var v = p[k];
      if (v === undefined || v === null) return;
      payload[k] = (typeof v === 'object' && typeof v.getBytes !== 'function') ? JSON.stringify(v) : (typeof v.getBytes === 'function' ? v : String(v));
    });
  } else {
    payload = encodeParams_(p);
  }
  var opts = { method: 'post', payload: payload, muteHttpExceptions: true };
  if (!hasBlob) opts.contentType = 'application/x-www-form-urlencoded';
  return withRetry_(function () { return parseGraph_(UrlFetchApp.fetch(graphUrl_(path), opts)); });
}

function withRetry_(fn) {
  var wait = 2000;
  for (var i = 0; i < 4; i++) {
    try { return fn(); } catch (e) {
      // 4/17/32/613 = rate limits; 1/2 = transient
      if ([1, 2, 4, 17, 32, 613].indexOf(e.code) < 0 || i === 3) throw e;
      Utilities.sleep(wait); wait *= 2;
    }
  }
}

/** Page access token (cached 50 min). Needed for lead forms and page posts. */
function pageToken_(pageId) {
  var cache = CacheService.getScriptCache();
  var key = 'ptok_' + pageId;
  var t = cache.get(key);
  if (t) return t;
  var r = gget(pageId, { fields: 'access_token' });
  if (!r.access_token) throw new Error('Không lấy được quyền trang ' + pageId + '. Kiểm tra trang đã gán cho System User.');
  cache.put(key, r.access_token, 3000);
  return r.access_token;
}

function leadCount_(insight) {
  var acts = {};
  ((insight || {}).actions || []).forEach(function (a) { acts[a.action_type] = Number(a.value); });
  return acts['lead'] || acts['onsite_conversion.lead_grouped'] || acts['offsite_complete_registration_add_meta_leads'] || 0;
}
