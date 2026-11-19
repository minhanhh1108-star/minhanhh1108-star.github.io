/**
 * Content QC before a campaign is built.
 * Rules come from two internal documents:
 *   - "Meta Multi-Platform Content Policy Engine V3 – Vietnam" (risk levels, ad engine, safe rewrite)
 *   - "Bộ quy tắc ngôn từ content Chatbot AI" (brand voice, wording table, CTA, icons, ad policy §20)
 * Levels: BLACK > RED > ORANGE > YELLOW > GREEN.
 *   RED/BLACK  → REJECT (blocks "Gửi QC")
 *   ORANGE     → HUMAN REVIEW (QC reviewer must look)
 *   YELLOW     → REWRITE suggested
 * Admins can edit/extend rules in Settings (settings.qcRules).
 */

var QC_LEVELS = { GREEN: 0, YELLOW: 1, ORANGE: 2, RED: 3, BLACK: 4 };

function defaultQcRules_() {
  var R = function (id, level, src, pattern, msg, fix, replace) {
    return { id: id, level: level, src: src, pattern: pattern, msg: msg, fix: fix || '', replace: replace || '' };
  };
  return [
    // ---- Hard stop / impersonation / fraud (Policy Engine MC-007, MC-008)
    R('MC-008', 'RED', 'Policy Engine MC-008', '(facebook|meta|instagram)\\s+(thông báo|xác nhận|chính thức|cảnh báo)|thông báo (chính thức )?từ (facebook|meta)',
      'Giả danh hoặc mượn danh Meta/Facebook.', 'Bỏ phần nhân danh Meta; nói bằng giọng thương hiệu Bot Bán Hàng.'),
    R('MC-007', 'BLACK', 'Policy Engine MC-007', 'nhập mật khẩu|cung cấp mã otp|xác minh tài khoản (ngân hàng|facebook)|nhận thưởng ngay khi chia sẻ',
      'Dấu hiệu lừa đảo/phishing.', 'Không được dùng. Viết lại hoàn toàn.'),
    // ---- Ads policy §20.1 absolute claims (+ performance) — Policy Engine §17, §20
    R('AD-20.1a', 'RED', 'Quy tắc §20.1 + Policy §20', '(cam kết|đảm bảo|chắc chắn|100%|tuyệt đối)[^.\\n]{0,40}(tăng|x\\d|gấp|doanh thu|doanh số|lợi nhuận|đơn hàng|chốt)',
      'Cam kết kết quả kinh doanh tuyệt đối.', 'Chuyển sang điều kiện: "có thể giúp…; hiệu quả thực tế phụ thuộc cách triển khai", hoặc dùng số liệu case có nguồn.'),
    R('AD-20.1b', 'YELLOW', 'Quy tắc §20.1', 'cam kết|chắc chắn|tuyệt đối|trọn đời|100%',
      'Từ ngữ tuyệt đối dễ bị Meta đánh giá là cam kết.', 'Thay bằng "hỗ trợ", "giúp", "có thể".'),
    // ---- Personal attributes (Policy §17)
    R('AD-17', 'ORANGE', 'Policy Engine §17', 'bạn (có )?(đang )?(bị|thất nghiệp|nợ|mắc|béo|mất ngủ|trầm cảm|ly hôn|vỡ nợ)',
      'Có thể nhắm vào đặc điểm cá nhân (personal attributes).', 'Nói về tình huống chung: "Giải pháp dành cho doanh nghiệp đang…", không hỏi trực tiếp người đọc có vấn đề cá nhân.'),
    // ---- Health / finance claims (Policy §17, §24)
    R('AD-HF', 'ORANGE', 'Policy Engine §17/§24', 'chữa khỏi|trị dứt điểm|khỏi hẳn|lãi suất|sinh lời|đầu tư (an toàn|chắc thắng)|không rủi ro',
      'Claim sức khỏe/tài chính cần người duyệt.', 'Bỏ claim hoặc thêm nguồn và điều kiện.'),
    // ---- Fabricated evidence (MC-012)
    R('MC-012', 'ORANGE', 'Policy Engine MC-012', '(tăng|giảm|x)\\s*\\d{2,4}\\s*%|doanh thu (tăng|gấp)|kiếm (được )?\\d+\\s*(triệu|tỷ)',
      'Có số liệu kết quả: phải có nguồn/case thật, không bịa.', 'Ghi rõ nguồn hoặc "ví dụ minh họa", hoặc bỏ số.'),
    R('AD-CHEAP', 'ORANGE', 'Quy tắc §16', 'rẻ nhất( thị trường)?|giá tốt nhất|số 1 việt nam|tốt nhất thị trường',
      'Claim so sánh tuyệt đối không có cơ sở.', 'Bỏ hoặc dẫn nguồn xác thực; ưu tiên minh bạch cách tính phí.'),
    // ---- §20.2 fear / insult
    R('AD-20.2', 'RED', 'Quy tắc §20.2', 'ngu muội|phá sản|sập tiệm|chết đơn|lừa đảo|thất bại thảm hại',
      'Ngôn từ hù dọa hoặc công kích.', 'Dùng "chưa tối ưu", "có thể cải thiện", "bất cập".'),
    // ---- §20.3 get-rich language
    R('AD-20.3', 'RED', 'Quy tắc §20.3', 'hốt bạc|làm giàu nhanh|đổi đời|kiếm tiền dễ dàng|ăn tươi nuốt sống',
      'Ngôn ngữ làm giàu / tiền bạc nhạy cảm.', 'Dùng "tăng hiệu suất bán hàng", "tối ưu chi phí vận hành", "tăng lợi thế cạnh tranh".'),
    // ---- §17 không thần thánh hóa AI
    R('BV-17', 'YELLOW', 'Quy tắc §13, §17', 'thay thế (toàn bộ|hoàn toàn)|chốt mọi đơn|hiểu 100%|không bao giờ sai|xử lý (tất cả|mọi thứ)',
      'Thần thánh hóa AI.', 'AI "hỗ trợ", "giảm tải", "xử lý theo kịch bản được cấu hình", "chuyển cho nhân viên khi cần".'),
    // ---- §18 CTA
    R('BV-18', 'YELLOW', 'Quy tắc §18', 'mua ngay|đừng bỏ lỡ|đăng ký ngay lập tức|cơ hội cuối cùng|bắt buộc phải dùng',
      'CTA mang tính ép buộc.', 'CTA mời khám phá: "Đăng ký demo để xem AI xử lý quy trình của bạn như thế nào."'),
    // ---- IG-005 / §20 engagement bait
    R('IG-005', 'YELLOW', 'Policy Engine IG-005, §20', 'comment\\s*(yes|ok|1|"\\w+")|bình luận\\s*"?(ok|1|có)"?\\s*để|share (để|ngay)|tag (bạn bè|\\d+ người)',
      'Engagement bait.', 'Câu hỏi thảo luận thật: "Bạn đang dùng AI ở bước nào trong quy trình?"'),
    // ---- §21 bảng quy đổi ngôn từ (auto-fix)
    R('BV-21a', 'YELLOW', 'Quy tắc §21', 'bá đạo|vô đối|đỉnh chóp', 'Từ ngữ khoa trương.', 'Dùng: tối ưu, hiệu quả, phù hợp, chuyên nghiệp.', 'hiệu quả'),
    R('BV-21b', 'YELLOW', 'Quy tắc §21', 'quét sạch', 'Từ ngữ khoa trương.', '', 'tự động xử lý'),
    R('BV-21c', 'YELLOW', 'Quy tắc §21', 'bóc phốt|sấp mặt|toang', 'Từ ngữ drama.', '', 'bất cập'),
    R('BV-21d', 'YELLOW', 'Quy tắc §21', 'cứu cánh', 'Nên dùng từ trung tính.', '', 'giải pháp'),
    R('BV-21e', 'YELLOW', 'Quy tắc §21', 'cào phím', 'Từ lóng.', '', 'phương pháp thủ công'),
    R('BV-21f', 'YELLOW', 'Quy tắc §21', 'dẹp đi', 'Từ ngữ mạnh.', '', 'giảm tải'),
    R('BV-21g', 'YELLOW', 'Quy tắc §21', 'ngay và luôn', 'Từ ngữ hô hào.', '', 'trải nghiệm ngay'),
    R('BV-21h', 'YELLOW', 'Quy tắc §21', 'ai thần thánh', 'Thần thánh hóa AI.', '', 'AI hỗ trợ'),
    R('BV-21i', 'YELLOW', 'Quy tắc §21', 'ai thay thế nhân viên', 'Định vị sai: AI là trợ lý.', '', 'AI giảm tải cho nhân viên'),
    // ---- §7.2 corporate jargon
    R('BV-7.2', 'YELLOW', 'Quy tắc §7.2', 'chuyển đổi số toàn diện|hệ sinh thái ai|giải pháp công nghệ tiên tiến|tối ưu hóa quy trình vận hành|tối ưu hóa trải nghiệm khách hàng',
      'Ngôn ngữ quá "corporate".', 'Chuyển về tình huống cụ thể: "Khách hỏi giá → AI phản hồi ngay…"')
  ];
}

