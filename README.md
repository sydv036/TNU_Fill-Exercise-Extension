# TNU Gemini Study Assistant

Extension Manifest V3 dành cho Chrome/Edge, hỗ trợ quét khóa học TNU, dùng Gemini để gợi ý đáp án và tự điền **bài luyện tập**. Bài kiểm tra tính điểm luôn yêu cầu người dùng xác nhận từng đáp án, và extension không bao giờ tự nộp bài.

## Tính năng đáng chú ý

- Gợi ý ba nhóm model dễ hiểu: khuyên dùng, tiết kiệm và suy luận sâu; danh sách thực tế được kiểm tra lại theo API key.
- Hai chế độ xử lý câu Gemini chưa chắc chắn: **Tự suy luận lại** hoặc **Hỏi tôi**.
- Tab **Đang chạy** hiển thị trực tiếp câu hỏi hiện tại, các lựa chọn và phương án đang được gợi ý.
- Sau khi người dùng tự nộp bài và Moodle mở trang xem lại, extension lưu các đáp án được Moodle xác nhận đúng.
- Lần làm sau, bộ nhớ đáp án được đối chiếu theo nội dung câu hỏi và nội dung lựa chọn, nên không phụ thuộc thứ tự A/B/C/D.
- Có thể xem số đáp án đã nhớ hoặc xóa toàn bộ bộ nhớ trong tab **Cài đặt**.
- Tab **Cài đặt** hiển thị dung lượng cục bộ, cho phép xóa riêng API key hoặc reset toàn bộ dữ liệu extension với bước xác nhận chống bấm nhầm.

## Chạy dự án

```bash
npm install
npm run test
npm run build
```

Sau khi build, mở `chrome://extensions` hoặc `edge://extensions`, bật **Chế độ dành cho nhà phát triển**, chọn **Tải tiện ích đã giải nén**, rồi chọn thư mục `.output/chrome-mv3`.

## Quyền riêng tư

- API key Gemini được lưu trong `chrome.storage.local` và chỉ cho extension truy cập. Khu vực này không phải kho bí mật được mã hóa.
- Chỉ nội dung câu hỏi, phương án và ảnh thuộc câu hỏi được gửi tới Gemini.
- Không gửi cookie, tên tài khoản hoặc toàn bộ HTML trang.
- Bộ nhớ đáp án đúng được lưu cục bộ, tối đa 3.000 câu. Nội dung này có thể xóa bất kỳ lúc nào trong extension.

## Chốt an toàn

- Chỉ `practice` mới được tự chọn đáp án.
- `graded` và loại không xác định chỉ hiển thị gợi ý, chờ người dùng bấm **Áp dụng**.
- Confidence thấp, lỗi API hoặc loại câu không hỗ trợ đều làm phiên chạy tạm dừng.
- Không có luồng bấm `submitall`/“Nộp bài và kết thúc”.
