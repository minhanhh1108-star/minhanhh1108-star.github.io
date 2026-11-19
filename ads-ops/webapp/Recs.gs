/**
 * Rule-based recommendations for running campaigns (free, no AI API).
 * Each active campaign gets one main action + secondary notes, with the numbers behind them.
 * Thresholds live in settings.recRules (editable in Settings → Đề xuất).
 *
 * Data: last 7 days vs the 7 days before (period-level: spend, SĐT, Book, impressions, reach, link clicks)
 *       + last 14 days daily (stability) + month-to-date per account (from chartData_).
 */

var REC_ACTIONS = {
  PAUSE:   { label: 'Tắt camp',               icon: '⛔', rank: 1 },
  MONTH:   { label: 'Cảnh báo ngân sách tháng', icon: '💰', rank: 2 },
  CUT:     { label: 'Giảm ngân sách',          icon: '🔻', rank: 3 },
  QUALITY: { label: 'Kiểm tra chất lượng SĐT', icon: '📞', rank: 4 },
  CREATIVE:{ label: 'Làm mới creative',        icon: '🎨', rank: 5 },
  CLONE:   { label: 'Nhân bản sang tệp mới',   icon: '🧬', rank: 6 },
  SCALE:   { label: 'Tăng ngân sách',          icon: '🔺', rank: 7 },
  KEEP:    { label: 'Giữ nguyên, theo dõi',    icon: '✅', rank: 8 },
  WAIT:    { label: 'Chưa đủ dữ liệu',         icon: '⏳', rank: 9 }
};

function defaultRecRules_() {
  return {
    pauseZeroLeadX: 2,      // spent >= 2 × CPL target with 0 SĐT → pause
    pauseCplPct: 150,       // CPL > 150% target …
    pauseMinSpendX: 3,      // … after spending >= 3 × target → pause
    cutCplPct: 115,         // CPL 115–150% target → cut budget
    worseTrendPct: 10,      // CPL this week worse than last week by > 10% (and above target) → cut
    cutBudgetPct: 25,
    scaleCplPct: 85,        // CPL < 85% target, Book OK, stable → scale
    scaleStableDays: 5,     // days with >= 1 SĐT out of the last 7
    scaleBudgetPct: 20,
    cloneFreq: 2.5,         // good camp but frequency > 2.5 → clone to a new audience
    creativeFreq: 3,        // frequency > 3 → refresh creative
    creativeCtrDropPct: 30, // CTR down > 30% vs previous week → refresh creative
    qualityMinLeads: 10,    // enough SĐT to judge quality
    qualityRatePct: 50      // SĐT→Book rate < 50% of account average → check lead quality
  };
}

function recRules_() {
  var r = defaultRecRules_(), s = getSettings_().recRules || {};
  Object.keys(s).forEach(function (k) { if (s[k] !== '' && s[k] != null && !isNaN(Number(s[k]))) r[k] = Number(s[k]); });
  return r;
}

function periodByCampaign_(accId, since, until) {
  var rows = gall(accId + '/insights', {
    level: 'campaign', limit: 500, time_range: JSON.stringify({ since: since, until: until }),
    fields: 'campaign_id,campaign_name,spend,actions,impressions,reach,inline_link_clicks'
  });
  var out = {};
  rows.forEach(function (r) {
    out[r.campaign_id] = { spend: Number(r.spend || 0), leads: sdtCount_(r), books: bookCount_(r),
      impressions: Number(r.impressions || 0), reach: Number(r.reach || 0), clicks: Number(r.inline_link_clicks || 0) };
  });
  return out;
}

function activeCampaigns_(accId) {
  return gall(accId + '/campaigns', { fields: 'id,name,objective,daily_budget,lifetime_budget,effective_status', limit: 200,
    effective_status: JSON.stringify(['ACTIVE']) });
}

function money_(n) { return fmt_(Math.round(n)) + 'đ'; }

