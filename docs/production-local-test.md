# Áp dụng migration 0004–0008 và test local với DB production

Hai repo đang dùng nhánh `feature/expand-feature`. Tài liệu này dành cho bản code đã sửa P1 và migration `0007`; không dùng bản migration cũ bị lỗi ép kiểu enum.

## 1. Kết quả kiểm tra hiện tại

**Cập nhật sau khi người dùng chạy migration ngày 2026-09-23:** đã xác minh production ở `0008_enrollment_invites`, `pending: []`, `blockers: []`. Bảng semesters còn trống; lớp DS001 (ID 1) có `semester_id = NULL`. Chuyển đến bước 4 để tạo/gán học kỳ. Không cần chạy lại migration. Lỗi preflight `UNKNOWN` từng được báo không tái hiện khi kiểm tra lại; script nay có `stage` và phân loại timeout/kết nối để chẩn đoán nếu lặp lại. Cảnh báo SSL tự nó không phải bằng chứng migration lỗi.

Các dòng dưới đây là kết quả **trước migration**, được giữ để đối chiếu:

- Production kết nối được qua `DATABASE_URL`, lịch sử đang ở `0003_messy_vulture`.
- Cần áp dụng `0004`, `0005`, `0006`, `0007`, `0008` theo journal.
- Kiểm tra chỉ đọc: có 1 lớp `active`; không có capacity <= 0, vượt capacity, giảng viên sai vai trò, hoặc lịch legacy không nhận diện được tại thời điểm kiểm tra.
- Hash migration `0000–0002` khác do CRLF/LF; đã xác minh nội dung tương ứng. Không sửa lịch sử DB. Preflight tách trường hợp này vào `lineEndingOnly`.
- Production chưa được migrate hoặc gán học kỳ trong phiên sửa code. DB test đã migrate đến `0008`.
- Chưa có thông tin nghiệp vụ về tên/ngày học kỳ và các lớp cần gán. File cấu hình mẫu cố ý không chạy được cho tới khi điền giá trị thật.
- Bản kiểm tra lưu tại `docs/preflight-production-2026-09-23.json`: lớp hiện có là `DS001`, ID `1`. Nếu đây là lớp cần gán, điền `classIds: [1]`; kiểm tra lại inventory trước khi áp dụng.
- Kết quả xác minh: P1/migration/backfill 12/12 PASS (gồm test cha), CRUD 3/3 PASS; backend build/typecheck, frontend TypeScript/i18n/build PASS. Browser E2E chưa chạy trong lượt này.

## 2. Trước khi chạy trên production

Tạo bản backup/snapshot có thể phục hồi ở nhà cung cấp DB và ghi lại thời điểm. Tạm dừng backend production cũ và các job ghi lớp/enrollment trong thời gian chuyển đổi. Backend cũ có thể vẫn ghi lịch JSON và trạng thái cũ, trong khi code mới dùng `class_schedules` và `lifecycle_status`; không để hai phiên bản tiếp tục ghi song song.

Mở PowerShell ở backend:

```powershell
Set-Location D:\classroom\classroom-backend
git branch --show-current
$env:NODE_ENV = 'development'
npm run db:preflight
if ($LASTEXITCODE -ne 0) { throw 'Dừng: xử lý blockers trước khi migrate.' }
```

Lệnh `db:preflight` chạy trong `BEGIN READ ONLY`, không xuất mật khẩu/URL kết nối. Đọc:

- `target`: phải là `DATABASE_URL` khi thao tác production.
- `pending`: phải đúng các migration còn thiếu; hiện tại là `0004–0008`.
- `blockers` và `migrationHashMismatches`: phải rỗng. `lineEndingOnly` chỉ là khác xuống dòng.
- `invalidCapacity`: phải xử lý trước `0007`, vì CHECK mới yêu cầu capacity > 0.
- `overCapacity`, `invalidTeachers`, `legacySchedulesToReview`: xử lý trước khi nghiệm thu chức năng. Raw JSON được giữ, nhưng lịch không nhận diện được sẽ không tự chuyển đổi.
- `classInventory`: lấy **ID lớp thực tế** để chuẩn bị gán học kỳ, không đoán ID.

`.env` backend giữ `DATABASE_URL` production và `TEST_DATABASE_URL` riêng. Không đổi `TEST_DATABASE_URL` sang production. Không đưa hai URL vào tài liệu, commit hoặc frontend.

