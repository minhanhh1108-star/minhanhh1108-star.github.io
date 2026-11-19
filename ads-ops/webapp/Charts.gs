/**
 * Data for the "Biểu Đồ" tab.
 *  - per campaign over the period: spend, SĐT (lead form, same formula as the Telegram report), Book (purchase events)
 *  - per campaign per day (trend)
 *  - per account: month-to-date spend, projected month spend, monthly budget / Book target from settings
 * Book = omni_purchase with the account's default attribution (same number as Ads Manager "Lượt mua").
 * Cached 20 minutes; "Làm mới" forces a reload.
 */

function bookCount_(insight) {
  var acts = {};
  ((insight || {}).actions || []).forEach(function (a) { acts[a.action_type] = Number(a.value); });
  return acts['omni_purchase'] || acts['purchase'] || acts['offsite_conversion.fb_pixel_purchase'] || acts['onsite_web_purchase'] || 0;
}

function chartData_(p) {
  var days = [7, 14, 30].indexOf(Number(p.days)) >= 0 ? Number(p.days) : 14;
  var cache = CacheService.getScriptCache(), key = 'chart_v1_' + days;
  if (!p.refresh) { var hit = cache.get(key); if (hit) return JSON.parse(hit); }

  var now = new Date(), DAY = 86400000;
  var until = ymd_(new Date(now.getTime() - DAY)), since = ymd_(new Date(now.getTime() - days * DAY));
  var s = getSettings_(), camps = {}, accounts = [];
  var dayList = [];
  for (var t = new Date(since + 'T00:00:00+07:00').getTime(); ymd_(new Date(t)) <= until; t += DAY) dayList.push(ymd_(new Date(t)));

  (s.accounts || []).forEach(function (acc) {
    var rows = gall(acc.id + '/insights', {
      level: 'campaign', time_increment: 1, limit: 500,
      time_range: JSON.stringify({ since: since, until: until }),
      fields: 'campaign_id,campaign_name,objective,spend,actions'
    });
    var a = { id: acc.id, name: acc.name, spend: 0, leads: 0, books: 0, days: {} };
    rows.forEach(function (r) {
      var sp = Number(r.spend || 0), ld = sdtCount_(r), bk = bookCount_(r), d = r.date_start;
      var c = camps[r.campaign_id] || (camps[r.campaign_id] = { id: r.campaign_id, name: r.campaign_name, account: acc.id, accountName: acc.name,
                                                                 objective: r.objective || '', spend: 0, leads: 0, books: 0, days: {} });
      c.spend += sp; c.leads += ld; c.books += bk;
      c.days[d] = { s: sp, l: ld, b: bk };
      a.spend += sp; a.leads += ld; a.books += bk;
      var ad = a.days[d] || (a.days[d] = { s: 0, l: 0, b: 0 });
      ad.s += sp; ad.l += ld; ad.b += bk;
    });
    // month to date (includes today so far)
    var mtd = (gget(acc.id + '/insights', { date_preset: 'this_month', fields: 'spend,actions' }).data || [])[0] || {};
    var dim = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    var elapsed = Number(Utilities.formatDate(now, 'Asia/Ho_Chi_Minh', 'd'));
    var mSpend = Number(mtd.spend || 0);
    a.month = { spend: mSpend, books: bookCount_(mtd), leads: sdtCount_(mtd), daysInMonth: dim, elapsed: elapsed,
                projected: elapsed ? mSpend / elapsed * dim : 0,
                budget: Number(((s.monthBudgets || {})[acc.id]) || 0), bookTarget: Number(((s.bookTargets || {})[acc.id]) || 0) };
    accounts.push(a);
  });

  var out = { since: since, until: until, days: dayList, campaigns: Object.keys(camps).map(function (k) { return camps[k]; }).filter(function (c) { return c.spend > 0; }),
              accounts: accounts, updatedAt: nowIso_() };
  try { cache.put(key, JSON.stringify(out), 1200); } catch (e) { /* too large for cache: skip */ }
  return out;
}