function buildRecs_(p) {
  var cache = CacheService.getScriptCache(), key = 'recs_v1';
  if (!p || !p.refresh) { var hit = cache.get(key); if (hit) return JSON.parse(hit); }
  var R = recRules_(), s = getSettings_(), DAY = 86400000, now = Date.now();
  var d = function (n) { return ymd_(new Date(now - n * DAY)); };
  var chart = chartData_({ days: 14, refresh: p && p.refresh });
  var daily = {}; chart.campaigns.forEach(function (c) { daily[c.id] = c; });
  var out = { items: [], accounts: [], rules: R, updatedAt: nowIso_() };

  (s.accounts || []).forEach(function (acc) {
    var cur = periodByCampaign_(acc.id, d(7), d(1)), prev = periodByCampaign_(acc.id, d(14), d(8));
    var accCh = chart.accounts.filter(function (a) { return a.id === acc.id; })[0] || { leads: 0, books: 0, month: {} };
    var accRate = accCh.leads ? accCh.books / accCh.leads : 0;
    var bookTarget = Number((s.bookTargets || {})[acc.id]) || 0;
    var m = accCh.month || {};
    if (m.budget && m.projected > m.budget) {
      out.accounts.push({ account: acc.name, action: 'MONTH', reasons: ['Đã chi ' + money_(m.spend) + ' sau ' + m.elapsed + '/' + m.daysInMonth + ' ngày, dự kiến cả tháng ' +
        money_(m.projected) + ', vượt ngân sách ' + money_(m.budget) + ' khoảng ' + money_(m.projected - m.budget) + '.',
        'Muốn về đúng ngân sách: giảm tổng ngân sách/ngày còn khoảng ' + money_(Math.max(0, (m.budget - m.spend) / Math.max(1, m.daysInMonth - m.elapsed))) + '.'] });
    }

    activeCampaigns_(acc.id).forEach(function (c) {
      var a = cur[c.id] || { spend: 0, leads: 0, books: 0, impressions: 0, reach: 0, clicks: 0 };
      var b = prev[c.id] || { spend: 0, leads: 0, books: 0, impressions: 0, reach: 0, clicks: 0 };
      var dc = daily[c.id] || { spend: 0, leads: 0, books: 0, days: {} };
      var ind = industryFromName(c.name, s.industries), T = ind ? Number(ind.target) : 0;
      var isLead = c.objective === 'OUTCOME_LEADS' || a.leads > 0;
      var cpl = a.leads ? a.spend / a.leads : null, cplPrev = b.leads ? b.spend / b.leads : null;
      var freq = a.reach ? a.impressions / a.reach : 0;
      var ctr = a.impressions ? a.clicks / a.impressions * 100 : 0, ctrPrev = b.impressions ? b.clicks / b.impressions * 100 : 0;
      var budget = Number(c.daily_budget || 0);
      var stable = chart.days.slice(-7).filter(function (day) { return ((dc.days[day] || {}).l || 0) > 0; }).length;
      var cpb14 = dc.books ? dc.spend / dc.books : null, rate14 = dc.leads ? dc.books / dc.leads : null;
      var acts = [], add = function (code, why) { acts.push({ code: code, why: why }); };

      if (isLead && T) {
        if (!a.leads && a.spend >= R.pauseZeroLeadX * T) add('PAUSE', 'Chi ' + money_(a.spend) + ' trong 7 ngày mà 0 SĐT (ngưỡng tắt: ' + R.pauseZeroLeadX + ' × mục tiêu ' + money_(T) + ').');
        else if (cpl && cpl > T * R.pauseCplPct / 100 && a.spend >= R.pauseMinSpendX * T)
          add('PAUSE', 'Chi phí/SĐT 7 ngày ' + money_(cpl) + ' = ' + Math.round(cpl / T * 100) + '% mục tiêu ' + money_(T) + ' (ngưỡng tắt ' + R.pauseCplPct + '%), đã chi ' + money_(a.spend) + '.');
        else if (cpl && cpl > T * R.cutCplPct / 100)
          add('CUT', 'Chi phí/SĐT 7 ngày ' + money_(cpl) + ' = ' + Math.round(cpl / T * 100) + '% mục tiêu ' + money_(T) + '.');
        else if (cpl && cplPrev && cpl > T && cpl > cplPrev * (1 + R.worseTrendPct / 100))
          add('CUT', 'Chi phí/SĐT xấu đi: tuần trước ' + money_(cplPrev) + ' → tuần này ' + money_(cpl) + ' (vượt mục tiêu ' + money_(T) + ').');
      }
      if (isLead && dc.leads >= R.qualityMinLeads && accRate && rate14 !== null && rate14 < accRate * R.qualityRatePct / 100 && (!T || dc.spend / dc.leads <= T * 1.15))
        add('QUALITY', 'SĐT rẻ nhưng ít Book: 14 ngày ' + dc.leads + ' SĐT → ' + dc.books + ' Book (' + (rate14 * 100).toFixed(1).replace('.', ',') + '%), trung bình tài khoản ' + (accRate * 100).toFixed(1).replace('.', ',') + '%. Kiểm tra form, tệp, kịch bản telesale.');
      if (freq > R.creativeFreq) add('CREATIVE', 'Tần suất 7 ngày ' + freq.toFixed(2).replace('.', ',') + ' (> ' + R.creativeFreq + '): người xem đã thấy quảng cáo nhiều lần.');
      else if (ctrPrev && a.impressions > 3000 && ctr < ctrPrev * (1 - R.creativeCtrDropPct / 100))
        add('CREATIVE', 'CTR giảm ' + Math.round((1 - ctr / ctrPrev) * 100) + '%: tuần trước ' + ctrPrev.toFixed(2).replace('.', ',') + '% → ' + ctr.toFixed(2).replace('.', ',') + '%.');
      var good = isLead && T && cpl && cpl <= T;
      if (good && freq > R.cloneFreq && freq <= R.creativeFreq) add('CLONE', 'Camp đang tốt (' + money_(cpl) + '/SĐT) nhưng tần suất ' + freq.toFixed(2).replace('.', ',') + ' sắp bão hòa: nhân bản sang tệp mới để giữ hiệu quả.');
      if (isLead && T && cpl && cpl < T * R.scaleCplPct / 100 && stable >= R.scaleStableDays && (!bookTarget || (cpb14 && cpb14 <= bookTarget)) && freq <= R.cloneFreq)
        add('SCALE', 'Chi phí/SĐT ' + money_(cpl) + ' = ' + Math.round(cpl / T * 100) + '% mục tiêu, có SĐT ' + stable + '/7 ngày' + (bookTarget ? ', chi phí/Book ' + money_(cpb14) + ' ≤ mục tiêu ' + money_(bookTarget) : '') + '.');
      if (!acts.length) add(isLead && (!a.spend || (!a.leads && a.spend < (R.pauseZeroLeadX * T || 1))) ? 'WAIT' : 'KEEP',
        !isLead ? 'Camp không tối ưu theo lead, app chỉ theo dõi tần suất và CTR.' : !T ? 'Chưa có mục tiêu chi phí/SĐT cho ngành của camp này.' :
        a.leads ? (cpl > T ? 'Chi phí/SĐT ' + money_(cpl) + ' cao hơn mục tiêu ' + money_(T) + ' ' + Math.round((cpl / T - 1) * 100) + '%, chưa tới ngưỡng giảm ' + R.cutCplPct + '%' + (cplPrev ? ' (tuần trước ' + money_(cplPrev) + ')' : '') + '. Theo dõi tiếp.' : 'Chi phí/SĐT ' + money_(cpl) + ' đạt mục tiêu ' + money_(T) + '.') : 'Mới chi ' + money_(a.spend) + ', chưa đủ để kết luận.');
      acts.sort(function (x, y) { return REC_ACTIONS[x.code].rank - REC_ACTIONS[y.code].rank; });

      var main = acts[0].code, newBudget = null;
      if (budget && main === 'CUT') newBudget = Math.round(budget * (1 - R.cutBudgetPct / 100) / 10000) * 10000;
      if (budget && main === 'SCALE') newBudget = Math.round(budget * (1 + R.scaleBudgetPct / 100) / 10000) * 10000;
      out.items.push({
        id: c.id, name: c.name, account: acc.name, accountId: acc.id, action: main, rank: REC_ACTIONS[main].rank,
        reasons: acts.map(function (x) { return REC_ACTIONS[x.code].icon + ' ' + x.why; }), others: acts.slice(1).map(function (x) { return x.code; }),
        budget: budget, newBudget: newBudget, target: T, bookTarget: bookTarget,
        m: { spend: a.spend, leads: a.leads, books: a.books, cpl: cpl, cplPrev: cplPrev, freq: freq, ctr: ctr, ctrPrev: ctrPrev, spend14: dc.spend, leads14: dc.leads, books14: dc.books }
      });
    });
  });
  out.items.sort(function (x, y) { return x.rank - y.rank || (y.m.spend - x.m.spend); });
  out.labels = REC_ACTIONS;
  try { cache.put(key, JSON.stringify(out), 1800); } catch (e) {}
  return out;
}

