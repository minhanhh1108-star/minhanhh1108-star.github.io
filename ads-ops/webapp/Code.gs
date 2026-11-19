/**
 * Meta Ads Launcher – web app (Google Apps Script).
 * Core: routing, auth (email + PIN), database (Google Sheet), orders, users, settings, log.
 *
 * Script Properties (Project Settings → Script properties):
 *   META_TOKEN  – Meta System User token (ads_management, ads_read, pages_* …). NEVER commit it.
 *   DB_ID       – created by setup().
 */

var APP_NAME = 'Lên camp Meta';
var API_VERSION = 'v21.0';
var SESSION_HOURS = 8;
var ROLES = { admin: 4, approver: 3, runner: 2, content: 1 };
var ROLE_LABEL = { admin: 'Quản trị', approver: 'Người duyệt', runner: 'Người chạy quảng cáo', content: 'Người viết nội dung' };
var STATUS = {
  DRAFT: 'Nháp', QUEUED: 'Chờ dựng', BUILDING: 'Đang dựng', BUILT: 'Đã dựng (tạm dừng)',
  ERROR: 'Lỗi', ACTIVE: 'Đang chạy', PAUSED: 'Tạm dừng', REMOVED: 'Đã xóa trên Meta'
};
var SHEETS = {
  Orders: ['id', 'status', 'name', 'account', 'createdBy', 'createdAt', 'updatedAt', 'j1', 'j2', 'j3', 'j4', 'j5', 'j6', 'j7', 'j8'],
  Users: ['email', 'name', 'role', 'salt', 'pinHash', 'active', 'createdAt'],
  Library: ['kind', 'key', 'account', 'updatedAt', 'j1', 'j2'],
  Live: ['campaignId', 'account', 'updatedAt', 'j1', 'j2', 'j3', 'j4'],
  Settings: ['key', 'j1', 'j2'],
  Log: ['time', 'user', 'orderId', 'action', 'objectId', 'result', 'detail']
};

/* =========================== Web entry =========================== */

