# TNU Gemini Study Assistant

Extension Manifest V3 dành cho Chrome/Edge, hỗ trợ quét khóa học TNU, dùng Gemini để gợi ý đáp án và tự điền **bài luyện tập**. Bài kiểm tra tính điểm luôn yêu cầu người dùng xác nhận từng đáp án, và extension không bao giờ tự nộp bài.

## Tính năng đáng chú ý

- Gợi ý ba nhóm model dễ hiểu: khuyên dùng, tiết kiệm và suy luận sâu; danh sách thực tế được kiểm tra lại theo API key.
- Hai chế độ xử lý câu Gemini chưa chắc chắn: **Tự suy luận lại** hoặc **Hỏi tôi**.
- Tab **Đang chạy** hiển thị trực tiếp câu hỏi hiện tại, các lựa chọn và phương án đang được gợi ý.
- Sau khi người dùng tự nộp bài và Moodle mở trang xem lại, extension lưu các đáp án được Moodle xác nhận đúng.
- Bộ nhớ được chia theo nguồn có tên đầy đủ dạng **Khóa học # Tuần # Bài**; trước khi chạy, người dùng chọn đúng phần đã làm để chỉ đối chiếu trong phần đó.
- Bài kiểm tra bắt buộc dừng từng câu và chỉ cho **Áp dụng** sau khi nút **Kiểm tra lại** xác nhận cache/gợi ý ban đầu đồng thuận với một lượt Gemini suy luận độc lập; nếu mâu thuẫn hoặc thiếu tin cậy, extension khóa áp dụng tự động.
- Có thể bật chế độ dừng từng câu trên bài luyện tập để thử luồng kiểm tra kép mà không cần dùng bài kiểm tra thật.
- Ở bước chuẩn bị, người dùng chọn chính xác từng slide/giáo trình muốn đính kèm. Chỉ các đoạn liên quan từ tài liệu đã chọn mới được đưa vào lượt trả lời và lượt kiểm tra lại của Gemini; không chọn thì Gemini không nhận tài liệu.
- Lần làm sau, bộ nhớ đáp án được đối chiếu theo nội dung câu hỏi và nội dung lựa chọn, nên không phụ thuộc thứ tự A/B/C/D.
- Có thể xem số đáp án đã nhớ hoặc xóa toàn bộ bộ nhớ trong tab **Cài đặt**.
- Tab **Cài đặt** hiển thị dung lượng cục bộ, cho phép xóa riêng API key hoặc reset toàn bộ dữ liệu extension với bước xác nhận chống bấm nhầm.
- Tab **Tài liệu** tự nhận diện slide, giáo trình và bài giảng theo từng tuần, đọc nội dung PDF rồi lập chỉ mục cục bộ.
- Có thể tìm từ khóa trong toàn môn mà không cần Gemini, hoặc nhờ Gemini tổng hợp từ các đoạn liên quan nhất và dẫn lại đúng tài liệu, tuần, số trang.
- Có thể cập nhật/xóa chỉ mục riêng từng môn; chỉ mục được giới hạn dung lượng để không làm nặng hồ sơ Chrome.
- Trong **Cài đặt**, có thể bật/tắt việc tham khảo chỉ mục tài liệu khi Gemini trả lời quiz. Lựa chọn được lưu lại; khi tắt, Gemini tự suy luận chỉ từ câu hỏi và phương án.

## Chạy dự án

```bash
npm install
npm run test
npm run build
```

Sau khi build, mở `chrome://extensions` hoặc `edge://extensions`, bật **Chế độ dành cho nhà phát triển**, chọn **Tải tiện ích đã giải nén**, rồi chọn thư mục `.output/chrome-mv3`.

## Quyền riêng tư

- API key Gemini được lưu trong `chrome.storage.local` và chỉ cho extension truy cập. Khu vực này không phải kho bí mật được mã hóa.
- Khi làm quiz, chỉ nội dung câu hỏi, phương án và ảnh thuộc câu hỏi được gửi tới Gemini. Khi hỏi tài liệu, chỉ tối đa tám đoạn khớp nhất được gửi, không gửi toàn bộ tệp.
- Không gửi cookie, tên tài khoản hoặc toàn bộ HTML trang.
- Bộ nhớ đáp án đúng được lưu cục bộ, tối đa 3.000 câu. Nội dung này có thể xóa bất kỳ lúc nào trong extension.
- Văn bản trích từ slide/giáo trình được lưu trong vùng dữ liệu riêng của extension; có thể xóa theo môn hoặc reset toàn bộ.

## Chốt an toàn

- Chỉ `practice` mới được tự chọn đáp án.
- `graded` và loại không xác định chỉ hiển thị gợi ý, chờ người dùng bấm **Áp dụng**.
- Confidence thấp, lỗi API hoặc loại câu không hỗ trợ đều làm phiên chạy tạm dừng.
- Không có luồng bấm `submitall`/“Nộp bài và kết thúc”.
