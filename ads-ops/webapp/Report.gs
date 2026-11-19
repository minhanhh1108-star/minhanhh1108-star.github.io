/**
 * Daily BU report → Telegram.
 *
 * Numbers (for "yesterday", Asia/Ho_Chi_Minh):
 *   Budget            = CRM sheet "Cập nhật ads hàng ngày", column "Ngân sách", rows of the BU's budget pages
 *                       (falls back to Meta spend of the BU's ad accounts when the CRM row is missing)
 *   SĐT               = Meta "Khách hàng tiềm năng" as Ads Manager's Kết quả column shows it:
 *                       action `lead` minus `onsite_conversion.lead` (checked against Ads Manager on 18/11: 13 − 2 = 11)
 *   Chi phí/SĐT       = Budget / SĐT
 *   Doanh số ngày     = deal sheet, tab "Deal T{M}{YYYY}", rows dated yesterday with BU in the BU's revenue BUs
 *   Chi phí ads tháng = CRM sheet, column "Tổng chi phí phát sinh", BU's cost pages, 1st of month → yesterday
 *   Doanh số tháng    = deal sheet, same tab, all rows of the BU's revenue BUs
 *
 * Telegram bot token lives only in Script Properties (TELEGRAM_TOKEN).
 */

function reportConfig_() {
  var s = getSettings_();
  var r = s.report || {};
  if ((!r.bus || !r.bus.length) && typeof LOCAL_REPORT !== 'undefined') {
    r = JSON.parse(JSON.stringify(LOCAL_REPORT));
    s.report = r;
    putSetting_('config', s);
  }
  r.bus = r.bus || [];
  r.hour = r.hour === undefined ? 8 : Number(r.hour);
  r.costTab = r.costTab || 'Cập nhật ads hàng ngày';
  r.dealTab = r.dealTab || 'Deal T{M}{YYYY}';
  return r;
}

function ymd_(d) { return Utilities.formatDate(d, 'Asia/Ho_Chi_Minh', 'yyyy-MM-dd'); }
function vnd_(n) { return fmt_(n); }

/** Date cell → 'yyyy-MM-dd'. Fixes day/month swapped entries (e.g. 03/11 read as 11 March) for the target month. */
function cellDay_(v, targetMonth) {
  var d = null;
  if (v instanceof Date) d = v;
  else if (typeof v === 'string') {
    var m = v.trim().match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
    if (m) d = new Date(Number(m[3].length === 2 ? '20' + m[3] : m[3]), Number(m[2]) - 1, Number(m[1]));
  }
  if (!d || isNaN(d)) return null;
  var y = Number(Utilities.formatDate(d, 'Asia/Ho_Chi_Minh', 'yyyy'));
  var mo = Number(Utilities.formatDate(d, 'Asia/Ho_Chi_Minh', 'M'));
  var da = Number(Utilities.formatDate(d, 'Asia/Ho_Chi_Minh', 'd'));
  if (targetMonth && mo !== targetMonth && da === targetMonth && mo <= 12) { var t = mo; mo = da; da = t; }
  return y + '-' + ('0' + mo).slice(-2) + '-' + ('0' + da).slice(-2);
}

function headerIndex_(row, names) {
  var low = row.map(function (h) { return String(h || '').trim().toLowerCase(); });
  for (var i = 0; i < names.length; i++) {
    var k = low.indexOf(names[i].toLowerCase());
    if (k >= 0) return k;
  }
  return -1;
}

function readCost_(cfg, monthStart, day) {
  var sh = findTab_(SpreadsheetApp.openById(cfg.crmSheetId), cfg.costTab, 'file CRM');
  var v = sh.getDataRange().getValues();
  var h = v[0];
  var iDay = headerIndex_(h, ['Ngày cập nhật']), iPage = headerIndex_(h, ['Tên Page/Kênh']);
  var iBudget = headerIndex_(h, ['Ngân sách']), iTotal = headerIndex_(h, ['Tổng Chi phí phát sinh']);
  if ([iDay, iPage, iBudget, iTotal].indexOf(-1) >= 0) throw new Error('Tab chi phí thiếu cột (Ngày cập nhật / Tên Page/Kênh / Ngân sách / Tổng Chi phí phát sinh).');
  var out = {};   // page → {budgetDay, totalMonth}
  var lastDay = '';
  for (var r = 1; r < v.length; r++) {
    var d = cellDay_(v[r][iDay]);
    if (!d || d < monthStart || d > day) continue;
    var page = String(v[r][iPage] || '').trim();
    var o = out[page] = out[page] || { budgetDay: null, totalMonth: 0 };
    o.totalMonth += Number(v[r][iTotal]) || 0;
    if (d === day) o.budgetDay = (o.budgetDay || 0) + (Number(v[r][iBudget]) || 0);
    if (d > lastDay) lastDay = d;
  }
  return { pages: out, lastDay: lastDay };
}