function doGet() {
  if (!isInstalled_()) {
    return HtmlService.createHtmlOutputFromFile('Setup').setTitle(APP_NAME + ' – cài đặt')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  }
  return HtmlService.createTemplateFromFile('Index').evaluate()
    .setTitle(APP_NAME)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

/** Single entry point for the client: api(action, sessionToken, payload) → {ok, data} | {ok:false, error}. */
function api(action, token, payload) {
  try {
    if (action === 'login') return ok_(login_(payload));
    var user = requireUser_(token);
    var h = handlers_()[action];
    if (!h) throw new Error('Không có chức năng: ' + action);
    if (ROLES[user.role] < ROLES[h.role]) throw new Error('Bạn không có quyền thực hiện thao tác này.');
    return ok_(h.fn(user, payload || {}));
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

function ok_(data) { return { ok: true, data: data === undefined ? null : JSON.parse(JSON.stringify(data)) }; }

/** Built lazily: in Apps Script, functions from files loaded later are not defined yet at load time. */
function handlers_() { return {
  logout:        { role: 'content',  fn: function (u, p) { CacheService.getScriptCache().remove('sess_' + p.token); return true; } },
  bootstrap:     { role: 'content',  fn: bootstrap_ },
  changePin:     { role: 'content',  fn: changePin_ },
  listOrders:    { role: 'content',  fn: function () { return listOrders_(); } },
  getOrder:      { role: 'content',  fn: function (u, p) { return getOrder_(p.id); } },
  saveOrder:     { role: 'content',  fn: saveOrder_ },
  validateOrder: { role: 'content',  fn: function (u, p) { return validateOrder(p.order, loadContext_()); } },
  cloneOrder:    { role: 'runner',   fn: cloneOrder_ },
  deleteOrder:   { role: 'runner',   fn: deleteOrder_ },
  submitOrder:   { role: 'runner',   fn: submitOrder_ },
  retryOrder:    { role: 'runner',   fn: retryOrder_ },
  activateOrder: { role: 'approver', fn: activateOrder_ },
  pauseOrder:    { role: 'approver', fn: pauseOrder_ },
  pauseLive:     { role: 'approver', fn: pauseLive_ },
  listLive:      { role: 'content',  fn: function () { return listLive_(); } },
  syncLive:      { role: 'runner',   fn: function () { return syncLive(); } },
  syncOrders:    { role: 'runner',   fn: function () { return syncOrderStatuses(); } },
  cloneLive:     { role: 'runner',   fn: cloneLive_ },
  syncLibrary:   { role: 'runner',   fn: function () { return syncLibrary(); } },
  listLog:       { role: 'content',  fn: function (u, p) { return listLog_(p.orderId); } },
  searchInterests: { role: 'runner', fn: function (u, p) { return searchInterests_(p.q); } },
  listBehaviors: { role: 'runner',   fn: function () { return listBehaviors_(); } },
  listUsers:     { role: 'admin',    fn: function () { return listUsers_(); } },
  saveUser:      { role: 'admin',    fn: saveUser_ },
  saveSettings:  { role: 'admin',    fn: saveSettings_ }
}; }

/* =========================== Setup =========================== */

/** Run once from the editor. Creates the database, admin user and triggers. */
function setup() {
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('META_TOKEN')) {
    throw new Error('Chưa có META_TOKEN trong Script Properties (Cài đặt dự án → Thuộc tính tập lệnh).');
  }
  var dbId = props.getProperty('DB_ID');
  var ss;
  if (dbId) {
    ss = SpreadsheetApp.openById(dbId);
  } else {
    ss = SpreadsheetApp.create('Lên camp Meta – Cơ sở dữ liệu (không sửa tay)');
    props.setProperty('DB_ID', ss.getId());
  }
  Object.keys(SHEETS).forEach(function (name) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    if (sh.getLastRow() === 0) sh.appendRow(SHEETS[name]);
  });
  var def = ss.getSheetByName('Sheet1') || ss.getSheetByName('Trang tính1');
  if (def && ss.getSheets().length > 1) ss.deleteSheet(def);
  if (!getSettingsRaw_()) putSetting_('config', defaultSettings_());

  var owner = Session.getEffectiveUser().getEmail();
  var pin = null;
  if (!findUser_(owner)) {
    pin = String(Math.floor(100000 + Math.random() * 900000));
    upsertUser_({ email: owner, name: 'Quản trị', role: 'admin', pin: pin, active: true });
  }
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('processQueue').timeBased().everyMinutes(1).create();
  ScriptApp.newTrigger('syncLive').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('syncLibrary').timeBased().everyDays(1).atHour(6).create();
  Logger.log('Cơ sở dữ liệu: ' + ss.getUrl());
  Logger.log('Tài khoản quản trị: ' + owner + (pin ? ' · Mã PIN: ' + pin + ' (đổi ngay sau khi đăng nhập)' : ' (đã tồn tại)'));
  var syncError = '';
  try { syncLibrary(); syncLive(); } catch (e) { syncError = e.message; Logger.log('Đồng bộ lần đầu lỗi: ' + e.message); }
  return { dbUrl: ss.getUrl(), admin: owner, pin: pin, syncError: syncError };
}

function isInstalled_() {
  var p = PropertiesService.getScriptProperties();
  return !!(p.getProperty('META_TOKEN') && p.getProperty('DB_ID'));
}

/** First-run install from the web page. Only the script owner can run it. */
function installApp(metaToken) {
  var owner = Session.getEffectiveUser().getEmail();
  var me = Session.getActiveUser().getEmail();
  if (!me || lower_(me) !== lower_(owner)) throw new Error('Chỉ chủ app (' + owner + ') mới cài đặt được. Hãy mở link bằng đúng tài khoản Google đó.');
  if (isInstalled_()) throw new Error('App đã được cài đặt.');
  metaToken = String(metaToken || '').trim();
  if (!metaToken) throw new Error('Chưa nhập token Meta.');
  var check = gget('me', { fields: 'id,name' }, metaToken);
  var perms = gget('me/permissions', {}, metaToken).data || [];
  var granted = perms.filter(function (x) { return x.status === 'granted'; }).map(function (x) { return x.permission; });
  var need = ['ads_management', 'ads_read', 'pages_show_list', 'pages_manage_ads', 'pages_read_engagement'];
  var missing = need.filter(function (x) { return granted.indexOf(x) < 0; });
  if (missing.length) throw new Error('Token thiếu quyền: ' + missing.join(', '));
  PropertiesService.getScriptProperties().setProperty('META_TOKEN', metaToken);
  var r = setup();
  r.metaUser = check.name;
  r.url = ScriptApp.getService().getUrl();
  return r;
}

function defaultSettings_() {
  return {
    accounts: [
      { name: 'OFFICIAL', id: 'act_1568146940461494', pageName: 'Bot Bán Hàng', pageId: '1706801539392655', audPrefix: 'OF1' },
      { name: 'OFFICIAL 2', id: 'act_1278038783371596', pageName: 'Bot Bán Hàng - Hà Nội', pageId: '930217733511334', audPrefix: 'OF2' }
    ],
    industries: [
      { name: 'Mỹ phẩm', target: 127000 }, { name: 'Đa ngành', target: 107000 }, { name: 'Salon', target: 102000 },
      { name: 'Spa', target: 125000 }, { name: 'Thời trang', target: 128000 }, { name: 'Gia dụng', target: 133000 },
      { name: 'Điện thoại', target: 130000, keywords: ['điện thoại', 'phụ kiện'] }, { name: 'Máy công nghiệp', target: 150000 }, { name: 'Ăn uống (F&B)', target: 120000 },
      { name: 'Bán hàng nước ngoài', target: 120000, keywords: ['case thái', 'nước ngoài'] }
    ],
    regions: [
      { name: 'Hồ Chí Minh', key: '3984' }, { name: 'Hà Nội', key: '3983' }, { name: 'Đà Nẵng', key: '4155' },
      { name: 'Bình Dương', key: '4159' }, { name: 'Đồng Nai', key: '3977' }, { name: 'Hải Phòng', key: '4150' },
      { name: 'Cần Thơ', key: '3988' }, { name: 'Bắc Ninh', key: '3961' }, { name: 'Khánh Hòa', key: '3994' },
      { name: 'Quảng Ninh', key: '3968' }, { name: 'Toàn quốc', key: 'VN' }
    ],
    limits: { minDaily: 150000, maxDailyPerCampaign: 1000000, maxNewPerDay: 2000000, singleAdsetBelow: 500000,
              audienceMaxDays: 90, primaryTextChars: 125, frequencyWarn: 2.5 },
    defaults: { ageMin: 23, ageMax: 55, gender: 'all', cta: 'SIGN_UP', attributionDays: 1, defaultFormByPage: {} },
    approvers: [],
    notifyEmails: [],
    dashboards: []
  };
}

/* =========================== Auth =========================== */

function hash_(salt, pin) {
  var raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + ':' + pin, Utilities.Charset.UTF_8);
  return Utilities.base64Encode(raw);
}

