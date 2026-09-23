# Bản cốt lõi local — 23/09/2026

Đã nối giao diện CRUD người dùng/khoa/môn/học kỳ, lớp/lịch, roster, thêm/hủy sinh viên, tạo/đổi/thu hồi mã mời, tham gia bằng mã, dashboard, tìm kiếm và Anh/Việt với API.

## Chạy lại local

Terminal backend:
```powershell
cd D:\classroom\classroom-backend
$env:NODE_ENV = 'test'
$env:PORT = '8001'
$env:FRONTEND_URL = 'http://localhost:5174'
$env:BETTER_AUTH_URL = 'http://localhost:8001'
npm run dev
```
Dùng TEST_DATABASE_URL đã cấu hình. Tài khoản admin/teacher/student và dữ liệu danh mục mẫu nằm trong `local-test-accounts.json` (gitignored). Nếu cần tạo bộ mới: đặt NODE_ENV=test rồi `npm run seed:local`. Lệnh này tạo thêm tài khoản/danh mục, không xóa dữ liệu cũ.

Terminal frontend:
```powershell
cd D:\classroom\classroom-frontend
$env:VITE_BACKEND_BASE_URL = 'http://localhost:8001/api/'
npx vite --host localhost --port 5174 --strictPort
```
Mở http://localhost:5174. Cấu hình trên dùng DB test riêng; NODE_ENV=development vẫn dùng DATABASE_URL hiện có.

## Test nhanh

1. Đăng nhập admin theo file tài khoản; mở khoa/môn/học kỳ, kiểm tra hoặc tạo dữ liệu.
2. Tạo lớp: chọn môn, giảng viên, học kỳ có khoảng đăng ký bao gồm hôm nay, sức chứa và lịch không trùng; trạng thái open.
3. Trong chi tiết lớp, tạo mã mời và sao chép mã. Mã chỉ hiển thị lúc tạo/đổi.
4. Đăng xuất, đăng nhập student; nhập mã ở danh sách lớp, mở chi tiết rồi hủy đăng ký.
5. Đăng nhập teacher để xem lớp của mình, roster và mã mời; dùng admin để quản lý dữ liệu, vai trò và khóa tài khoản.
6. Thử bộ lọc, dashboard, tìm kiếm và chuyển Anh/Việt.

## Kiểm tra đã thực hiện

- Backend build và test:typecheck đạt.
- Frontend TypeScript, build đạt; parity Anh/Việt đạt 212 keys.
- test:p1 đạt 13/13 (gồm test cha): migration 0004–0008 trong schema tạm, xung đột lịch/sức chứa đồng thời, dashboard, gán học kỳ, join/rotate/roster/cancel.
- Đây là kiểm tra trọng tâm theo yêu cầu, chưa là chứng nhận triển khai production.

## Phần chưa nằm trong đợt này

Phase 8 (waitlist/import/export/outbox), tích hợp email reset mật khẩu và đăng nhập mạng xã hội chưa hoàn thiện. Nút đăng nhập Google/GitHub đã bỏ khỏi form login vì backend chưa cấu hình. Không dựa vào email reset để kiểm thử lúc này.

Chưa deploy hoặc thay đổi production trong đợt hoàn thiện local. Trước khi áp dụng production, xem `production-local-test.md`; lớp cũ thiếu semester_id cần được gán đúng học kỳ nghiệp vụ, không tự suy đoán ngày học kỳ.

Kiểm tra giao diện: đã đăng nhập admin, tải dashboard/danh sách lớp và tạo thành công lớp `Local demo core` (id 115, semester_id 15) trên DB test. Giữ lớp mẫu để người dùng tiếp tục thao tác roster/mã mời.
