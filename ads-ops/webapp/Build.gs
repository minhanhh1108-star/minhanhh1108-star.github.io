/**
 * Builder: turns a queued order into PAUSED objects on Meta, step by step, resumable across runs.
 * Triggered every minute by processQueue(). Each run works ≤ ~4.5 minutes.
 *
 * Steps per order (idempotent – IDs already in order.meta are skipped):
 *   1. media     – upload Drive videos (chunked, resumable) / images, wait for processing, thumbnails
 *   2. campaign  – create campaign (PAUSED)
 *   3. adsets    – create ad sets (PAUSED)
 *   4. creatives – one creative per ad template
 *   5. ads       – one ad per (template × ad set) (PAUSED)
 */

var RUN_BUDGET_MS = 270000;
var DRIVE_CHUNK_MAX = 40 * 1024 * 1024;

function processQueue() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  var started = Date.now();
  try {
    var queue = rows_('Orders').filter(function (r) { return r.status === STATUS.QUEUED || r.status === STATUS.BUILDING; });
    for (var i = 0; i < queue.length; i++) {
      if (Date.now() - started > RUN_BUDGET_MS) break;
      var o = getOrder_(queue[i].id);
      try {
        if (o.status === STATUS.QUEUED) { o.status = STATUS.BUILDING; o.build.startedAt = nowIso_(); writeOrder_(o); }
        var done = buildStep_(o, started);
        if (done) {
          o.status = STATUS.BUILT;
          o.build.finishedAt = nowIso_();
          writeOrder_(o);
          logAction_('Hệ thống', o.id, 'Dựng xong (tạm dừng)', o.meta.campaignId, 'OK', countMetaAds(o) + ' quảng cáo');
          notify_(o, 'Đã dựng xong: ' + o.campaign.name,
            'Chiến dịch "' + o.campaign.name + '" đã được tạo trên Meta ở trạng thái TẠM DỪNG.\n' +
            'ID chiến dịch: ' + o.meta.campaignId + '\nVào app, tab "Đơn lên camp" để kiểm tra và bấm "Bật chạy".');
        } else {
          writeOrder_(o);
        }
      } catch (e) {
        o.status = STATUS.ERROR;
        o.build.error = String(e.message || e);
        writeOrder_(o);
        logAction_('Hệ thống', o.id, 'Dựng camp lỗi', o.meta && o.meta.campaignId || '', 'Lỗi', o.build.error);
        notify_(o, 'Lỗi khi dựng: ' + (o.campaign && o.campaign.name), 'Lỗi: ' + o.build.error +
          '\nCác phần đã tạo trên Meta vẫn ở trạng thái tạm dừng. Sửa đơn rồi bấm "Chạy lại".');
      }
    }
  } finally { lock.releaseLock(); }
}