function login_(p) {
  var email = String(p.email || '').trim().toLowerCase();
  var pin = String(p.pin || '').trim();
  if (!email || !pin) throw new Error('Nhập email và mã PIN.');
  var cache = CacheService.getScriptCache();
  var failKey = 'fail_' + email;
  var fails = Number(cache.get(failKey) || 0);
  if (fails >= 5) throw new Error('Sai quá 5 lần. Thử lại sau 15 phút.');
  var u = findUser_(email);
  if (!u || String(u.active) === 'false' || hash_(u.salt, pin) !== u.pinHash) {
    cache.put(failKey, String(fails + 1), 900);
    throw new Error('Email hoặc mã PIN không đúng.');
  }
  cache.remove(failKey);
  var token = Utilities.getUuid();
  cache.put('sess_' + token, email, SESSION_HOURS * 3600);
  logAction_(email, '', 'Đăng nhập', '', 'OK', '');
  return { token: token, user: publicUser_(u) };
}

function requireUser_(token) {
  if (!token) throw new Error('AUTH: Phiên đăng nhập hết hạn, vui lòng đăng nhập lại.');
  var email = CacheService.getScriptCache().get('sess_' + token);
  if (!email) throw new Error('AUTH: Phiên đăng nhập hết hạn, vui lòng đăng nhập lại.');
  var u = findUser_(email);
  if (!u || String(u.active) === 'false') throw new Error('AUTH: Tài khoản đã bị khóa.');
  CacheService.getScriptCache().put('sess_' + token, email, SESSION_HOURS * 3600);
  return u;
}