## 3. Chạy migration

Chỉ chạy sau bước 2, với backend/job cũ đã dừng ghi:

```powershell
$env:NODE_ENV = 'development'
npm run db:migrate
if ($LASTEXITCODE -ne 0) { throw 'Migration lỗi: dừng và kiểm tra, không chạy bước gán học kỳ.' }
npm run db:preflight
if ($LASTEXITCODE -ne 0) { throw 'Kiểm tra sau migration chưa đạt.' }
```

Drizzle dùng journal và lịch sử DB để chạy phần còn thiếu. Không chạy lại từng file từ `0000`, không dùng `db:generate`/`push` thay cho migration, không tự xóa migration history khi gặp lỗi.

| Migration | Thay đổi |
|---|---|
| 0004 | `is_active`, `preferred_locale`, bảng audit |
| 0005 | Bảng học kỳ và CHECK khoảng ngày |
| 0006 | FK Subject → Class chuyển sang RESTRICT |
| 0007 | `semester_id`, lifecycle/archive, bảng lịch, trạng thái enrollment; giữ lịch JSON gốc |
| 0008 | Enrollment events và mã mời đã hash |

Sau migrate, `pending` phải rỗng và `latestKnownMigration` là `0008_enrollment_invites`. `classesWithoutSemester` có lớp cũ là bình thường: migration thêm cột nhưng không đoán học kỳ. **Không chạy thêm `ALTER TABLE ... ADD semester_id`**.

Nếu migration lỗi, chạy lại preflight để biết mốc đã áp dụng, đọc lỗi và xử lý đúng nguyên nhân trước khi thử lại. Không giả định toàn bộ chuỗi đã rollback. Ưu tiên forward fix; phục hồi backup chỉ trong cửa sổ bảo trì và có tính đến mọi ghi mới sau backup.

## 4. Tạo học kỳ và gán lớp cũ

### Cách A — công cụ gán theo danh sách ID

```powershell
Copy-Item scripts\semester-assignment.example.json scripts\semester-assignment.local.json
notepad scripts\semester-assignment.local.json
```

Điền mã, tên, bốn ngày dạng `YYYY-MM-DD` và `classIds` lấy từ preflight. Theo quy tắc hiện có: ngày bắt đầu <= kết thúc; khoảng đăng ký phải nằm trong khoảng học kỳ. Để test đăng ký hôm nay, hôm nay ở Asia/Bangkok phải nằm trong khoảng đăng ký, nhưng các ngày cần đúng nghiệp vụ của bạn.

Mỗi file chỉ gán một học kỳ; tạo file khác nếu các lớp thuộc học kỳ khác nhau. Không gán toàn bộ lớp bằng một `UPDATE` không có điều kiện.

Xem trước, **chưa ghi dữ liệu**:

```powershell
npm run db:assign-semester -- scripts/semester-assignment.local.json
if ($LASTEXITCODE -ne 0) { throw 'Preview chưa hợp lệ.' }
```

Kiểm tra `target`, ngày, ID/tên lớp và học kỳ hiện có. Khi các giá trị đúng, thực thi:

```powershell
npm run db:assign-semester -- scripts/semester-assignment.local.json --apply
if ($LASTEXITCODE -ne 0) { throw 'Dừng: kiểm tra trạng thái DB trước khi thử lại.' }
npm run db:preflight
```

Công cụ:

- Tạo học kỳ nếu mã chưa tồn tại; nếu đã tồn tại, bốn ngày phải trùng. Không tự sửa thông tin học kỳ đã có.
- Chỉ gán `semester_id` đang NULL; chạy lại cùng cấu hình không gán lại hoặc tạo audit trùng.
- Từ chối ID không tồn tại hoặc lớp đã thuộc học kỳ khác.
- Kiểm tra lịch giảng viên/sinh viên, cả giữa hai học kỳ giao nhau; các kiểm tra và cập nhật nằm trong transaction SERIALIZABLE.
- Từ chối dữ liệu lịch legacy chưa chuyển đầy đủ; lúc đó dùng form lớp để xem lịch gốc và nhập lại lịch đúng trước.
- Ghi audit `class.semester_assigned`, không tạo lịch sử enrollment giả hoặc tự mở lại lớp đã đóng.

Nếu trùng lịch, transaction rollback cả việc tạo học kỳ và gán lớp. Sửa lịch/nhóm học kỳ theo nghiệp vụ rồi thử lại; không bỏ kiểm tra để ép ghi.