function qcRules_() {
  var s = getSettings_();
  return (s.qcRules && s.qcRules.length) ? s.qcRules : defaultQcRules_();
}

function emojiCount_(t) { var m = String(t).match(/\p{Extended_Pictographic}/gu); return m ? m.length : 0; }

/** QC one piece of text. Returns items. */
function qcText_(text, where, rules) {
  var out = [];
  var t = String(text || '');
  if (!t.trim()) return out;
  rules.forEach(function (r) {
    var re;
    try { re = new RegExp(r.pattern, 'giu'); } catch (e) { return; }
    var m, seen = {};
    while ((m = re.exec(t)) !== null) {
      if (!m[0] || seen[m[0].toLowerCase()]) { if (!m[0]) re.lastIndex++; continue; }
      seen[m[0].toLowerCase()] = 1;
      out.push({ level: r.level, rule: r.id, src: r.src, where: where, excerpt: m[0], msg: r.msg, fix: r.fix || (r.replace ? 'Thay bằng "' + r.replace + '".' : ''), replace: r.replace || '' });
    }
  });
  return out;
}

/** Format / brand-voice checks that are not keyword based (§3, §8, §18, §19, IG-005). */
function qcFormat_(text, where, isPrimary) {
  var out = [], t = String(text || '');
  if (!t.trim()) return out;
  var push = function (level, rule, src, msg, fix) { out.push({ level: level, rule: rule, src: src, where: where, excerpt: '', msg: msg, fix: fix, replace: '' }); };
  var e = emojiCount_(t);
  if (e > 6) push('YELLOW', 'BV-19', 'Quy tắc §19', 'Dùng ' + e + ' icon (khuyến nghị 4–6).', 'Bớt icon trang trí, chỉ giữ icon định hướng mắt.');
  var tags = (t.match(/#[\p{L}\d_]+/gu) || []).length;
  if (tags > 5) push('YELLOW', 'IG-005', 'Policy Engine IG-005', tags + ' hashtag (dễ bị coi là spam).', 'Giữ tối đa 3–5 hashtag liên quan.');
  var letters = t.replace(/[^\p{L}]/gu, ''), upper = t.replace(/[^\p{Lu}]/gu, '');
  var body = t.split('\n').slice(1).join('\n'), bl = body.replace(/[^\p{L}]/gu, ''), bu = body.replace(/[^\p{Lu}]/gu, '');
  if (bl.length > 80 && bu.length / bl.length > 0.3) push('YELLOW', 'BV-8', 'Quy tắc §2, §8', 'Viết hoa quá nhiều trong thân bài (tạo cảm giác hô hào).', 'Chỉ viết hoa dòng hook đầu tiên nếu cần.');
  if (!isPrimary) return out;
  t.split(/\n\s*\n/).forEach(function (p, i) {
    var sentences = (p.match(/[.!?…](\s|$)/g) || []).length;
    if (p.length > 320 || sentences > 4) push('YELLOW', 'BV-8.1', 'Quy tắc §8.1', 'Đoạn ' + (i + 1) + ' quá dài (' + p.length + ' ký tự).', 'Mỗi đoạn 1–3 câu, xuống dòng thường xuyên.');
  });
  var head = t.slice(0, 160).toLowerCase();
  if (/^(chatbot ai|bot bán hàng|chúng tôi|giải pháp|ứng dụng công nghệ)/.test(head.trim()) || /\b(là gì)\b/.test(head))
    push('YELLOW', 'BV-3', 'Quy tắc §3.1–3.2', 'Mở đầu bằng sản phẩm thay vì nỗi đau của khách.', 'Mở bằng tình huống: "Nhân viên nghỉ lúc 10 giờ tối. Nhưng khách hàng thì chưa."');
  var pains = /(khách nhắn|nhắn tin|tin nhắn|quá tải|trả lời chậm|không kịp|mất khách|mất đơn|bỏ lỡ|phải chờ|ngoài giờ|nửa đêm|ban đêm|nhân viên|trực (page|inbox|chat)|chi phí)/;
  if (!pains.test(head)) push('YELLOW', 'BV-9', 'Quy tắc §3.2, §9', '3–5 dòng đầu chưa chạm nỗi đau cụ thể.', 'Hook theo: mất mát / đối lập / nghịch lý / câu hỏi / tình huống cụ thể.');
  var tail = t.slice(-300).toLowerCase();
  if (!/(đăng ký|demo|trải nghiệm|tìm hiểu|xem (demo|thực tế)|nhắn (tin )?cho|để lại thông tin)/.test(tail))
    push('YELLOW', 'BV-18b', 'Quy tắc §18', 'Thiếu CTA tự nhiên ở cuối.', '"Đăng ký demo để xem AI có thể xử lý quy trình của bạn như thế nào."');
  if (!/(case|ví dụ|demo|khách hàng (của|đang)|doanh nghiệp (đã|đang)|thực tế)/.test(t.toLowerCase()))
    push('YELLOW', 'BV-11', 'Quy tắc §11–12, §15', 'Chưa có demo/case/bằng chứng.', 'Thêm tình huống demo hoặc case cùng ngành.');
  return out;
}

/** Text of an existing page post (read with the page token). null if it cannot be read. */
function postText_(postId) {
  var id = String(postId || '').trim();
  if (!/^\d+_\d+$/.test(id)) return null;
  var key = 'post_' + id, cache = CacheService.getScriptCache(), hit = cache.get(key);
  if (hit !== null && hit !== undefined) return hit;
  try {
    var r = gget(id, { fields: 'message' }, pageToken_(id.split('_')[0]));
    var t = String(r.message || '');
    cache.put(key, t, 3600);
    return t;
  } catch (e) { return null; }
}

/** Full QC of an order. */
function qcOrder(order) {
  var rules = qcRules_(), items = [];
  (order.ads || []).forEach(function (a, i) {
    if (!a.name && !a.message && !a.title && !a.postId) return;
    var where = 'Quảng cáo "' + (a.name || '#' + (i + 1)) + '"';
    if (a.source === 'post') {
      var text = postText_(a.postId);
      if (text === null) {
        items.push({ level: 'YELLOW', rule: 'QC-POST', src: 'Quy trình QC', where: where, excerpt: '', msg: 'Không đọc được nội dung bài viết có sẵn.', fix: 'Người QC mở bài viết để xem trước khi duyệt.', replace: '' });
      } else {
        items = items.concat(qcText_(text, where + ' · bài viết có sẵn', rules), qcFormat_(text, where + ' · bài viết có sẵn', true));
      }
      return;
    }
    items = items.concat(qcText_(a.message, where + ' · nội dung', rules), qcFormat_(a.message, where + ' · nội dung', true),
                         qcText_(a.title, where + ' · tiêu đề', rules), qcFormat_(a.title, where + ' · tiêu đề', false));
    if (a.title && a.title.length > 40) items.push({ level: 'YELLOW', rule: 'FMT-TITLE', src: 'Định dạng', where: where + ' · tiêu đề', excerpt: '', msg: 'Tiêu đề ' + a.title.length + ' ký tự (dễ bị cắt).', fix: 'Giữ ≤ 40 ký tự.', replace: '' });
  });
  var max = items.reduce(function (m, x) { return Math.max(m, QC_LEVELS[x.level] || 0); }, 0);
  var risk = Object.keys(QC_LEVELS).filter(function (k) { return QC_LEVELS[k] === max; })[0];
  var decision = max >= 3 ? 'REJECT' : max === 2 ? 'HUMAN_REVIEW' : max === 1 ? 'REWRITE' : 'APPROVE';
  var score = Math.max(0, 100 - items.reduce(function (s, x) { return s + ({ YELLOW: 5, ORANGE: 15, RED: 40, BLACK: 100 }[x.level] || 0); }, 0));
  items.sort(function (a, b) { return (QC_LEVELS[b.level] || 0) - (QC_LEVELS[a.level] || 0); });
  return { decision: decision, risk: risk, score: score, items: items, policyVersion: 'Policy Engine 3.0 + Quy tắc content Chatbot AI', at: nowIso_() };
}

/** Applies the automatic word replacements (§21) to every ad. */
function qcAutoFix_(order) {
  var rules = qcRules_().filter(function (r) { return r.replace; });
  var n = 0;
  (order.ads || []).forEach(function (a) {
    ['message', 'title'].forEach(function (f) {
      rules.forEach(function (r) {
        var re; try { re = new RegExp(r.pattern, 'giu'); } catch (e) { return; }
        a[f] = String(a[f] || '').replace(re, function () { n++; return r.replace; });
      });
    });
  });
  return { order: order, replaced: n };
}

/* =========================== QC workflow =========================== */

/** QC reviewers: settings.qcReviewers if set, otherwise only the app owner (the account that deployed it). */
function qcReviewers_(s) {
  var list = (s.qcReviewers || []).map(lower_).filter(String);
  if (list.length) return list;
  var owner = '';
  try { owner = lower_(Session.getEffectiveUser().getEmail()); } catch (e) {}
  return owner ? [owner] : [];
}

function canQc_(u, s) {
  var list = qcReviewers_(s);
  if (!list.length) return u.role === 'admin';
  return list.indexOf(lower_(u.email)) >= 0;
}

function sendToQc_(user, p) {
  var o = getOrder_(p.id);
  if (o.status !== STATUS.DRAFT) throw new Error('Chỉ gửi QC được camp ở trạng thái Nháp.');
  var v = validateOrder(o, loadContext_());
  if (v.errors.length) throw new Error('Còn lỗi cấu hình cần sửa: ' + v.errors.map(function (e) { return e.msg; }).join(' · '));
  var q = qcOrder(o);
  o.qc = { result: q, sentBy: user.email, sentAt: nowIso_(), notes: (o.qc && o.qc.notes) || [] };
  if (q.decision === 'REJECT') {
    writeOrder_(o);
    logAction_(user.email, o.id, 'QC tự động: TỪ CHỐI', '', 'Lỗi', q.items.filter(function (x) { return QC_LEVELS[x.level] >= 3; }).map(function (x) { return x.rule + ' "' + x.excerpt + '"'; }).join(', '));
    throw new Error('QC tự động phát hiện vi phạm mức ' + q.risk + '. Sửa các mục ⛔ rồi gửi lại.');
  }
  o.status = STATUS.QC_PENDING;
  writeOrder_(o);
  logAction_(user.email, o.id, 'Gửi QC', '', 'OK', q.decision + ' · ' + q.risk + ' · điểm ' + q.score);
  notify_(o, 'Chờ QC: ' + o.campaign.name, user.email + ' gửi camp ' + o.id + ' chờ QC. Kết quả soát tự động: ' + q.decision + ' (' + q.risk + ', điểm ' + q.score + ').', qcReviewers_(getSettings_()));
  return o;
}

function qcDecide_(user, p) {
  if (!canQc_(user, getSettings_())) throw new Error('Bạn không có quyền duyệt QC.');
  var o = getOrder_(p.id);
  if (o.status !== STATUS.QC_PENDING) throw new Error('Camp không ở trạng thái Chờ QC.');
  var note = String(p.note || '').trim();
  o.qc = o.qc || {};
  o.qc.notes = (o.qc.notes || []).concat([{ by: user.email, at: nowIso_(), decision: p.approve ? 'Duyệt' : 'Trả về', note: note }]);
  if (p.approve) {
    if (o.qc.result && o.qc.result.decision === 'HUMAN_REVIEW' && !note) throw new Error('Camp có mục ORANGE (cần người duyệt): ghi chú lý do duyệt.');
    o.status = STATUS.QC_OK; o.qc.approvedBy = user.email; o.qc.approvedAt = nowIso_();
  } else {
    if (!note) throw new Error('Ghi rõ lý do trả về để người lên camp sửa.');
    o.status = STATUS.DRAFT;
  }
  writeOrder_(o);
  logAction_(user.email, o.id, p.approve ? 'QC duyệt' : 'QC trả về', '', 'OK', note);
  notify_(o, (p.approve ? 'QC đã duyệt: ' : 'QC trả về: ') + o.campaign.name, (note || '') + '\nCamp ' + o.id, [o.createdBy, o.qc.sentBy]);
  return o;
}