function publicUser_(u) {
  var s = getSettings_();
  return { email: u.email, name: u.name, role: u.role, roleLabel: ROLE_LABEL[u.role],
           canActivate: canActivate_(u, s) };
}

function canActivate_(u, s) {
  if (u.role === 'admin') return true;
  return u.role === 'approver' && (s.approvers || []).map(lower_).indexOf(lower_(u.email)) >= 0;
}

function changePin_(user, p) {
  var u = findUser_(user.email);
  if (hash_(u.salt, String(p.oldPin)) !== u.pinHash) throw new Error('Mã PIN cũ không đúng.');
  if (!/^\d{6,}$/.test(String(p.newPin))) throw new Error('Mã PIN mới cần ít nhất 6 chữ số.');
  upsertUser_({ email: u.email, name: u.name, role: u.role, pin: String(p.newPin), active: u.active });
  return true;
}

/* =========================== Database helpers =========================== */

function db_() {
  var id = PropertiesService.getScriptProperties().getProperty('DB_ID');
  if (!id) throw new Error('Chưa chạy setup().');
  return SpreadsheetApp.openById(id);
}

function sheet_(name) { return db_().getSheetByName(name); }

function rows_(name) {
  var sh = sheet_(name);
  var values = sh.getDataRange().getValues();
  var head = values.shift();
  return values.map(function (r, i) {
    var o = { _row: i + 2 };
    head.forEach(function (h, j) { o[h] = r[j]; });
    return o;
  });
}

/** JSON split across j1..jN cells (a cell holds max 50k chars). */
function packJson_(obj, n) {
  var s = JSON.stringify(obj);
  var parts = [];
  for (var i = 0; i < n; i++) parts.push(s.substr(i * 45000, 45000));
  if (s.length > n * 45000) throw new Error('Dữ liệu quá lớn để lưu.');
  return parts;
}

function unpackJson_(row) {
  var s = '';
  for (var i = 1; i <= 8; i++) if (row['j' + i]) s += row['j' + i];
  return s ? JSON.parse(s) : null;
}

function upsertRow_(name, keyField, keyValue, values) {
  var sh = sheet_(name);
  var head = SHEETS[name];
  var arr = head.map(function (h) { return values[h] === undefined ? '' : values[h]; });
  var found = sh.getRange(2, head.indexOf(keyField) + 1, Math.max(sh.getLastRow() - 1, 1), 1)
    .createTextFinder(String(keyValue)).matchEntireCell(true).findNext();
  if (found && sh.getLastRow() > 1) sh.getRange(found.getRow(), 1, 1, arr.length).setValues([arr]);
  else sh.appendRow(arr);
}

function deleteRow_(name, keyField, keyValue) {
  var sh = sheet_(name);
  if (sh.getLastRow() < 2) return;
  var found = sh.getRange(2, SHEETS[name].indexOf(keyField) + 1, sh.getLastRow() - 1, 1)
    .createTextFinder(String(keyValue)).matchEntireCell(true).findNext();
  if (found) sh.deleteRow(found.getRow());
}

