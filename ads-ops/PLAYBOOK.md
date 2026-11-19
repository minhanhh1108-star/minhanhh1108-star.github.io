# Meta Ads Ops — Quy trình vận hành

Mục tiêu: user chỉ trao đổi bằng chat, Claude lên camp, báo cáo và đề xuất qua Meta Marketing API.
Không cần mở Ads Manager.

## 0. Kết nối
- Token (System User) được lưu dưới dạng network secret của cloud environment cho host `graph.facebook.com`.
  Proxy tự chèn token vào request. Script **không** đọc token, và tuyệt đối không ghi token vào repo.
- Nếu API trả về lỗi 190 (token hết hạn hoặc bị thu hồi), báo user tạo token mới trong
  Business Settings rồi lưu lại bằng `request_credential` (host `graph.facebook.com`).
- Kiểm tra kết nối: `python3 ads-ops/meta.py accounts`.

## 0b. Trang và biểu mẫu
- Tài khoản OFFICIAL dùng trang "Bot Bán Hàng"; OFFICIAL 2 dùng trang "Bot Bán Hàng - Hà Nội". Biểu mẫu phải cùng trang.
- Đọc biểu mẫu (`/{page_id}/leadgen_forms`) và bài viết cần **page access token**: lấy bằng `GET /{page_id}?fields=access_token`
  rồi truyền `access_token=` cho riêng request đó. Chỉ giữ trong bộ nhớ, không in ra, không ghi file, không commit.

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

### B00. Web app "AI Agent Ads" (Apps Script, thư mục `ads-ops/webapp/`)
Cả nhóm lên camp qua web app; app tự gọi Meta API (token trong Script Properties của dự án Apps Script) và dựng camp
TẠM DỪNG; người duyệt bấm "Bật chạy". Hướng dẫn cài đặt: `ads-ops/webapp/HUONG_DAN_CAI_DAT.md`.
Khi user nhờ sửa app: sửa file trong `ads-ops/webapp/`, chạy lại giả lập (gas_mock + e2e) nếu có, rồi nhắc user dán
bản mới và tạo "Phiên bản mới" cho bản triển khai. Sheet kế hoạch bên dưới là cách làm cũ (vẫn dùng được).

### B01. QC nội dung trước khi dựng camp (`webapp/QC.gs`)
- Luồng: Nháp → Gửi QC → (chủ app) Duyệt/Trả về → Đã QC → Hoàn thành → dựng camp tạm dừng → bật chạy. Sửa đơn Đã QC → quay về Nháp, phải QC lại.
- Soát tự động theo 2 tài liệu: Policy Engine V3 (mức GREEN/YELLOW/ORANGE/RED/BLACK) + Bộ quy tắc content Chatbot AI (§3, §7–§9, §11–§21).
  RED/BLACK → chặn gửi QC; ORANGE → người QC phải ghi chú khi duyệt; YELLOW → gợi ý sửa; bảng §21 có nút "Sửa nhanh".
- Bài viết có sẵn (post ID): app đọc nội dung bài qua page token để soát.
- Người duyệt QC: `settings.qcReviewers`, để trống = chỉ chủ app. Bộ luật sửa ở Cài đặt → QC nội dung (JSON, regex).
- Khi user nhờ Claude viết/sửa content quảng cáo: tự soát theo cùng bộ luật trước khi đưa.

### B0. Nguồn sự thật: Google Sheet "Kế hoạch quảng cáo Meta (mỗi chiến dịch 1 tab) – v2 nhiều tệp"
Tìm theo tên trên Google Drive (không ghi ID sheet vào repo vì repo công khai). Cấu trúc:
- `Tổng quan`: cột A = tên tab chiến dịch; các cột khác tự đọc từ tab đó (tên, trạng thái, ngân sách, số nhóm, số QC, kiểm tra).
- `Đang chạy`: báo cáo camp đang chạy (chiến dịch ▸ nhóm • quảng cáo, nhắm chọn, số liệu 7 ngày). Chỉ xem; AI dựng lại khi
  user nói "cập nhật số liệu".
- `Mẫu chiến dịch` + mỗi chiến dịch 1 tab (nhân bản từ mẫu). Ô cố định trong mỗi tab:
  - ① B4 tên, B5 trạng thái, B6 tài khoản (trống = mặc định), B7 trang (tự), B8 ngành, B9 khu vực, B10 ngân sách đặt ở
    ("Chiến dịch"/"Nhóm quảng cáo"), B11 ngân sách chiến dịch/ngày, B12 biến thử nghiệm, B13 ghi chú;
    G4 tổng ngân sách, G5 số nhóm, G6 số QC sẽ tạo, G7 mục tiêu chi phí/lead, G8 chi phí/lead 7 ngày (AI), G9 ID chiến dịch (AI), G10 kiểm tra.
  - ② Nhóm = cột B..F (Nhóm 1..5), hàng 18 tên, 19–22 tệp bao gồm 1–4, 23–25 tệp loại trừ 1–3 (mỗi ô 1 mã), 26 tuổi,
    27 giới tính, 28 địa điểm, 29 mở rộng, 30 ngân sách nhóm, 31 bắt đầu, 32 kết thúc, 33 khung giờ; 34 số QC, 35 kiểm tra;
    36–40 AI ghi (ID, chi tiêu, lead, chi phí/lead, tần suất).
  - ③ Quảng cáo = hàng 44–53: A chạy ở nhóm ("Tất cả" = mọi nhóm có tên, hoặc "Nhóm 1, 3"), B tên, C link Drive,
    D ảnh bìa, E ID bài viết, F nội dung chính, G tiêu đề, H biểu mẫu; I–K tự tính; L–O AI ghi.
  - Mỗi dòng ③ được tạo thành 1 quảng cáo trong MỖI nhóm nó chạy (vd 4 dòng × 3 nhóm = 12 quảng cáo trên Meta).
- `Danh mục`: mặc định, giới hạn, ngành + mục tiêu chi phí/lead, khu vực + mã vùng Meta, tài khoản + trang, biểu mẫu thật,
  thư viện tệp đối tượng thật (OF1 = OFFICIAL, OF2 = OFFICIAL 2; ID tệp chỉ dùng trong đúng tài khoản).

Khi user nói "lên camp <tên tab>":
1. Đọc tab đó; chỉ làm khi B5 = **Sẵn sàng** và G10 = **OK**.
2. Kiểm tra chéo: tệp cũ, trùng tệp + khu vực với camp đang chạy, giới hạn ngân sách, biểu mẫu cùng trang.
3. Dựng trên Meta, tất cả PAUSED: chiến dịch → từng nhóm → mỗi dòng ③ × mỗi nhóm nó chạy. Media: link Drive (tải qua
   Drive connector rồi upload) hoặc ID bài viết (object_story_id). Có khung giờ → ngân sách trọn đời = ngân sách/ngày × số ngày.
4. Báo lại ID và giá trị cần dán vào ô xám (G9, hàng 36 từng nhóm, cột O từng dòng ③), đổi B5 = "Đã dựng".
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
