/**
 * Sync from Meta: library (audiences, lead forms) and live campaigns (+ 7-day metrics).
 * Also: clone a live campaign into a new order, pause a live campaign.
 */

/* =========================== Library =========================== */

function slug_(s) {
  s = String(s || '').replace(/đ/g, 'd').replace(/Đ/g, 'D').normalize('NFD').replace(/[̀-ͯ]/g, '');
  s = s.replace(/\.csv/gi, '')
       .replace(/(\d{1,2})[.\/](\d{1,2})[.\/](\d{2,4})/g, function (m, d, mo) { return ('0' + d).slice(-2) + ('0' + mo).slice(-2); })
       .replace(/(\d{1,2})[.\/](\d{1,2})/g, function (m, d, mo) { return ('0' + d).slice(-2) + ('0' + mo).slice(-2); });
  var seen = {}, words = [];
  (s.match(/[A-Za-z0-9]+/g) || []).forEach(function (w) {
    var k = w.toLowerCase();
    if (seen[k]) return;
    seen[k] = 1;
    words.push(/^\d+$/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
  });
  return words.join('-').slice(0, 28).replace(/-+$/, '');
}

function pct_(name) {
  var m = String(name).match(/(\d+)% to (\d+)%/);
  if (m) return [Number(m[1]), Number(m[2])];
  m = String(name).match(/\((?:[A-Z]{2}, )?(\d+)%\)/);
  return m ? [Number(m[1]), Number(m[1])] : [null, null];
}

function syncLibrary() {
  var s = getSettings_();
  var all = {};
  var perAcc = {};
  s.accounts.forEach(function (acc) {
    perAcc[acc.id] = gall(acc.id + '/customaudiences', {
      fields: 'id,name,subtype,approximate_count_lower_bound,time_updated,time_content_updated,delivery_status,lookalike_spec', limit: 200 });
    perAcc[acc.id].forEach(function (a) { all[a.id] = a; });
  });
  var lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    s.accounts.forEach(function (acc) {
      var list = [], used = {};
      var groups = {};
      perAcc[acc.id].forEach(function (a) {
        if (a.subtype !== 'LOOKALIKE') return;
        var origin = ((a.lookalike_spec || {}).origin || [{}])[0];
        var gk = origin.id || a.name;
        (groups[gk] = groups[gk] || { seed: origin.name || a.name, items: [] }).items.push(a);
      });
      var uniq = function (base) { var c = base; while (used[c]) c += 'x'; used[c] = 1; return c; };
      Object.keys(groups).forEach(function (oid) {
        var g = groups[oid];
        var ps = g.items.map(function (a) { return pct_(a.name); });
        var lo = Math.min.apply(null, ps.map(function (p) { return p[0]; }).filter(function (x) { return x !== null; }).concat([999]));
        var hi = Math.max.apply(null, ps.map(function (p) { return p[1]; }).filter(function (x) { return x !== null; }).concat([-1]));
        var seed = all[oid];
        var ts = seed && (seed.time_content_updated || seed.time_updated);
        var okAll = g.items.every(function (a) { return (a.delivery_status || {}).code === 200; });
        g.items.sort(function (x, y) { return (pct_(x.name)[0] || 0) - (pct_(y.name)[0] || 0); });
        list.push({ code: uniq(acc.audPrefix + '-LAL-' + slug_(g.seed)), account: acc.id, type: 'Tương tự',
                    desc: (lo <= hi ? 'Tương tự ' + lo + '–' + hi + '%' : 'Tương tự') + ' từ: ' + g.seed + (okAll ? '' : ' (có tệp quá nhỏ)'),
                    ids: g.items.map(function (a) { return a.id; }), count: g.items.length,
                    updated: ts ? Utilities.formatDate(new Date(ts * 1000), 'Asia/Ho_Chi_Minh', 'yyyy-MM-dd') : '' });
      });
      perAcc[acc.id].forEach(function (a) {
        if (a.subtype === 'LOOKALIKE') return;
        var ts = a.time_content_updated || a.time_updated;
        var ok = (a.delivery_status || {}).code === 200;
        list.push({ code: uniq(acc.audPrefix + '-KH-' + slug_(a.name)), account: acc.id,
                    type: a.subtype === 'ENGAGEMENT' ? 'Tương tác' : 'Khách hàng',
                    desc: a.name + (ok ? '' : ' (quá nhỏ)'), ids: [a.id], count: 1,
                    size: a.approximate_count_lower_bound || null,
                    updated: ts ? Utilities.formatDate(new Date(ts * 1000), 'Asia/Ho_Chi_Minh', 'yyyy-MM-dd') : '' });
      });
      list.sort(function (x, y) { return (x.type === 'Tương tự' ? 0 : 1) - (y.type === 'Tương tự' ? 0 : 1) || String(y.updated).localeCompare(String(x.updated)); });
      var parts = packJson_(list, 2);
      upsertRow_('Library', 'key', 'aud_' + acc.id, { kind: 'audiences', key: 'aud_' + acc.id, account: acc.id, updatedAt: nowIso_(), j1: parts[0], j2: parts[1] });
    });
    var QMAP = { FULL_NAME: 'Họ tên', PHONE: 'Số điện thoại', EMAIL: 'Email', CITY: 'Thành phố', COMPANY_NAME: 'Tên công ty',
                 JOB_TITLE: 'Chức danh', PROVINCE: 'Tỉnh/thành', STATE: 'Tỉnh/thành' };
    var pages = {};
    s.accounts.forEach(function (acc) { pages[acc.pageId] = acc.pageName; });
    Object.keys(pages).forEach(function (pid) {
      var forms = gall(pid + '/leadgen_forms', { fields: 'id,name,status,leads_count,created_time,questions,is_optimized_for_quality', limit: 100 }, pageToken_(pid));
      var list = forms.filter(function (f) { return f.status === 'ACTIVE'; }).map(function (f) {
        return { id: f.id, name: f.name, pageId: pid, pageName: pages[pid], leads: Number(f.leads_count || 0),
                 created: String(f.created_time || '').slice(0, 10), type: f.is_optimized_for_quality ? 'Ý định cao hơn' : 'Nhiều lượt gửi hơn',
                 questions: (f.questions || []).map(function (q) { return QMAP[q.type] || q.label || q.key || q.type; }).join('; ') };
      }).sort(function (a, b) { return b.leads - a.leads || String(b.created).localeCompare(String(a.created)); });
      var parts = packJson_(list, 2);
      upsertRow_('Library', 'key', 'form_' + pid, { kind: 'forms', key: 'form_' + pid, account: pid, updatedAt: nowIso_(), j1: parts[0], j2: parts[1] });
    });
  } finally { lock.releaseLock(); }
  logAction_('Hệ thống', '', 'Đồng bộ thư viện', '', 'OK', '');
  return loadLibrary_();
}