function lower_(s) { return String(s || '').trim().toLowerCase(); }
function nowIso_() { return Utilities.formatDate(new Date(), 'Asia/Ho_Chi_Minh', "yyyy-MM-dd'T'HH:mm:ss"); }

/* =========================== Settings =========================== */

function getSettingsRaw_() {
  var r = rows_('Settings').filter(function (x) { return x.key === 'config'; })[0];
  return r ? unpackJson_(r) : null;
}

function getSettings_() {
  var s = getSettingsRaw_() || defaultSettings_();
  var d = defaultSettings_();
  Object.keys(d).forEach(function (k) { if (s[k] === undefined) s[k] = d[k]; });
  return s;
}

function putSetting_(key, obj) {
  var parts = packJson_(obj, 2);
  upsertRow_('Settings', 'key', key, { key: key, j1: parts[0], j2: parts[1] });
}

function saveSettings_(user, p) {
  var s = p.settings;
  if (!s || !s.accounts || !s.limits) throw new Error('Cấu hình không hợp lệ.');
  putSetting_('config', s);
  logAction_(user.email, '', 'Sửa cấu hình', '', 'OK', '');
  return getSettings_();
}

/* =========================== Users =========================== */

function findUser_(email) {
  return rows_('Users').filter(function (u) { return lower_(u.email) === lower_(email); })[0] || null;
}

function upsertUser_(u) {
  var existing = findUser_(u.email);
  var salt = existing ? existing.salt : Utilities.getUuid();
  var pinHash = existing ? existing.pinHash : '';
  if (u.pin) { salt = Utilities.getUuid(); pinHash = hash_(salt, u.pin); }
  upsertRow_('Users', 'email', lower_(u.email), {
    email: lower_(u.email), name: u.name || '', role: u.role, salt: salt, pinHash: pinHash,
    active: u.active === false || u.active === 'false' ? 'false' : 'true',
    createdAt: existing ? existing.createdAt : nowIso_()
  });
}

function listUsers_() {
  var s = getSettings_();
  return rows_('Users').map(function (u) {
    return { email: u.email, name: u.name, role: u.role, active: String(u.active) !== 'false',
             approver: (s.approvers || []).map(lower_).indexOf(lower_(u.email)) >= 0 };
  });
}

function saveUser_(admin, p) {
  var u = p.user;
  if (!u || !/^\S+@\S+\.\S+$/.test(u.email || '')) throw new Error('Email không hợp lệ.');
  if (!ROLES[u.role]) throw new Error('Vai trò không hợp lệ.');
  if (u.pin && !/^\d{6,}$/.test(String(u.pin))) throw new Error('Mã PIN cần ít nhất 6 chữ số.');
  if (!findUser_(u.email) && !u.pin) throw new Error('Thành viên mới cần mã PIN.');
  upsertUser_(u);
  var s = getSettings_();
  var list = (s.approvers || []).map(lower_).filter(function (e) { return e !== lower_(u.email); });
  if (u.approver) list.push(lower_(u.email));
  s.approvers = list;
  putSetting_('config', s);
  logAction_(admin.email, '', 'Cập nhật thành viên', u.email, 'OK', ROLE_LABEL[u.role] + (u.approver ? ', được bật chạy' : ''));
  return listUsers_();
}

/* =========================== Bootstrap =========================== */

function bootstrap_(user) {
  seedLocalDashboards_();
  return {
    user: publicUser_(user),
    settings: getSettings_(),
    library: loadLibrary_(),
    status: STATUS,
    roles: ROLE_LABEL
  };
}

/* =========================== Orders =========================== */

function newOrderId_() {
  var d = Utilities.formatDate(new Date(), 'Asia/Ho_Chi_Minh', 'yyyyMMdd');
  var n = rows_('Orders').filter(function (r) { return String(r.id).indexOf('DH-' + d) === 0; }).length + 1;
  return 'DH-' + d + '-' + ('00' + n).slice(-3);
}

