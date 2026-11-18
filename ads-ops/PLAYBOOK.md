# Meta Ads Ops — Quy trình vận hành

Mục tiêu: user chỉ trao đổi bằng chat, Claude lên camp, báo cáo và đề xuất qua Meta Marketing API.
Không cần mở Ads Manager.

## 0. Kết nối
- Token (System User) được lưu dưới dạng network secret của cloud environment cho host `graph.facebook.com`.
  Proxy tự chèn token vào request. Script **không** đọc token, và tuyệt đối không ghi token vào repo.
- Nếu API trả về lỗi 190 (token hết hạn hoặc bị thu hồi), báo user tạo token mới trong
  Business Settings rồi lưu lại bằng `request_credential` (host `graph.facebook.com`).
- Kiểm tra kết nối: `python3 ads-ops/meta.py accounts`.

## 1. Nguyên tắc an toàn (bắt buộc)
| # | Quy tắc |
|---|---|
| 1 | Mọi object mới (campaign, ad set, ad, bản copy) đều tạo ở trạng thái **PAUSED**. |
| 2 | **BẬT** camp chỉ khi user nói rõ "bật / chạy / OK chạy" cho đúng object đó. Lúc chạy lệnh mới thêm `--confirm`. |
| 3 | Đổi budget: luôn cho user xem trước (chạy không có `--confirm`), user đồng ý rồi mới thêm `--confirm`. Thay đổi > 30% cần thêm `--force` và phải có lý do rõ. |
| 4 | Không xóa object. Muốn bỏ thì chỉ tắt (PAUSED). |
| 5 | Budget mới phải từ 150.000 đến 1.000.000 đ/ngày, tổng camp mới trong 1 ngày không quá 2.000.000 đ (theo tab Cấu hình). Script tự chặn mức trên. |
| 6 | Mọi thay đổi được ghi vào `ads-ops/logs/changes.jsonl` (không commit). |
| 7 | Đề xuất phải kèm số liệu (spend, kết quả, CPA, kỳ so sánh). Không đề xuất theo cảm tính. |

## 2. Các yêu cầu user có thể nói, và việc Claude làm

### A. "Báo cáo" / "tuần này camp thế nào"
1. Chạy `meta.py accounts`, chỉ lấy các tài khoản có chi tiêu.
2. Chạy `meta.py report --account X --preset last_7d` (kỳ trước dùng `--preset last_14d`, hoặc so sánh với `last_week_mon_sun`).
3. Chạy `meta.py audit --account X`.
4. Trả lời theo đúng format ở mục 4.

### B0. Nguồn sự thật: Google Sheet "Lên camp Meta – 1 sheet (v4: nhắm chọn + số liệu thực tế)"
Tìm theo tên trên Google Drive (không ghi ID sheet vào repo vì repo công khai). Chỉ 2 tab:
- `Lên camp`: **1 dòng = 1 quảng cáo**. Dòng có "Trạng thái" = bắt đầu chiến dịch mới (Ngành, Khu vực, Ngân sách/ngày,
  Ngày bắt đầu, Tài khoản). Dòng có "Tệp đối tượng" = bắt đầu nhóm quảng cáo mới (Tệp loại trừ, Tuổi). Ô trống = thừa hưởng
  từ dòng trên trong cùng chiến dịch/nhóm. Cột "Video/ảnh hoặc ID bài viết": link Drive = tạo mới (cần Nội dung chính),
  dạng `pageid_postid` = dùng bài viết có sẵn. Ô trống ở Tài khoản/Tuổi/Biểu mẫu = lấy mặc định.
  Nhóm có thêm Giới tính, Địa điểm (tỉnh/thành trong tab Danh mục, kèm mã vùng Meta), Mở rộng của Meta
  ("Advantage+ đối tượng", "Mở rộng địa điểm", trống = tắt).
  Nhóm cột "SỐ LIỆU 7 NGÀY" (cột xám) là số thật theo từng quảng cáo; khi user nói "cập nhật số liệu", kéo insights
  `last_7d` cấp ad và đưa bảng giá trị để dán (hoặc dựng lại file).
  Ngân sách: "Ngân sách chiến dịch/ngày" có giá trị → ngân sách cấp chiến dịch; để trống → dùng "Ngân sách nhóm/ngày" ở từng
  dòng bắt đầu nhóm. Lịch: "Bắt đầu/Kết thúc (ngày giờ)" giờ Việt Nam điền ở từng dòng bắt đầu nhóm; "Khung giờ chạy" (vd `8-12, 19-23`,
  `T2-T6 8-22`) là lịch theo giờ của nhóm → Meta bắt buộc ngân sách trọn đời: đổi thành ngân sách/ngày × số ngày, báo user số này.
- `Danh mục`: mặc định cố định (mục tiêu khách hàng tiềm năng + biểu mẫu tức thì, ngân sách cấp chiến dịch, CTA, ghi nhận
  1 ngày sau khi nhấp, Advantage+ đối tượng tắt, vị trí Advantage+, tắt đề xuất tự động), giới hạn ngân sách, ngành + chi phí
  mỗi lead mục tiêu, khu vực, tài khoản + trang, biểu mẫu, thư viện tệp đối tượng thật (mã OF1-/OF2- theo tài khoản,
  LAL = tương tự, KH = tệp khách hàng → ID trên Meta; ID tệp chỉ dùng được trong đúng tài khoản đó).