function readRevenue_(cfg, day, month, year) {
  var tab = cfg.dealTab.replace('{M}', month).replace('{YYYY}', year);
  var sh = findTab_(SpreadsheetApp.openById(cfg.revenueSheetId), tab, 'file doanh thu');
  var v = sh.getDataRange().getValues();
  var h = v[0];
  var iDay = headerIndex_(h, ['Ngày chốt Deal']), iRev = headerIndex_(h, ['Doanh thu']), iBu = headerIndex_(h, ['BU']);
  if ([iDay, iRev, iBu].indexOf(-1) >= 0) throw new Error('Tab "' + tab + '" thiếu cột (Ngày chốt Deal / Doanh thu / BU).');
  var out = {};   // BU → {day, month}
  for (var r = 1; r < v.length; r++) {
    var bu = String(v[r][iBu] || '').trim();
    var rev = Number(String(v[r][iRev]).replace(/[^\d.-]/g, '')) || 0;
    if (!bu || !rev) continue;
    var o = out[bu] = out[bu] || { day: 0, month: 0 };
    o.month += rev;
    if (cellDay_(v[r][iDay], month) === day) o.day += rev;
  }
  return { bus: out, tab: tab };
}

function metaDay_(accounts, day) {
  var spend = 0, leads = 0;
  accounts.forEach(function (acc) {
    var r = (gget(acc + '/insights', { time_range: JSON.stringify({ since: day, until: day }), fields: 'spend,actions' }).data || [])[0] || {};
    spend += Number(r.spend || 0);
    leads += sdtCount_(r);
  });
  return { spend: spend, leads: leads };
}

/** Builds the report text for every BU for `day` (default: yesterday). */
function buildDailyReport(dayStr) {
  var cfg = reportConfig_();
  if (!cfg.bus.length) throw new Error('Chưa cấu hình BU cho báo cáo (Cài đặt → Báo cáo Telegram).');
  if (!cfg.crmSheetId || !cfg.revenueSheetId) throw new Error('Chưa cấu hình file CRM / file doanh thu.');
  var day = dayStr || ymd_(new Date(Date.now() - 86400000));
  var y = Number(day.slice(0, 4)), m = Number(day.slice(5, 7)), dd = day.slice(8, 10);
  var monthStart = day.slice(0, 8) + '01';
  var cost = readCost_(cfg, monthStart, day);
  var rev = readRevenue_(cfg, day, m, y);
  var parts = cfg.bus.map(function (bu) {
    var meta = metaDay_(bu.accounts || [], day);
    var budget = null, notes = [];
    (bu.budgetPages || []).forEach(function (p) {
      var c = cost.pages[p];
      if (c && c.budgetDay !== null) budget = (budget || 0) + c.budgetDay;
    });
    if (budget === null) { budget = meta.spend; notes.push('Budget lấy từ Meta (file CRM chưa có ngày ' + dd + '/' + ('0' + m).slice(-2) + ')'); }
    var monthCost = (bu.costPages || []).reduce(function (s, p) { return s + ((cost.pages[p] || {}).totalMonth || 0); }, 0);
    var r = (bu.revenueBUs || []).reduce(function (o, b) {
      var x = rev.bus[b] || { day: 0, month: 0 };
      return { day: o.day + x.day, month: o.month + x.month };
    }, { day: 0, month: 0 });
    var ratio = r.month ? (monthCost / r.month * 100).toFixed(2).replace('.', ',') + '%' : 'chưa có doanh số';
    var lines = [
      'BÁO CÁO ' + dd + '/' + ('0' + m).slice(-2) + ' ' + bu.name + ':',
      '- Budget: ' + vnd_(budget) + 'đ',
      '- SĐT: ' + meta.leads,
      '- Chi phí/SĐT: ' + (meta.leads ? vnd_(budget / meta.leads) : '—'),
      '- Doanh số trong ngày: ' + vnd_(r.day) + 'đ',
      '- Chi phí ads tháng ' + m + ': ' + vnd_(monthCost) + ' đ',
      '- Doanh số tháng ' + m + ': ' + vnd_(r.month) + ' đ',
      '- Chi phí/Doanh thu Tháng ' + m + ': ' + ratio
    ];
    if (cost.lastDay && cost.lastDay < day) notes.push('Chi phí tháng tính đến ' + cost.lastDay.slice(8, 10) + '/' + cost.lastDay.slice(5, 7) + ' (file CRM chưa cập nhật ngày ' + dd + ')');
    if (notes.length) lines.push('⚠ ' + notes.join('; '));
    return lines.join('\n');
  });
  return { day: day, text: parts.join('\n\n') };
}

/* =========================== Telegram =========================== */

function tgToken_() {
  var t = PropertiesService.getScriptProperties().getProperty('TELEGRAM_TOKEN');
  if (!t) throw new Error('Chưa lưu token bot Telegram (Cài đặt → Báo cáo Telegram).');
  return t;
}