function listOrders_() {
  return rows_('Orders').map(function (r) {
    var o = unpackJson_(r) || {};
    return { id: r.id, status: r.status, name: r.name, account: r.account, createdBy: r.createdBy,
             createdAt: r.createdAt, updatedAt: r.updatedAt,
             adsets: (o.adsets || []).length, ads: countMetaAds(o), budget: totalDailyBudget(o),
             error: o.build && o.build.error || '', campaignId: o.meta && o.meta.campaignId || '',
             metaNote: o.metaNote || '', metaCheckedAt: o.metaCheckedAt || '' };
  }).reverse();
}

function getOrder_(id) {
  var r = rows_('Orders').filter(function (x) { return x.id === id; })[0];
  if (!r) throw new Error('Không tìm thấy đơn ' + id);
  var o = unpackJson_(r);
  o.status = r.status;
  return o;
}

function writeOrder_(o) {
  o.updatedAt = nowIso_();
  var parts = packJson_(o, 8);
  var v = { id: o.id, status: o.status, name: o.campaign && o.campaign.name || '', account: o.campaign && o.campaign.account || '',
            createdBy: o.createdBy, createdAt: o.createdAt, updatedAt: o.updatedAt };
  parts.forEach(function (p, i) { v['j' + (i + 1)] = p; });
  upsertRow_('Orders', 'id', o.id, v);
  return o;
}

var EDITABLE = [STATUS.DRAFT, STATUS.ERROR];

function saveOrder_(user, p) {
  var incoming = p.order;
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    var o;
    if (!incoming.id) {
      if (user.role === 'content') throw new Error('Người viết nội dung không tạo được đơn mới.');
      o = { id: newOrderId_(), status: STATUS.DRAFT, createdBy: user.email, createdAt: nowIso_(), meta: {}, build: {} };
    } else {
      o = getOrder_(incoming.id);
      if (EDITABLE.indexOf(o.status) < 0) throw new Error('Đơn đang ở trạng thái "' + o.status + '", không sửa được.');
    }
    if (user.role === 'content') {
      // content writers may only touch the ads section
      o.ads = sanitizeAds_(incoming.ads);
    } else {
      o.campaign = incoming.campaign || {};
      o.adsets = incoming.adsets || [];
      o.ads = sanitizeAds_(incoming.ads);
      o.clonedFrom = incoming.clonedFrom || o.clonedFrom || '';
    }
    if (o.status === STATUS.ERROR) { o.status = STATUS.DRAFT; if (o.build) o.build.error = ''; }
    writeOrder_(o);
    logAction_(user.email, o.id, 'Lưu đơn', '', 'OK', o.campaign && o.campaign.name || '');
    return o;
  } finally { lock.releaseLock(); }
}

function sanitizeAds_(ads) {
  return (ads || []).map(function (a) {
    return { key: a.key, name: a.name || '', runIn: a.runIn && a.runIn.length ? a.runIn : ['all'], source: a.source || 'drive',
             driveUrl: a.driveUrl || '', thumbUrl: a.thumbUrl || '', postId: a.postId || '', message: a.message || '',
             title: a.title || '', formId: a.formId || '', cta: a.cta || '', note: a.note || '' };
  });
}

function cloneOrder_(user, p) {
  var src = getOrder_(p.id);
  var o = { campaign: src.campaign, adsets: src.adsets, ads: src.ads, clonedFrom: src.id };
  o.campaign = JSON.parse(JSON.stringify(o.campaign || {}));
  o.campaign.name = (o.campaign.name || '') + ' – bản sao';
  return saveOrder_(user, { order: o });
}

function deleteOrder_(user, p) {
  var o = getOrder_(p.id);
  if ([STATUS.DRAFT, STATUS.ERROR].indexOf(o.status) < 0 || (o.meta && o.meta.campaignId)) {
    throw new Error('Chỉ xóa được đơn nháp chưa dựng trên Meta.');
  }
  deleteRow_('Orders', 'id', o.id);
  logAction_(user.email, o.id, 'Xóa đơn', '', 'OK', '');
  return true;
}

