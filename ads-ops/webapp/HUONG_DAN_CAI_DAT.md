# Web app "Lên camp Meta" (Google Apps Script)

Web app cho cả nhóm lên camp quảng cáo Meta bằng cách tích chọn, không cần mở Ads Manager.
App tự dựng camp trên Meta ở trạng thái **tạm dừng**; chỉ người được giao quyền mới bấm "Bật chạy".

## Các tab

| Tab | Dùng để |
|---|---|
| Đang chạy | Camp đang chạy trên các tài khoản, số liệu 7 ngày, mở ra xem nhóm và quảng cáo. Nhân bản thành đơn mới, tạm dừng |
| Đơn lên camp | Danh sách đơn theo trạng thái: Nháp → Chờ dựng → Đang dựng → Đã dựng (tạm dừng) → Đang chạy / Lỗi |
| + Tạo đơn | ① Chiến dịch → ② Nhóm (nhiều nhóm) → ③ Quảng cáo (dùng chung cho nhiều nhóm) → ④ Kiểm tra. Mỗi phần bấm "Xong" để thu gọn |
| Thư viện | Tệp đối tượng và biểu mẫu thật, đồng bộ từ Meta |
| Nhật ký | Mọi thao tác: ai, lúc nào, ID trên Meta, lỗi |
| Thành viên, Cài đặt | Chỉ quản trị: thêm người, phân quyền, giới hạn ngân sách, ngành và mục tiêu chi phí/lead |

## Vai trò

| Vai trò | Được làm |
|---|---|
| Người viết nội dung | Chỉ sửa phần ③ Quảng cáo của đơn nháp |
| Người chạy quảng cáo | Tạo, sửa, nhân bản đơn; bấm "Hoàn thành" để gửi dựng camp; đồng bộ |
| Người duyệt | Như trên. Nếu được tích "Được bấm Bật chạy" thì bật chạy và tạm dừng camp |
| Quản trị | Tất cả, kể cả thành viên và cài đặt |

Mọi người đăng nhập bằng **email + mã PIN** do quản trị cấp. Lý do: Apps Script không nhận ra người dùng Gmail cá nhân khi app chạy dưới quyền chủ app.

## Cài đặt tự động (Claude đẩy code lên)
1. Bật Apps Script API cho tài khoản: https://script.google.com/home/usersettings → "Google Apps Script API" = Bật.
2. Cấp cho Claude một mã truy cập Google tạm thời (hết hạn sau 1 giờ) qua form bảo mật, phạm vi
   `script.projects` + `script.deployments`. Claude chạy `ads-ops/tools/deploy_webapp.py` để tạo dự án và triển khai.
3. Mở link web app Claude gửi → Google hỏi cấp quyền → Cho phép.
4. Trang "Cài đặt lần đầu" hiện ra → dán token Meta → Cài đặt → ghi lại mã PIN quản trị.

## Cài đặt thủ công (khoảng 15 phút, làm 1 lần)

1. Vào https://script.google.com → **Dự án mới**. Đặt tên "Lên camp Meta".
2. Bấm biểu tượng bánh răng **Cài đặt dự án** → tích **"Hiển thị tệp kê khai appsscript.json"**.
3. Tạo các file với **đúng tên**, dán nội dung từ thư mục này:
   - Tệp tập lệnh (.gs): `Code`, `Meta`, `Validate`, `Sync`, `Build`
   - Tệp HTML: `Index`, `Styles`, `App`, `Setup`
   - Thay nội dung `appsscript.json` bằng file cùng tên ở đây.
4. **Cài đặt dự án → Thuộc tính tập lệnh → Thêm**: `META_TOKEN` = token System User Meta.
   Token chỉ nằm ở đây, không dán vào file nào khác.
5. Mở file `Code`, chọn hàm **`setup`** → **Chạy** → cấp quyền khi Google hỏi.
   Xem **Nhật ký thực thi**: có link cơ sở dữ liệu và **mã PIN quản trị**. Đăng nhập rồi đổi PIN ngay.
