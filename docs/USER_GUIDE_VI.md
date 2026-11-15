# Hướng dẫn Sử dụng MiniClass theo Vai trò (NFR-15)

---

## 1. Dành cho Quản trị viên (Admin)

1. **Quản lý Người dùng (`Người dùng`)**:
   - Bấm **"+ Tạo tài khoản"** để cấp tài khoản mới cho Giáo viên, Học sinh hoặc Admin khác. Người dùng mới sẽ bắt buộc phải đổi mật khẩu ở lần đăng nhập đầu tiên.
   - Bấm **"Nhập từ CSV"** để tạo hàng loạt tài khoản Học sinh theo mẫu `Họ tên, Username, Email, Mật khẩu tạm`.
   - Bấm **"Đặt lại MK"** để cấp mật khẩu tạm mới (tự nhập hoặc sinh ngẫu nhiên hiển thị 1 lần).
   - Bấm **"Khóa / Mở khóa"** để tạm ngưng quyền truy cập mà không làm mất dữ liệu.
2. **Quản lý Lớp học (`Lớp học`)**:
   - Tạo lớp mới và chỉ định Giáo viên phụ trách, hoặc đổi Giáo viên phụ trách khi cần.
   - Xóa lớp vĩnh viễn bằng cách gõ lại chính xác tên lớp để xác nhận.
3. **Giám sát & Cấu hình (`Nhật ký hệ thống` & `Cấu hình`)**:
   - Tra cứu lịch sử thao tác quan trọng trong 12 tháng tại mục **Nhật ký hệ thống**.
   - Tùy chỉnh danh sách đuôi file cho phép nộp bài, dung lượng tối đa (MB) và chế độ màu nhãn trạng thái tại mục **Cấu hình**.

---

## 2. Dành cho Giáo viên (Teacher)

1. **Tạo & Quản lý Lớp học**:
   - Vào mục **Lớp học** → bấm **"+ Tạo lớp mới"**.
   - Trong trang chi tiết lớp, chuyển sang tab **Thành viên lớp** → bấm **"+ Thêm học sinh vào lớp"** để tìm và chọn nhiều học sinh cùng lúc.
2. **Soạn Buổi học & Bài giảng Markdown**:
   - Tại tab **Buổi học & Bài giảng**, bấm **"+ Tạo buổi học mới"**.
   - Sử dụng trình soạn thảo Markdown 2 khung (Soạn thảo bên trái, Xem trước thời gian thực bên phải). Có thể kéo-thả hoặc dán (`Ctrl+V`) ảnh trực tiếp vào khung soạn thảo.
   - Đính kèm tài liệu học tập (≤ 20 MB/file, tối đa 10 file).
   - Bật **"Yêu cầu học sinh nộp bài tập"** và chọn hạn nộp (**Deadline**) nếu buổi học có bài tập.
   - Chọn **"Lưu nháp"** (học sinh chưa thấy) hoặc **"Công bố buổi học"** (học sinh nhận thông báo ngay).
3. **Chấm điểm & Xuất Bảng điểm**:
   - Mở buổi học → bấm **"Danh sách bài nộp & Chấm điểm"**.
   - Bấm **"Tải toàn bộ (.ZIP)"** để tải tất cả bài nộp về máy hoặc bấm **"Chấm / Xem bài"** trên từng học sinh để xem trước nội dung file và nhập điểm (thang 10, tối đa 1 chữ số thập phân, ví dụ `8.5`) kèm nhận xét.
   - Nếu học sinh cần nộp lại sau khi đã chấm, bấm **"Cho phép học sinh nộp lại"**.
   - Tại tab **Bảng điểm**, xem ma trận điểm toàn lớp và bấm **"Xuất Excel / CSV"** để tải bảng điểm.

---

## 3. Dành cho Học sinh (Student)

1. **Đăng nhập lần đầu**:
   - Đăng nhập bằng `username` và mật khẩu tạm do Admin cấp → Hệ thống yêu cầu đổi sang mật khẩu mới (tối thiểu 8 ký tự, gồm cả chữ và số).
2. **Xem Bài giảng & Tài liệu**:
   - Trên **Trang chủ**, xem danh sách các lớp mình tham gia và danh sách **Bài tập cần nộp / Sắp đến hạn**.
   - Bấm vào từng buổi học để đọc bài giảng đã định dạng và tải về các tài liệu đính kèm.
3. **Nộp bài & Xem điểm**:
   - Tại khu vực **Nộp bài tập** ở cuối buổi học, kéo-thả hoặc chọn 1 file bài làm (≤ 10 MB), nhập ghi chú ngắn (nếu có) và bấm **"Nộp bài"**.
   - Có thể nộp lại nhiều lần trước khi Giáo viên chấm điểm (bản mới sẽ thay thế bản cũ; nếu nộp sau Deadline sẽ gắn nhãn **Trễ hạn**).
   - Khi Giáo viên chấm xong, điểm số và nhận xét sẽ hiển thị ngay tại buổi học và trong tab **Bảng điểm**.
