# MiniClass – Hệ thống Lớp học Trực tuyến Quy mô nhỏ (v1.0)

Hệ thống quản lý lớp học trực tuyến tối giản được xây dựng đầy đủ theo **Tài liệu Đặc tả Yêu cầu Phần mềm (SRS v1.0)**, bao gồm toàn bộ các tính năng thuộc cả 3 giai đoạn (**MVP Phase 1 + Phase 2 + Phase 3**: `Must`, `Should`, `Could`).

---

## 1. Tính năng nổi bật

- **Xác thực & Bảo mật (`AUTH-01..07`, `NFR-05..11`)**:
  - Không có trang tự đăng ký công khai (`AC-01`, `BR-01`).
  - Mật khẩu băm bằng **Argon2id** (`crypto.argon2Sync`) với chính sách tối thiểu 8 ký tự gồm chữ và số (`NFR-06`).
  - Sai mật khẩu 5 lần liên tiếp → tạm khóa đăng nhập 15 phút (`AUTH-02`).
  - Bắt buộc đổi mật khẩu ở lần đăng nhập đầu tiên hoặc sau khi Admin đặt lại mật khẩu (`AUTH-05`, `AC-02`).
  - Phiên đăng nhập tự động gia hạn và hết hạn sau 7 ngày không hoạt động (`AUTH-03`).
- **Quản trị người dùng & Hệ thống (`USR-01..08`, `ADM-01..03`)**:
  - Tạo, sửa (cố định `username`), khóa/mở khóa, đặt lại mật khẩu (tự nhập hoặc sinh ngẫu nhiên hiển thị 1 lần).
  - Bảo vệ dữ liệu khi xóa tài khoản: chỉ cho phép xóa khi chưa có dữ liệu liên quan, gợi ý chuyển sang **Khóa tài khoản** nếu đã có dữ liệu (`USR-06`).
  - Nhập hàng loạt tài khoản Học sinh từ file **CSV** kèm báo cáo chi tiết từng dòng lỗi (`USR-07`).
  - Dashboard thống kê dung lượng lưu trữ, số lượng tài khoản/lớp/buổi học (`ADM-01`), **Audit Log** lưu 12 tháng (`ADM-02`), và cấu hình động đuôi file / dung lượng nộp bài tối đa (`ADM-03`).
- **Quản lý lớp học & Thành viên (`CLS-01..06`, `MEM-01..05`)**:
  - Giáo viên tự tạo lớp hoặc Admin tạo lớp và gán/đổi Giáo viên phụ trách.
  - Lưu trữ (Archive) lớp học chuyển sang chế độ chỉ-đọc và khôi phục bất kỳ lúc nào (`CLS-04`).
  - Xóa lớp (chỉ Admin) yêu cầu gõ lại chính xác tên lớp để xác nhận (`CLS-05`).
  - Thêm nhiều học sinh cùng lúc (`MEM-01`), xóa học sinh khỏi lớp nhưng vẫn bảo toàn lịch sử bài nộp & điểm cũ nếu thêm lại (`MEM-03`).
- **Buổi học & Trình soạn thảo Markdown (`SES-01..11`)**:
  - Trình soạn thảo Markdown 2 khung (Soạn thảo & Xem trước thời gian thực trên desktop, chuyển tab trên mobile 360px), thanh công cụ định dạng, kéo-thả hoặc dán (`Ctrl+V`) ảnh trực tiếp (`SES-02`, `SES-03`).
  - Tự động lưu nháp mỗi 30 giây (`UC-03`), hỗ trợ trạng thái **Bản nháp** và **Công bố** (`SES-07`).
  - Bộ lọc chống mã độc XSS (`<script>`, `<iframe>`, `on*`) bảo vệ tuyệt đối khi hiển thị bài giảng (`SES-06`, `AC-05`).