Nếu mất kết nối (`ECONNRESET`) đúng lúc commit, kết quả có thể chưa xác định ở phía client. Chạy preflight/preview để kiểm tra trước khi thử lại; công cụ không gán lại các lớp đã thuộc đúng học kỳ.

### Cách B — qua giao diện local

Sau migration, đăng nhập admin → `/semesters` → tạo học kỳ; vào chi tiết lớp → **Sửa lớp học** (`/classes/edit/<ID>`) → chọn học kỳ, kiểm tra lịch, lưu. Form dùng API mới và kiểm tra trùng lịch giống luồng tạo lớp.

Nếu cần đổi một lớp đã có học kỳ sang học kỳ khác, dùng form này; công cụ gán theo ID cố ý không ghi đè.

## 5. Chạy ứng dụng local

Backend dùng các giá trị local sau cùng với `DATABASE_URL` production hiện có:

```dotenv
NODE_ENV=development
PORT=8000
FRONTEND_URL=http://localhost:5173
BETTER_AUTH_URL=http://localhost:8000
```

Giữ `BETTER_AUTH_SECRET` và `ARCJET_KEY` hợp lệ. Không copy bí mật sang Vite. Frontend dùng `VITE_BACKEND_BASE_URL=http://localhost:8000/api/`. Dùng nhất quán `localhost`, không trộn với `127.0.0.1` khi đăng nhập.

Hai cửa sổ PowerShell:

```powershell
# Cửa sổ 1
Set-Location D:\classroom\classroom-backend
$env:NODE_ENV = 'development'
$env:BETTER_AUTH_URL = 'http://localhost:8000'
npm run dev
```

```powershell
# Cửa sổ 2
Set-Location D:\classroom\classroom-frontend
npm run dev
```

Mở `http://localhost:5173`. Đăng nhập, sửa dữ liệu, upload và enrollment là thao tác thật trên các dịch vụ đã cấu hình. Dùng tài khoản/lớp kiểm thử có tên dễ nhận diện; không chạy suite fixture/concurrency trên production. Rate limit vẫn bật trong chế độ development, nên nếu gặp 429, chờ cửa sổ giới hạn thay vì đổi `NODE_ENV=test` khi đang kiểm tra production.

## 6. Kiểm tra sau chuyển đổi

1. Đăng nhập admin; dashboard trả dữ liệu, không còn lỗi aggregate/GROUP BY.
2. Tạo/sửa lớp có học kỳ và lịch 09:00–10:00; không còn lỗi SQL tại dấu `:`.
3. Một lớp cùng giảng viên 10:00–11:00 được phép; 09:30–10:30 bị chặn.
4. Lớp dùng cho enrollment phải có học kỳ, trạng thái `open`, chưa archive, trong kỳ đăng ký, còn chỗ.
5. Sửa lịch lớp có sinh viên sao cho trùng lớp khác của sinh viên: phải bị chặn.
6. Mã mời lớp A dùng cho lớp B bị từ chối và không bị trừ lượt.
7. Kiểm tra `classesWithoutSemester`: các lớp định test không còn nằm trong danh sách.

UI quản lý mã mời/roster hoàn chỉnh và UI Subject đầy đủ vẫn thuộc phần chưa hoàn tất của phase 3/5. Student chưa đăng ký không thấy lớp mới trong danh sách theo scope hiện có; để kiểm tra lần đăng ký đầu, dùng API với session student hoặc admin đăng ký qua API. Không suy ra rằng mọi tiêu chí phase 3–6 đã DONE chỉ từ bộ sửa P1.

Regression chỉ trên DB test:

```powershell
$env:NODE_ENV = 'test'
npm run db:migrate
if ($LASTEXITCODE -ne 0) { throw 'DB test migrate lỗi.' }
npm run test:p1
npm run test:crud
# Trước khi trở lại local + production:
$env:NODE_ENV = 'development'
```

## File bàn giao

- `scripts/db-preflight.mjs`: kiểm tra DB chỉ đọc, trước/sau migration.
- `scripts/assign-semester.ts`: preview và apply có transaction.
- `scripts/semester-assignment.example.json`: cấu hình mẫu cần điền.
- `test/phase-p1.integration.test.ts`: SQL, race, invite, dashboard, rehearsal migration và backfill.
