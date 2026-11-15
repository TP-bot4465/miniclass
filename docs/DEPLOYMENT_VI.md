# Tài liệu Triển khai & Vận hành Hệ thống MiniClass (NFR-13, NFR-15)

## 1. Kiến trúc Triển khai

MiniClass sử dụng kiến trúc **Monolith tối giản**:
- **Application Server**: Node.js (`src/server.mjs`) phục vụ đồng thời REST API (`/api/*`) và giao diện SPA (`public/`).
- **Cơ sở dữ liệu**: SQLite ở chế độ `WAL (Write-Ahead Logging)` tại `./data/miniclass.sqlite`, đáp ứng tốt quy mô < 100 tài khoản và 50 người dùng đồng thời (`NFR-01`).
- **Lưu trữ file**: Nằm tại `./data/uploads/{images,attachments,submissions}` tách biệt hoàn toàn khỏi thư mục web công khai `public/` (`NFR-08`). Mọi yêu cầu tải file đều đi qua API kiểm tra phân quyền và đổi tên bằng UUID.

---

## 2. Triển khai bằng Docker Compose (Khuyến nghị trên VPS)

```bash
# 1. Sao chép file cấu hình môi trường
cp .env.example .env

# 2. Chỉnh sửa SESSION_SECRET và cấu hình SMTP trong .env
# 3. Khởi chạy container
docker compose up -d --build
```

Cấu hình Reverse Proxy (Nginx / Caddy) phía trước cổng `3000` để kích hoạt HTTPS tự động qua Let's Encrypt (`NFR-05`):

```nginx
server {
    listen 443 ssl http2;
    server_name miniclass.example.com;

    client_max_body_size 25M;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

---

## 3. Sao lưu tự động & Khôi phục dữ liệu (NFR-13)

### 3.1 Sao lưu hằng ngày
Lệnh `npm run backup` thực hiện:
1. Checkpoint dữ liệu WAL của SQLite (`PRAGMA wal_checkpoint(TRUNCATE)`).
2. Đóng gói file cơ sở dữ liệu `miniclass.sqlite` và toàn bộ thư mục `uploads/` vào 1 file nén `.zip` có gắn nhãn thời gian tại `./data/backups/`.
3. Tự động giữ lại **30 bản sao lưu gần nhất** và xóa các bản cũ hơn.

Thiết lập Cronjob chạy tự động mỗi ngày lúc 02:00 sáng:
```cron
0 2 * * * cd /app && npm run backup >> /var/log/miniclass-backup.log 2>&1
```

### 3.2 Khôi phục (Restore)
```bash
# Khôi phục từ bản sao lưu mới nhất
npm run restore

# Hoặc khôi phục từ một file zip cụ thể
node scripts/restore.mjs ./data/backups/miniclass-backup-2026-11-15T10-32-49-267Z.zip
```