/** Short block for the morning Telegram report. */
function recsTelegramBlock_() {
  var r = buildRecs_({ refresh: true }), lines = [];
  r.accounts.forEach(function (a) { lines.push('💰 ' + a.account + ': ' + a.reasons[0]); });
  r.items.filter(function (x) { return ['KEEP', 'WAIT'].indexOf(x.action) < 0; }).slice(0, 5).forEach(function (x) {
    lines.push(REC_ACTIONS[x.action].icon + ' ' + REC_ACTIONS[x.action].label + ': ' + x.name + (x.newBudget ? ' (' + fmt_(x.budget) + ' → ' + fmt_(x.newBudget) + 'đ/ngày)' : '') +
      '\n   ' + x.reasons[0].replace(/^\S+\s/, ''));
  });
  return lines.length ? 'ĐỀ XUẤT HÔM NAY\n' + lines.join('\n') : 'ĐỀ XUẤT HÔM NAY\nKhông có camp cần xử lý.';
}

/** Appends the recommendation block to a report when enabled in settings. */
function withRecs_(r) {
  if (!getSettings_().recTelegram) return r;
  try { r.text += '\n\n' + recsTelegramBlock_(); } catch (e) { r.text += '\n\n(Không tạo được đề xuất: ' + e.message + ')'; }
  return r;
}