6. **Triển khai → Triển khai mới → Ứng dụng web**:
   - Thực thi với tư cách: **Tôi**
   - Người có quyền truy cập: **Bất kỳ ai có Tài khoản Google**
   Sao chép đường link `/exec` và gửi cho nhóm.
7. Trong app, tab **Thành viên**: thêm từng người (email Gmail, vai trò, mã PIN), gửi mã PIN riêng cho họ.
   Người được bật chạy: chọn vai trò "Người duyệt" và tích "Được bấm Bật chạy".
8. Video trên Google Drive phải được **chia sẻ cho email chủ app** (quyền xem), vì app chạy dưới quyền chủ app.

`setup()` tự tạo 3 trình chạy nền: dựng camp mỗi phút, đồng bộ camp đang chạy mỗi giờ, đồng bộ thư viện 6h sáng mỗi ngày.

Sửa code sau này: dán bản mới → **Triển khai → Quản lý bản triển khai → Sửa → Phiên bản mới** (giữ nguyên link).

## Luồng lên camp

1. Tạo đơn mới, hoặc **Nhân bản** một camp đang chạy / một đơn cũ rồi sửa.
2. Điền ① ② ③, bấm "Kiểm tra lại". Lỗi ⛔ phải sửa; cảnh báo ⚠ thì cân nhắc.
3. **Hoàn thành** → trình chạy nền dựng theo thứ tự: tải video/ảnh từ Drive (video lớn tải theo từng đoạn, chạy tiếp qua nhiều phút) → chiến dịch → nhóm → mẫu quảng cáo → quảng cáo. Tất cả **tạm dừng**.
4. Email báo "Đã dựng xong". Người duyệt kiểm tra (trong app hoặc Ads Manager) → **Bật chạy** → gõ đúng tên chiến dịch để xác nhận.

Mỗi dòng quảng cáo ở phần ③ được tạo trong **mọi nhóm được chọn**: 4 quảng cáo × 3 nhóm = 12 quảng cáo trên Meta.

## Chốt chặn an toàn
- Mọi thứ tạo mới đều tạm dừng; bật chạy cần quyền riêng và xác nhận bằng tên.
- Kiểm tra trước khi gửi: giới hạn ngân sách theo chiến dịch và tổng camp mới trong ngày, tệp đúng tài khoản, biểu mẫu đúng trang, tệp cũ, trùng tệp và khu vực với camp đang chạy, khung giờ cần ngày kết thúc.
- Đơn đã gửi không sửa được; muốn đổi thì nhân bản.
- Đơn lỗi giữ nguyên phần đã tạo trên Meta (tạm dừng). Sửa rồi bấm "Chạy lại" thì app làm tiếp phần còn thiếu, không tạo trùng.

## Bảo mật
- Token Meta nằm trong Thuộc tính tập lệnh: **ai có quyền sửa dự án Apps Script đều xem được**. Không chia sẻ dự án; chỉ chia sẻ link web app.
- Cơ sở dữ liệu là một Google Sheet trong Drive của chủ app; không chia sẻ, không sửa tay.
- Sai PIN 5 lần thì khóa 15 phút. Phiên đăng nhập hết hạn sau 8 giờ không dùng.

## Đã kiểm thử / chưa kiểm thử
- **Đã chạy thử trên máy giả lập** (Apps Script và Meta giả, dữ liệu thật của 2 tài khoản): đăng nhập, phân quyền, tạo đơn 1 chiến dịch · 3 nhóm · 4 quảng cáo, kiểm tra lỗi, dựng 11 quảng cáo, tải video 75 MB theo đoạn, ảnh, bài viết có sẵn, bật chạy, nhân bản camp đang chạy, giao diện trên trình duyệt.
- **Chưa thử với Meta thật** — cần làm 1 đơn thử đầu tiên với ngân sách nhỏ và kiểm tra trong Ads Manager trước khi bật:
  - Khung giờ chạy (ngân sách trọn đời + `adset_schedule`).
  - Bật "Advantage+ đối tượng" (Meta có thể yêu cầu tuổi trong một khoảng nhất định).
  - Kích thước đoạn video Meta yêu cầu (app chặn nếu một đoạn > 40 MB).