- **Nộp bài & Chấm điểm (`SUB-01..11`, `GRD-01..09`)**:
  - Kiểm tra định dạng whitelist và dung lượng (≤ 10 MB) ở cả phía Client và Server (`SUB-03`, `AC-07`).
  - Tự động gắn nhãn **Trễ hạn** khi nộp hoặc nộp lại sau deadline (`SUB-06`, `AC-08`) và tự động tính lại khi Giáo viên đổi deadline (`BR-07`).
  - Khóa nộp lại sau khi đã chấm điểm, trừ khi Giáo viên bấm **"Cho phép nộp lại"** (`SUB-07`, `AC-11`).
  - Xem trước trực tiếp mã nguồn/văn bản (`.py`, `.html`, `.js`, `.txt`, `.md`), ảnh và PDF ngay trên trình duyệt mà không bao giờ thực thi file `.html`/`.js` (`GRD-04`, `NFR-09`, `AC-15`).
  - Tải từng bài nộp theo chuẩn `<username>_<tênbuổi>_<ngày>.<đuôi>` (`GRD-02`) hoặc tải toàn bộ thành 1 file `.zip` (`GRD-03`).
  - Bảng điểm ma trận toàn lớp kèm xuất file **Excel / CSV (UTF-8 BOM)** (`GRD-08`) và bảng điểm cá nhân cho Học sinh (`GRD-09`).
- **Song ngữ Việt / Anh & Giao diện Tối giản (`I18N-01..04`, `UI-01..08`)**:
  - Chuyển đổi tức thời Tiếng Việt (mặc định) và Tiếng Anh, lưu theo tài khoản (`AC-13`), định dạng ngày giờ chuẩn múi giờ `Asia/Ho_Chi_Minh` (`UTC+7`).
  - Tông màu Đen – Trắng – Xám tối giản kèm badge trạng thái đỏ trầm / xanh lá trầm tinh tế (`UI-01`, `UI-02`), hỗ trợ màn hình từ `360px` (`AC-14`).

---

## 2. Yêu cầu hệ thống & Cài đặt nhanh (Local)

- **Runtime**: Node.js `>= 22.5.0` (khuyến nghị Node.js `v26.x` sử dụng trực tiếp `node:sqlite` và `crypto.argon2Sync` tích hợp sẵn, không cần cài đặt thêm thư viện ngoài).

```bash
# 1. Khởi chạy server (tự động tạo CSDL SQLite và dữ liệu mẫu ở lần chạy đầu tiên)
npm start

# 2. Mở trình duyệt tại:
# http://localhost:3000
```

### Các lệnh tiện ích khác

```bash
# Chạy bộ kiểm thử tự động 15 tiêu chí nghiệm thu (AC-01 đến AC-15)
npm test

# Sao lưu CSDL và toàn bộ file upload ra gói ZIP (giữ 30 bản gần nhất)
npm run backup

# Khôi phục dữ liệu từ bản sao lưu mới nhất
npm run restore
```

---

## 3. Tài khoản dùng thử (Seed Accounts)

| Vai trò | Username | Mật khẩu | Ghi chú |
| :--- | :--- | :--- | :--- |
| **Admin** | `admin` | `Admin1234` | Toàn quyền quản trị hệ thống |
| **Giáo viên 1** | `gv_minh` | `Teacher123` | Phụ trách lớp Python & Cấu trúc Dữ liệu |
| **Giáo viên 2** | `gv_lan` | `Teacher123` | Phụ trách lớp Toán Rời Rạc |
| **Học sinh 1** | `hs_an` | `Student123` | Đã có bài nộp & đã được chấm điểm (9.5) |
| **Học sinh 2** | `hs_binh` | `Student123` | Đã có bài nộp đang chờ chấm |
| **Học sinh 3** | `hs_chi` | `Student123` | Chưa nộp bài (dùng để test luồng nộp bài) |
| **Học sinh 4** | `hs_khanh` | `TempPass123` | Tài khoản mới tạo – dùng để test bắt buộc đổi mật khẩu lần đầu (`AC-02`) |

---

## 4. Tài liệu đính kèm

- [Hướng dẫn triển khai & vận hành (Deployment Guide)](./docs/DEPLOYMENT_VI.md)
- [Hướng dẫn sử dụng theo từng vai trò (User Guide)](./docs/USER_GUIDE_VI.md)