function submitOrder_(user, p) {
  var o = getOrder_(p.id);
  if (o.status !== STATUS.DRAFT) throw new Error('Chỉ gửi được đơn ở trạng thái Nháp.');
  var v = validateOrder(o, loadContext_());
  if (v.errors.length) throw new Error('Còn lỗi cần sửa: ' + v.errors.map(function (e) { return e.msg; }).join(' · '));
  o.status = STATUS.QUEUED;
  o.submittedBy = user.email;
  o.submittedAt = nowIso_();
  o.build = { step: 'campaign', log: [], error: '' };
  writeOrder_(o);
  logAction_(user.email, o.id, 'Hoàn thành đơn → chờ dựng', '', 'OK', v.warnings.map(function (w) { return w.msg; }).join(' · '));
  return o;
}

function retryOrder_(user, p) {
  var o = getOrder_(p.id);
  if (o.status !== STATUS.ERROR) throw new Error('Chỉ chạy lại đơn bị lỗi.');
  o.status = STATUS.QUEUED;
  o.build.error = '';
  writeOrder_(o);
  logAction_(user.email, o.id, 'Chạy lại dựng camp', '', 'OK', '');
  return o;
}

/* =========================== Log =========================== */

function logAction_(user, orderId, action, objectId, result, detail) {
  try {
    sheet_('Log').appendRow([nowIso_(), user || 'Hệ thống', orderId || '', action, objectId || '', result || '', String(detail || '').slice(0, 2000)]);
  } catch (e) { Logger.log('log fail ' + e); }
}

function listLog_(orderId) {
  var all = rows_('Log');
  if (orderId) all = all.filter(function (r) { return r.orderId === orderId; });
  return all.slice(-300).reverse().map(function (r) {
    return { time: r.time instanceof Date ? Utilities.formatDate(r.time, 'Asia/Ho_Chi_Minh', 'yyyy-MM-dd HH:mm') : String(r.time).replace('T', ' ').slice(0, 16),
             user: r.user, orderId: r.orderId, action: r.action, objectId: r.objectId, result: r.result, detail: r.detail };
  });
}

function notify_(o, subject, body) {
  try {
    var s = getSettings_();
    var to = [o.createdBy, o.submittedBy].concat(s.notifyEmails || []).concat(s.approvers || [])
      .filter(function (e, i, a) { return e && a.indexOf(e) === i; });
    if (!to.length) return;
    MailApp.sendEmail({ to: to.join(','), subject: '[' + APP_NAME + '] ' + subject, body: body + '\n\nMở app: ' + ScriptApp.getService().getUrl() });
  } catch (e) { Logger.log('mail fail ' + e); }
}

/** Industry from a campaign name: exactly one match → that industry, several → "Đa ngành". */
function industryFromName(name, industries) {
  var low = String(name || '').toLowerCase();
  var hits = (industries || []).filter(function (i) {
    return [i.name].concat(i.keywords || []).some(function (k) { return k && low.indexOf(String(k).toLowerCase()) >= 0; });
  });
  if (hits.length === 1) return hits[0];
  return (industries || []).filter(function (i) { return i.name === 'Đa ngành'; })[0] || null;
}

/** One-time: a gitignored Local.gs may define LOCAL_DASHBOARDS; copy them into settings so they survive later deploys. */
function seedLocalDashboards_() {
  try {
    if (typeof LOCAL_DASHBOARDS === 'undefined' || !LOCAL_DASHBOARDS.length) return;
    var s = getSettings_();
    if (s.dashboards && s.dashboards.length) return;
    s.dashboards = LOCAL_DASHBOARDS;
    putSetting_('config', s);
  } catch (e) { Logger.log('seed dashboards: ' + e); }
}