/** Returns true when the whole order is built. */
function buildStep_(o, started) {
  o.meta = o.meta || {};
  var m = o.meta;
  m.adsetIds = m.adsetIds || {}; m.creativeIds = m.creativeIds || {}; m.adIds = m.adIds || {}; m.media = m.media || {};
  var s = getSettings_();
  var acc = s.accounts.filter(function (a) { return a.id === o.campaign.account; })[0];
  if (!acc) throw new Error('Tài khoản không có trong Cài đặt.');
  var timeLeft = function () { return RUN_BUDGET_MS - (Date.now() - started); };
  var adsets = o.adsets.filter(function (g) { return g.name; });
  var templates = o.ads.filter(function (a) { return a.name; });

  // ---------- 1. media
  for (var i = 0; i < templates.length; i++) {
    var a = templates[i];
    if (a.source === 'post') continue;
    var md = m.media[a.key] = m.media[a.key] || {};
    if (md.ready) continue;
    if (timeLeft() < 30000) return false;
    var fileId = driveId_(a.driveUrl);
    var file = DriveApp.getFileById(fileId);
    var mime = file.getMimeType();
    if (/^image\//.test(mime)) {
      md.kind = 'image';
      md.imageHash = uploadImage_(acc.id, file.getBlob());
      md.ready = true;
      log_(o, 'Tải ảnh lên Meta', a.name);
      continue;
    }
    if (!/^video\//.test(mime)) throw new Error('File "' + file.getName() + '" không phải video/ảnh (' + mime + ').');
    md.kind = 'video';
    if (!md.videoId || md.upload) {
      var finished = uploadVideoChunked_(acc.id, fileId, file.getSize(), file.getName(), md, timeLeft);
      if (!finished) { log_(o, 'Đang tải video ' + Math.round(100 * (md.upload.start || 0) / file.getSize()) + '%', a.name); return false; }
      log_(o, 'Tải video xong, chờ Meta xử lý', a.name);
    }
    var st = gget(md.videoId, { fields: 'status' }).status || {};
    if (st.video_status === 'error') throw new Error('Meta xử lý video "' + a.name + '" lỗi.');
    if (st.video_status !== 'ready') return false;            // try again next minute
    if (a.thumbUrl) {
      md.thumbHash = uploadImage_(acc.id, DriveApp.getFileById(driveId_(a.thumbUrl)).getBlob());
    } else {
      var th = gget(md.videoId + '/thumbnails', { fields: 'uri,is_preferred' }).data || [];
      var pref = th.filter(function (t) { return t.is_preferred; })[0] || th[0];
      if (!pref) return false;
      md.thumbUrl = pref.uri;
    }
    md.ready = true;
  }

  // ---------- 2. campaign
  var lifetime = hasSchedule(o);
  if (!m.campaignId) {
    var cp = { name: o.campaign.name, objective: 'OUTCOME_LEADS', status: 'PAUSED', buying_type: 'AUCTION', special_ad_categories: [] };
    if (o.campaign.budgetMode === 'campaign') {
      cp.bid_strategy = 'LOWEST_COST_WITHOUT_CAP';
      if (lifetime) cp.lifetime_budget = Math.round(Number(o.campaign.dailyBudget) * campaignDays_(adsets));
      else cp.daily_budget = Math.round(Number(o.campaign.dailyBudget));
    } else {
      cp.is_adset_budget_sharing_enabled = false;
    }
    m.campaignId = gpost(acc.id + '/campaigns', cp).id;
    log_(o, 'Tạo chiến dịch', m.campaignId);
  }

  // ---------- 3. ad sets
  for (var j = 0; j < adsets.length; j++) {
    var g = adsets[j];
    if (m.adsetIds[g.key]) continue;
    if (timeLeft() < 15000) return false;
    var body = adsetBody_(o, g, acc, s, lifetime);
    m.adsetIds[g.key] = gpost(acc.id + '/adsets', body).id;
    log_(o, 'Tạo nhóm "' + g.name + '"', m.adsetIds[g.key]);
  }

  // ---------- 4. creatives
  for (var k = 0; k < templates.length; k++) {
    var t = templates[k];
    if (m.creativeIds[t.key]) continue;
    if (timeLeft() < 15000) return false;
    m.creativeIds[t.key] = gpost(acc.id + '/adcreatives', creativeBody_(t, m.media[t.key] || {}, acc, s)).id;
  }

  // ---------- 5. ads
  for (var x = 0; x < templates.length; x++) {
    var tp = templates[x];
    var keys = adsetKeysFor(tp, o);
    for (var y = 0; y < keys.length; y++) {
      var id = keys[y] + '|' + tp.key;
      if (m.adIds[id]) continue;
      if (timeLeft() < 10000) return false;
      m.adIds[id] = gpost(acc.id + '/ads', { name: tp.name, adset_id: m.adsetIds[keys[y]],
                                              creative: { creative_id: m.creativeIds[tp.key] }, status: 'PAUSED' }).id;
    }
  }
  log_(o, 'Tạo ' + Object.keys(m.adIds).length + ' quảng cáo', '');
  return true;
}

function log_(o, action, detail) {
  o.build.log = (o.build.log || []).concat([{ t: nowIso_(), a: action, d: detail || '' }]).slice(-60);
}

function driveId_(url) {
  var m = String(url || '').match(/\/d\/([a-zA-Z0-9_-]{20,})/) || String(url || '').match(/[?&]id=([a-zA-Z0-9_-]{20,})/);
  if (!m) throw new Error('Không đọc được ID file từ link Drive: ' + url);
  return m[1];
}

function campaignDays_(adsets) {
  var st = Math.min.apply(null, adsets.map(function (g) { return parseLocal_(g.start).getTime(); }));
  var en = Math.max.apply(null, adsets.map(function (g) { return parseLocal_(g.end).getTime(); }));
  return Math.max(1, Math.ceil((en - st) / 86400000));
}

function toMetaTime_(local) {
  var d = parseLocal_(local);
  return d ? Utilities.formatDate(d, 'Asia/Ho_Chi_Minh', "yyyy-MM-dd'T'HH:mm:ssZ") : undefined;
}

function adsetBody_(o, g, acc, s, lifetime) {
  var lib = loadLibrary_();
  var byCode = {};
  lib.audiences.forEach(function (a) { byCode[a.code] = a; });
  var ids = function (codes) {
    var out = [];
    (codes || []).forEach(function (c) { (byCode[c] ? byCode[c].ids : []).forEach(function (id) { out.push({ id: id }); }); });
    return out;
  };
  var regions = (g.regions && g.regions.length) ? g.regions : [o.campaign.region];
  var geo = regions.indexOf('VN') >= 0 ? { countries: ['VN'] } : { regions: regions.map(function (k) { return { key: String(k) }; }) };
  geo.location_types = ['home', 'recent'];
  var targeting = {
    age_min: Number(g.ageMin || s.defaults.ageMin), age_max: Number(g.ageMax || s.defaults.ageMax),
    geo_locations: geo,
    targeting_automation: { advantage_audience: g.advantage ? 1 : 0 }
  };
  if (g.gender === 'male') targeting.genders = [1];
  if (g.gender === 'female') targeting.genders = [2];
  var inc = ids(g.audiences), exc = ids(g.excludes);
  if (inc.length) targeting.custom_audiences = inc;
  if (exc.length) targeting.excluded_custom_audiences = exc;
  var body = {
    name: g.name, campaign_id: o.meta.campaignId, status: 'PAUSED',
    optimization_goal: 'LEAD_GENERATION', billing_event: 'IMPRESSIONS', destination_type: 'ON_AD',
    promoted_object: { page_id: acc.pageId },
    attribution_spec: [{ event_type: 'CLICK_THROUGH', window_days: Number(s.defaults.attributionDays || 1) }],
    targeting: targeting,
    start_time: toMetaTime_(g.start)
  };
  if (g.end) body.end_time = toMetaTime_(g.end);
  if (o.campaign.budgetMode === 'adset') {
    body.bid_strategy = 'LOWEST_COST_WITHOUT_CAP';
    if (lifetime) body.lifetime_budget = Math.round(Number(g.dailyBudget) * campaignDays_([g]));
    else body.daily_budget = Math.round(Number(g.dailyBudget));
  }
  if (g.slots && g.slots.length) {
    var days = (g.days && g.days.length) ? g.days.map(Number) : [0, 1, 2, 3, 4, 5, 6];
    body.pacing_type = ['day_parting'];
    body.adset_schedule = g.slots.map(function (sl) {
      return { start_minute: Number(sl.from) * 60, end_minute: Number(sl.to) * 60, days: days, timezone_type: 'ADVERTISER' };
    });
  }
  return body;
}

function creativeBody_(t, md, acc, s) {
  if (t.source === 'post') return { name: t.name, object_story_id: String(t.postId).trim() };
  var cta = { type: t.cta || s.defaults.cta || 'SIGN_UP', value: { lead_gen_form_id: t.formId, link: 'http://fb.me/' } };
  var spec = { page_id: acc.pageId };
  if (md.kind === 'image') {
    spec.link_data = { image_hash: md.imageHash, message: t.message, name: t.title || undefined, link: 'http://fb.me/', call_to_action: cta };
  } else {
    spec.video_data = { video_id: md.videoId, message: t.message, title: t.title || undefined, call_to_action: cta };
    if (md.thumbHash) spec.video_data.image_hash = md.thumbHash; else spec.video_data.image_url = md.thumbUrl;
  }
  return { name: t.name, object_story_spec: spec };
}

function uploadImage_(accId, blob) {
  var r = gpost(accId + '/adimages', { bytes: Utilities.base64Encode(blob.getBytes()) });
  var k = Object.keys(r.images || {})[0];
  if (!k) throw new Error('Meta không trả về mã ảnh.');
  return r.images[k].hash;
}

/**
 * Chunked video upload: Drive is read by byte range (works above 50 MB), each range is sent to Meta.
 * State is kept in md.upload so a run can stop and the next run continues.
 */
function uploadVideoChunked_(accId, fileId, size, name, md, timeLeft) {
  if (!md.upload) {
    var st = gpost(accId + '/advideos', { upload_phase: 'start', file_size: size });
    md.videoId = st.video_id;
    md.upload = { session: st.upload_session_id, start: Number(st.start_offset), end: Number(st.end_offset) };
  }
  var u = md.upload;
  while (u.start < u.end) {
    if (timeLeft() < 60000) return false;
    var len = u.end - u.start;
    if (len > DRIVE_CHUNK_MAX) throw new Error('Meta yêu cầu đoạn video quá lớn (' + Math.round(len / 1048576) + ' MB).');
    var res = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + fileId + '?alt=media&supportsAllDrives=true', {
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken(), Range: 'bytes=' + u.start + '-' + (u.end - 1) },
      muteHttpExceptions: true });
    if ([200, 206].indexOf(res.getResponseCode()) < 0) throw new Error('Không đọc được video trên Drive (HTTP ' + res.getResponseCode() + '). Kiểm tra quyền chia sẻ cho chủ app.');
    var chunk = res.getBlob().setName(name);
    var r = gpost(accId + '/advideos', { upload_phase: 'transfer', upload_session_id: u.session, start_offset: u.start, video_file_chunk: chunk });
    u.start = Number(r.start_offset); u.end = Number(r.end_offset);
  }
  gpost(accId + '/advideos', { upload_phase: 'finish', upload_session_id: u.session, title: name });
  delete md.upload;
  return true;
}