function loadLibrary_() {
  var today = new Date();
  var out = { audiences: [], forms: [], updatedAt: '' };
  rows_('Library').forEach(function (r) {
    var list = unpackJson_(r) || [];
    if (r.kind === 'audiences') out.audiences = out.audiences.concat(list);
    if (r.kind === 'forms') out.forms = out.forms.concat(list);
    out.updatedAt = String(r.updatedAt).slice(0, 16).replace('T', ' ');
  });
  out.audiences.forEach(function (a) {
    a.ageDays = a.updated ? Math.floor((today - new Date(a.updated + 'T00:00:00+07:00')) / 86400000) : null;
  });
  return out;
}

/* =========================== Live campaigns =========================== */

function syncLive() {
  var s = getSettings_();
  var lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    var keep = {};
    s.accounts.forEach(function (acc) {
      var ins = {};
      gall(acc.id + '/insights', { level: 'ad', date_preset: 'last_7d', limit: 500,
        fields: 'ad_id,spend,impressions,frequency,clicks,ctr,cpm,actions' }).forEach(function (r) { ins[r.ad_id] = r; });
      var camps = gall(acc.id + '/campaigns', { effective_status: '["ACTIVE"]', limit: 100,
        fields: 'name,objective,daily_budget,lifetime_budget,status,start_time' });
      camps.forEach(function (c) {
        var adsets = gall(c.id + '/adsets', { effective_status: '["ACTIVE"]', limit: 50,
          fields: 'name,status,daily_budget,lifetime_budget,promoted_object,start_time,end_time,targeting,adset_schedule' });
        var ads = gall(c.id + '/ads', { effective_status: '["ACTIVE"]', limit: 100,
          fields: 'name,status,adset_id,creative{effective_object_story_id,video_id,title,body,call_to_action_type,object_story_spec}' });
        var cp = { id: c.id, account: acc.id, accountName: acc.name, name: c.name, objective: c.objective,
                   dailyBudget: Number(c.daily_budget || 0), lifetimeBudget: Number(c.lifetime_budget || 0),
                   start: c.start_time, adsets: [], spend: 0, leads: 0 };
        adsets.forEach(function (g) {
          var t = g.targeting || {};
          var geo = t.geo_locations || {};
          var regionKeys = (geo.regions || []).map(function (x) { return String(x.key); }).concat((geo.countries || []).indexOf('VN') >= 0 ? ['VN'] : []);
          var set = { id: g.id, name: g.name, dailyBudget: Number(g.daily_budget || 0), start: g.start_time, end: g.end_time || '',
                      pageId: (g.promoted_object || {}).page_id || '', ageMin: t.age_min, ageMax: t.age_max,
                      gender: (t.genders || []).length === 1 ? (t.genders[0] === 1 ? 'male' : 'female') : 'all',
                      regionKeys: regionKeys, regionNames: (geo.regions || []).map(function (x) { return x.name; }),
                      audienceIds: (t.custom_audiences || []).map(function (a) { return a.id; }),
                      excludeIds: (t.excluded_custom_audiences || []).map(function (a) { return a.id; }),
                      advantage: !!((t.targeting_automation || {}).advantage_audience),
                      geoExpand: !!(((t.targeting_automation || {}).individual_setting || {}).geo),
                      schedule: g.adset_schedule || [], ads: [], spend: 0, leads: 0 };
          ads.filter(function (a) { return a.adset_id === g.id; }).forEach(function (a) {
            var cr = a.creative || {}, vd = ((cr.object_story_spec || {}).video_data) || {};
            var i = ins[a.id] || {};
            var sp = Number(i.spend || 0), ld = leadCount_(i);
            set.ads.push({ id: a.id, name: a.name, postId: cr.effective_object_story_id || '', videoId: cr.video_id || vd.video_id || '',
                           title: cr.title || vd.title || '', body: cr.body || vd.message || '',
                           formId: ((vd.call_to_action || {}).value || {}).lead_gen_form_id || '',
                           spend: sp, leads: ld, ctr: Number(i.ctr || 0), cpm: Number(i.cpm || 0), frequency: Number(i.frequency || 0) });
            set.spend += sp; set.leads += ld;
          });
          cp.adsets.push(set);
          cp.spend += set.spend; cp.leads += set.leads;
        });
        var parts = packJson_(cp, 4);
        upsertRow_('Live', 'campaignId', c.id, { campaignId: c.id, account: acc.id, updatedAt: nowIso_(), j1: parts[0], j2: parts[1], j3: parts[2], j4: parts[3] });
        keep[c.id] = 1;
      });
    });
    // drop campaigns no longer active
    var sh = sheet_('Live');
    rows_('Live').reverse().forEach(function (r) { if (!keep[r.campaignId]) sh.deleteRow(r._row); });
  } finally { lock.releaseLock(); }
  return listLive_();
}