function tgCall_(method, payload, token) {
  var res = UrlFetchApp.fetch('https://api.telegram.org/bot' + (token || tgToken_()) + '/' + method, {
    method: 'post', contentType: 'application/json', payload: JSON.stringify(payload || {}), muteHttpExceptions: true });
  var d = JSON.parse(res.getContentText() || '{}');
  if (!d.ok) throw new Error('Telegram: ' + (d.description || ('HTTP ' + res.getResponseCode())));
  return d.result;
}

function setTelegramToken_(user, p) {
  var t = String(p.token || '').trim();
  if (!/^\d+:[\w-]{30,}$/.test(t)) throw new Error('Token không đúng định dạng (dạng 123456789:AA…).');
  var me = tgCall_('getMe', {}, t);
  PropertiesService.getScriptProperties().setProperty('TELEGRAM_TOKEN', t);
  logAction_(user.email, '', 'Lưu token bot Telegram', '@' + me.username, 'OK', '');
  return { bot: '@' + me.username };
}

/** Chats that have messaged the bot recently (to pick the chat id). */
function telegramChats_() {
  var seen = {}, out = [];
  (tgCall_('getUpdates', { limit: 100 }) || []).forEach(function (u) {
    var m = u.message || u.channel_post || u.my_chat_member || {};
    var c = m.chat;
    if (c && !seen[c.id]) { seen[c.id] = 1; out.push({ id: String(c.id), title: c.title || [c.first_name, c.last_name].filter(Boolean).join(' ') || c.username || String(c.id), type: c.type }); }
  });
  return out;
}

function telegramStatus_() {
  var has = !!PropertiesService.getScriptProperties().getProperty('TELEGRAM_TOKEN');
  var bot = '';
  if (has) { try { bot = '@' + tgCall_('getMe', {}).username; } catch (e) { bot = 'lỗi: ' + e.message; } }
  return { hasToken: has, bot: bot, trigger: ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'sendDailyReport'; }) };
}

function sendTelegramText_(text) {
  var cfg = reportConfig_();
  if (!cfg.chatId) throw new Error('Chưa chọn nhóm Telegram nhận báo cáo.');
  // Telegram limit 4096 chars per message
  for (var i = 0; i < text.length; i += 3900) tgCall_('sendMessage', { chat_id: cfg.chatId, text: text.slice(i, i + 3900) });
}

/** Trigger entry point (daily). */
function sendDailyReport() {
  var cfg = reportConfig_();
  if (!cfg.enabled) return;
  try {
    var r = buildDailyReport();
    sendTelegramText_(withRecs_(r).text);
    logAction_('Hệ thống', '', 'Gửi báo cáo Telegram', '', 'OK', 'Báo cáo ngày ' + r.day);
  } catch (e) {
    logAction_('Hệ thống', '', 'Gửi báo cáo Telegram', '', 'Lỗi', e.message);
    try { sendTelegramText_('⚠ Không tạo được báo cáo ngày: ' + e.message); } catch (x) { /* ignore */ }
  }
}

function ensureReportTrigger_(cfg) {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'sendDailyReport') ScriptApp.deleteTrigger(t); });
  if (cfg.enabled) ScriptApp.newTrigger('sendDailyReport').timeBased().everyDays(1).atHour(Number(cfg.hour)).nearMinute(15).inTimezone('Asia/Ho_Chi_Minh').create();
}

function saveReport_(user, p) {
  var s = getSettings_();
  var r = p.report || {};
  r.hour = Math.max(0, Math.min(23, Number(r.hour || 8)));
  s.report = r;
  putSetting_('config', s);
  ensureReportTrigger_(r);
  logAction_(user.email, '', 'Sửa cấu hình báo cáo Telegram', '', 'OK', (r.enabled ? 'Bật, ' : 'Tắt, ') + r.hour + 'h');
  return { report: r, status: telegramStatus_() };
}

/** SĐT the way Ads Manager's "Kết quả" column counts lead-form results. */
function sdtCount_(insight) {
  var acts = {};
  ((insight || {}).actions || []).forEach(function (a) { acts[a.action_type] = Number(a.value); });
  return Math.max(0, (acts['lead'] || 0) - (acts['onsite_conversion.lead'] || 0));
}

/** Finds a tab ignoring case, spaces and punctuation ("Deal T11/2026" = "Deal T112026"). */
function findTab_(ss, name, label) {
  var exact = ss.getSheetByName(name);
  if (exact) return exact;
  var key = function (x) { return String(x || '').normalize('NFC').toLowerCase().replace(/[^0-9a-zà-ỹđ]/g, ''); };
  var want = key(name);
  var all = ss.getSheets();
  for (var i = 0; i < all.length; i++) if (key(all[i].getName()) === want) return all[i];
  var similar = all.map(function (s) { return s.getName(); }).filter(function (n) { return key(n).indexOf(want.slice(0, 5)) === 0; });
  throw new Error('Không thấy tab "' + name + '" trong ' + label + '.' + (similar.length ? ' Các tab gần giống: ' + similar.slice(0, 8).join(', ') : ''));
}
