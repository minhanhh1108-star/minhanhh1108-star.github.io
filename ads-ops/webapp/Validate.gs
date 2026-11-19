/**
 * Order validation. Returns {errors:[{scope,msg}], warnings:[...], summary}.
 * Errors block "Hoàn thành"; warnings are shown but allowed.
 */

function loadContext_() {
  return { settings: getSettings_(), library: loadLibrary_(), live: listLive_(), orders: listOrders_() };
}

function adsetKeysFor(ad, order) {
  var keys = (order.adsets || []).filter(function (g) { return g.name; }).map(function (g) { return g.key; });
  if (!ad.runIn || !ad.runIn.length || ad.runIn.indexOf('all') >= 0) return keys;
  return keys.filter(function (k) { return ad.runIn.indexOf(k) >= 0; });
}

function countMetaAds(order) {
  return (order.ads || []).filter(function (a) { return a.name; })
    .reduce(function (n, a) { return n + adsetKeysFor(a, order).length; }, 0);
}

function totalDailyBudget(order) {
  var c = order.campaign || {};
  if (c.budgetMode === 'adset') {
    return (order.adsets || []).reduce(function (s, g) { return s + (Number(g.dailyBudget) || 0); }, 0);
  }
  return Number(c.dailyBudget) || 0;
}

function hasSchedule(order) {
  return (order.adsets || []).some(function (g) { return g.slots && g.slots.length; });
}

function parseLocal_(s) {
  if (!s) return null;
  var m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 7, +m[5])); // Asia/Ho_Chi_Minh (UTC+7)
}