/* =========================== Activate / pause =========================== */

function activateOrder_(user, p) {
  if (!canActivate_(user, getSettings_())) throw new Error('Bạn chưa được giao quyền bật chạy.');
  var o = getOrder_(p.id);
  if ([STATUS.BUILT, STATUS.PAUSED].indexOf(o.status) < 0) throw new Error('Chỉ bật được đơn đã dựng hoặc đang tạm dừng.');
  if (p.confirmName !== o.campaign.name) throw new Error('Tên xác nhận không khớp tên chiến dịch.');
  var m = o.meta;
  Object.keys(m.adIds).forEach(function (k) { gpost(m.adIds[k], { status: 'ACTIVE' }); });
  Object.keys(m.adsetIds).forEach(function (k) { gpost(m.adsetIds[k], { status: 'ACTIVE' }); });
  gpost(m.campaignId, { status: 'ACTIVE' });
  o.status = STATUS.ACTIVE;
  o.activatedBy = user.email; o.activatedAt = nowIso_();
  writeOrder_(o);
  logAction_(user.email, o.id, 'BẬT CHẠY', m.campaignId, 'OK', o.campaign.name);
  notify_(o, 'Đã bật chạy: ' + o.campaign.name, user.email + ' đã bật chạy chiến dịch lúc ' + o.activatedAt + '.');
  return o;
}

function pauseOrder_(user, p) {
  if (!canActivate_(user, getSettings_())) throw new Error('Bạn chưa được giao quyền tạm dừng.');
  var o = getOrder_(p.id);
  if (o.status !== STATUS.ACTIVE) throw new Error('Đơn không ở trạng thái đang chạy.');
  gpost(o.meta.campaignId, { status: 'PAUSED' });
  o.status = STATUS.PAUSED;
  writeOrder_(o);
  logAction_(user.email, o.id, 'Tạm dừng', o.meta.campaignId, 'OK', o.campaign.name);
  return o;
}