function listLive_() {
  return rows_('Live').map(function (r) {
    var c = unpackJson_(r) || {};
    c.updatedAt = String(r.updatedAt).slice(0, 16).replace('T', ' ');
    return c;
  });
}

function pauseLive_(user, p) {
  if (!canActivate_(user, getSettings_())) throw new Error('Bạn chưa được giao quyền bật/tạm dừng.');
  gpost(p.campaignId, { status: 'PAUSED' });
  logAction_(user.email, '', 'Tạm dừng camp đang chạy', p.campaignId, 'OK', p.name || '');
  deleteRow_('Live', 'campaignId', p.campaignId);
  return true;
}

/* =========================== Clone live → order =========================== */

function cloneLive_(user, p) {
  var cp = listLive_().filter(function (c) { return c.id === p.campaignId; })[0];
  if (!cp) throw new Error('Không thấy camp trong danh sách đang chạy, bấm "Đồng bộ" rồi thử lại.');
  var lib = loadLibrary_();
  var codeById = {};
  lib.audiences.filter(function (a) { return a.account === cp.account; })
    .forEach(function (a) { a.ids.forEach(function (id) { codeById[id] = a.code; }); });
  var codes = function (ids) {
    var out = [];
    ids.forEach(function (id) { var c = codeById[id]; if (c && out.indexOf(c) < 0) out.push(c); });
    return out;
  };
  var s = getSettings_();
  var industry = (industryFromName(cp.name, s.industries) || {}).name || 'Đa ngành';
  var order = {
    clonedFrom: 'Meta ' + cp.id,
    campaign: { name: cp.name + ' – bản sao', account: cp.account, industry: industry,
                region: (cp.adsets[0] && cp.adsets[0].regionKeys[0]) || '', budgetMode: cp.dailyBudget ? 'campaign' : 'adset',
                dailyBudget: cp.dailyBudget || '', testVar: '', note: 'Nhân bản từ camp "' + cp.name + '"' },
    adsets: [], ads: []
  };
  var tplByKey = {};
  cp.adsets.forEach(function (g, i) {
    var key = 'g' + (i + 1);
    order.adsets.push({ key: key, name: g.name, audiences: codes(g.audienceIds), excludes: codes(g.excludeIds), audNote: '', excNote: '',
                        ageMin: g.ageMin, ageMax: g.ageMax, gender: g.gender, regions: g.regionKeys, regionNote: '',
                        advantage: g.advantage, geoExpand: g.geoExpand, dailyBudget: cp.dailyBudget ? '' : g.dailyBudget,
                        start: tomorrow8_(), end: '', slots: [], days: [], slotNote: '' });
    g.ads.forEach(function (a) {
      var k = a.postId || a.name;
      if (!tplByKey[k]) {
        tplByKey[k] = { key: 'a' + (Object.keys(tplByKey).length + 1), name: a.name, runIn: [], source: a.postId ? 'post' : 'drive',
                        postId: a.postId, driveUrl: '', thumbUrl: '', message: a.postId ? '' : a.body, title: a.title,
                        formId: a.formId, note: '' };
        order.ads.push(tplByKey[k]);
      }
      tplByKey[k].runIn.push(key);
    });
  });
  order.ads.forEach(function (a) { if (a.runIn.length === order.adsets.length) a.runIn = ['all']; });
  var o = saveOrder_(user, { order: order });
  logAction_(user.email, o.id, 'Nhân bản từ camp đang chạy', cp.id, 'OK', cp.name);
  return o;
}

function tomorrow8_() {
  return Utilities.formatDate(new Date(Date.now() + 86400000), 'Asia/Ho_Chi_Minh', 'yyyy-MM-dd') + 'T08:00';
}