Khi user nói "lên camp theo sheet" hoặc chỉ ra dòng cần dựng:
1. Lấy các chiến dịch Trạng thái = **Sẵn sàng** và mọi dòng thuộc chiến dịch đó có Kiểm tra bắt đầu bằng "OK".
2. Kiểm tra chéo: tệp cũ (ghi rõ nếu vẫn dùng), ngân sách trong giới hạn, không trùng tệp + khu vực với chiến dịch đang chạy,
   ngân sách dưới ngưỡng "chỉ nên dùng 1 nhóm" mà có nhiều nhóm thì cảnh báo.
3. Dựng trên Meta, tất cả PAUSED, theo mặc định ở tab `Danh mục`; định dạng (video/ảnh) xác định theo file thực tế.
4. Báo lại: ID chiến dịch, nhóm, quảng cáo và nội dung cần ghi vào 2 cột xám ("ID quảng cáo trên Meta", "Ghi chú của AI"
   kèm ID chiến dịch/nhóm), đổi Trạng thái thành "Đã dựng" hoặc "Lỗi kiểm tra". Connector Drive chỉ đọc được sheet.
5. Chỉ bật chạy khi user xác nhận.

### B. "Lên camp ..." (camp mới)
1. Làm rõ brief, tối đa 5 câu hỏi nếu thiếu: sản phẩm hoặc ngành, vùng, tệp, budget/ngày, creative (video_id hoặc file), form lead.
2. **Ưu tiên copy cấu trúc đang thắng**: chọn ad set có CPA tốt nhất (theo audit), rồi chạy
   `meta.py copy --id <adset|campaign> --name "..." --daily-budget N`.
   Cách này giữ nguyên tệp, loại trừ, form và pixel đã kiểm chứng, nên ít lỗi hơn tạo mới.
3. Nếu bắt buộc tạo mới: copy `specs/TEMPLATE.json` thành `specs/<tên>.local.json`, điền thông tin, chạy `--dry-run`,
   cho user xem rồi mới tạo thật.
4. Creative mới: dùng `upload-image` cho ảnh. Video thì user gửi video_id hoặc upload sẵn lên Page/Library.
5. Báo lại cho user: ID của object, trạng thái PAUSED, tóm tắt cấu hình. Hỏi "Bật chạy không?".

### C. "Tối ưu" / "nên làm gì"
Chạy audit, rồi đề xuất theo thứ tự tác động: **Tắt** (đang đốt tiền) → **Scale** (có lãi) → **Làm mới creative** (fatigue) → **Test mới**.
Mỗi đề xuất ghi rõ: hành động, object, lý do có số liệu, tác động ước tính (VND/ngày), rủi ro.

### D. "Tắt X" / "bật X" / "tăng budget X"
Thực hiện theo nguyên tắc ở mục 1. Xác nhận lại đúng tên và ID trước khi làm.

## 3. Luật quyết định (cấu hình trong `config.json`)
- **Tắt**: tiêu ≥ 2× target CPA mà không có kết quả; hoặc CPA > 1.5× target khi đã tiêu ≥ 2× target.
- **Scale**: CPA < 0.8× target và có ≥ 10 kết quả trong kỳ. Mỗi lần tăng tối đa +20%, cách nhau ≥ 3 ngày.
- **Theo dõi**: frequency > 2,5 (dấu hiệu creative fatigue); CTR < 0.8% sau 2.000 impressions (hook yếu).
- Ad set mới chạy < 3 ngày hoặc chưa qua learning: chỉ theo dõi, không tắt (trừ khi đốt tiền rõ ràng).
- Luật chỉ là bộ lọc đầu tiên. Claude phải tự kiểm tra lại ngữ cảnh (camp mới, sự kiện, mùa vụ) trước khi đề xuất.

## 4. Format báo cáo (tiếng Việt, ngắn)
1. **Tóm tắt 3 dòng**: tổng chi, tổng kết quả, CPA so với target và so với kỳ trước.
2. **Bảng** top camp theo chi tiêu: spend, kết quả, CPA, CTR, frequency.
3. **Việc cần làm** (tối đa 5): Tắt / Scale / Creative / Test, mỗi việc kèm ID và tác động.
4. **Rủi ro và dữ liệu thiếu** (ví dụ: chưa nối dữ liệu chất lượng lead hoặc doanh thu từ CRM).
5. Câu chốt: "Duyệt mục nào để tôi thực hiện?"

## 5. Báo cáo tự động
Một scheduled task chạy mỗi thứ Hai, mở session mới trên repo này, thực hiện mục 2A cho mọi tài khoản có chi tiêu
và gửi báo cáo về. Task này **chỉ đọc và đề xuất**, không tự thay đổi gì trên tài khoản.

## 6. Giới hạn đã biết
- KPI hiện tại là `lead` (lead form trên Meta), **không phải** lead chất lượng hay doanh thu. Muốn tối ưu đúng,
  cần nối dữ liệu từ CRM (Conversions API, hoặc export deal và CPA theo deal).
- Mục tiêu chi phí mỗi lead theo ngành lấy từ sheet; `target_cpa` chung (127.000) chỉ dùng khi không xác định được ngành của camp.