function validateOrder(order, ctx) {
  var E = [], W = [];
  var err = function (scope, msg) { E.push({ scope: scope, msg: scope + ': ' + msg }); };
  var warn = function (scope, msg) { W.push({ scope: scope, msg: scope + ': ' + msg }); };
  var s = ctx.settings, L = s.limits, lib = ctx.library || { audiences: [], forms: [] };
  var c = order.campaign || {};
  var acc = (s.accounts || []).filter(function (a) { return a.id === c.account; })[0];
  var isNew = [STATUS.DRAFT, STATUS.QUEUED].indexOf(order.status || STATUS.DRAFT) >= 0;

  // ---------- campaign
  if (!c.name) err('Chiến dịch', 'thiếu tên');
  if (!acc) err('Chiến dịch', 'chưa chọn tài khoản');
  if (!c.budgetMode) err('Chiến dịch', 'chưa chọn nơi đặt ngân sách');
  if (c.budgetMode === 'campaign' && !(Number(c.dailyBudget) > 0)) err('Chiến dịch', 'thiếu ngân sách chiến dịch');
  var named = (order.adsets || []).filter(function (g) { return g.name; });
  if (!named.length) err('Chiến dịch', 'chưa có nhóm quảng cáo');
  var nAds = countMetaAds(order);
  if (!nAds) err('Chiến dịch', 'chưa có quảng cáo');
  var total = totalDailyBudget(order);
  if (total && (total < L.minDaily || total > L.maxDailyPerCampaign)) {
    err('Chiến dịch', 'tổng ngân sách ' + fmt_(total) + 'đ/ngày ngoài giới hạn ' + fmt_(L.minDaily) + '–' + fmt_(L.maxDailyPerCampaign));
  }
  if (total && total < L.singleAdsetBelow && named.length > 1) {
    warn('Chiến dịch', 'ngân sách ' + fmt_(total) + 'đ/ngày mà chia ' + named.length + ' nhóm, nên gộp 1 nhóm');
  }
  if (isNew && ctx.orders) {
    var today = Utilities.formatDate(new Date(), 'Asia/Ho_Chi_Minh', 'yyyy-MM-dd');
    var usedToday = ctx.orders.filter(function (o) {
      return o.id !== order.id && [STATUS.QUEUED, STATUS.BUILDING, STATUS.BUILT, STATUS.ACTIVE].indexOf(o.status) >= 0 &&
        String(o.updatedAt).slice(0, 10) === today;
    }).reduce(function (sum, o) { return sum + (o.budget || 0); }, 0);
    if (usedToday + total > L.maxNewPerDay) {
      err('Chiến dịch', 'tổng ngân sách camp mới hôm nay sẽ là ' + fmt_(usedToday + total) + 'đ, vượt trần ' + fmt_(L.maxNewPerDay) + 'đ (sửa trần ở Cài đặt nếu chủ động)');
    }
  }
  if (hasSchedule(order)) warn('Chiến dịch', 'có khung giờ chạy nên Meta sẽ dùng ngân sách trọn đời (ngân sách/ngày × số ngày)');

  // ---------- ad sets
  var audByCode = {};
  lib.audiences.forEach(function (a) { audByCode[a.code] = a; });
  var liveAudRegions = {};
  (ctx.live || []).forEach(function (cp) {
    (cp.adsets || []).forEach(function (g) {
      (g.audienceIds || []).forEach(function (id) { (g.regionKeys || []).forEach(function (rk) { liveAudRegions[id + '|' + rk] = cp.name; }); });
    });
  });
  named.forEach(function (g, i) {
    var sc = 'Nhóm "' + g.name + '"';
    var auds = (g.audiences || []);
    var detail = (g.interests || []).length + (g.behaviors || []).length;
    if (!auds.length && !detail) warn(sc, 'không chọn tệp đối tượng hay sở thích/hành vi = nhắm rộng');
    if (auds.length && detail) warn(sc, 'có cả tệp đối tượng và sở thích/hành vi: Meta chỉ nhắm phần giao nhau, tệp sẽ hẹp');
    auds.concat(g.excludes || []).forEach(function (code) {
      var a = audByCode[code];
      if (!a) { err(sc, 'tệp ' + code + ' không có trong thư viện'); return; }
      if (acc && a.account !== acc.id) err(sc, 'tệp ' + code + ' thuộc tài khoản khác');
      if (a.ageDays !== null && a.ageDays > L.audienceMaxDays) warn(sc, 'tệp ' + code + ' đã ' + a.ageDays + ' ngày (cũ)');
    });
    var regions = (g.regions && g.regions.length) ? g.regions : (c.region ? [c.region] : []);
    if (!regions.length) err(sc, 'chưa chọn địa điểm');
    auds.forEach(function (code) {
      var a = audByCode[code];
      (a && a.ids || []).forEach(function (id) {
        regions.forEach(function (rk) {
          if (liveAudRegions[id + '|' + rk]) warn(sc, 'trùng tệp và khu vực với camp đang chạy "' + liveAudRegions[id + '|' + rk] + '"');
        });
      });
    });
    var ageMin = Number(g.ageMin || s.defaults.ageMin), ageMax = Number(g.ageMax || s.defaults.ageMax);
    if (ageMin < 18 || ageMax > 65 || ageMin > ageMax) err(sc, 'tuổi không hợp lệ');
    var st = parseLocal_(g.start), en = parseLocal_(g.end);
    if (!st) err(sc, 'thiếu ngày giờ bắt đầu');
    if (st && isNew && st < new Date()) warn(sc, 'thời điểm bắt đầu đã qua, Meta sẽ chạy ngay khi bật');
    if (en && st && en <= st) err(sc, 'kết thúc phải sau bắt đầu');
    if (g.slots && g.slots.length && !en) err(sc, 'có khung giờ chạy thì cần ngày giờ kết thúc');
    if (c.budgetMode === 'adset' && !(Number(g.dailyBudget) > 0)) err(sc, 'thiếu ngân sách nhóm');
    var cnt = (order.ads || []).filter(function (a) { return a.name && adsetKeysFor(a, order).indexOf(g.key) >= 0; }).length;
    if (!cnt) err(sc, 'chưa có quảng cáo nào chạy trong nhóm');
    if (hasSchedule(order) && !en) err(sc, 'camp có khung giờ (ngân sách trọn đời) nên mọi nhóm cần ngày giờ kết thúc');
  });

  // ---------- ads
  var folderExtra = 0;
  var formById = {};
  lib.forms.forEach(function (f) { formById[f.id] = f; });
  (order.ads || []).forEach(function (a) {
    if (!a.name && !a.driveUrl && !a.postId && !a.message) return;
    var sc = 'Quảng cáo "' + (a.name || '(chưa đặt tên)') + '"';
    if (!a.name) err(sc, 'thiếu tên');
    if (!adsetKeysFor(a, order).length) err(sc, 'chưa chọn nhóm để chạy');
    if (a.source === 'post') {
      if (!/^\d+_\d+$/.test(String(a.postId || '').trim())) err(sc, 'ID bài viết phải có dạng IDtrang_IDbài');
      if (acc && a.postId && String(a.postId).split('_')[0] !== acc.pageId) err(sc, 'bài viết không thuộc trang ' + acc.pageName);
    } else {
      if (!/drive\.google\.com|docs\.google\.com/.test(a.driveUrl || '')) err(sc, 'link video/ảnh phải là link Google Drive');
      else if (!ctx.skipDrive) {
        try {
          var ref = driveRef_(a.driveUrl);
          if (ref.type === 'folder') {
            var n = folderMedia_(ref.id).length;
            if (!n) err(sc, 'thư mục Drive không có video hoặc ảnh');
            else { folderExtra += (n - 1) * adsetKeysFor(a, order).length; warn(sc, 'link thư mục: ' + n + ' video/ảnh → ' + n + ' quảng cáo cho mỗi nhóm'); }
          } else {
            var mt = DriveApp.getFileById(ref.id).getMimeType();
            if (!/^(video|image)\//.test(mt)) err(sc, 'file Drive không phải video hoặc ảnh');
          }
        } catch (ex) { err(sc, 'không mở được link Drive (chia sẻ file/thư mục cho email chủ app)'); }
      }
      if (a.thumbUrl && !/drive\.google\.com|docs\.google\.com/.test(a.thumbUrl)) err(sc, 'link ảnh bìa phải là link Google Drive');
      if (!a.message) err(sc, 'thiếu nội dung chính');
      if (!a.formId) err(sc, 'chưa chọn biểu mẫu');
      var f = formById[a.formId];
      if (a.formId && !f) err(sc, 'biểu mẫu không có trong thư viện');
      if (f && acc && f.pageId !== acc.pageId) err(sc, 'biểu mẫu thuộc trang khác (' + f.pageName + ')');
      if (a.message && a.message.length > L.primaryTextChars) warn(sc, 'nội dung dài ' + a.message.length + ' ký tự, người xem chỉ thấy ' + L.primaryTextChars + ' ký tự đầu');
    }
  });

  var uniq = function (list) { var seen = {}; return list.filter(function (x) { return seen[x.msg] ? false : (seen[x.msg] = 1); }); };
  return {
    errors: uniq(E), warnings: uniq(W),
    summary: { adsets: named.length, adTemplates: (order.ads || []).filter(function (a) { return a.name; }).length,
               metaAds: nAds + folderExtra, dailyBudget: total, lifetime: hasSchedule(order) }
  };
}

function fmt_(n) { return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, '.'); }
