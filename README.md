# TNU Fill Exercise Assistant V3.2

Chrome/Edge extension hỗ trợ làm bài luyện tập trên Moodle TNU. V3.3 tự động trao đổi với tab Gemini, ChatGPT, Claude hoặc DeepSeek Web đã đăng nhập, giữ Gemini API độc lập và không tự nộp bài.

## Trạng thái tích hợp AI Web

| Provider | Trạng thái | Ghi chú |
| --- | --- | --- |
| ChatGPT Web | READY | Gửi prompt và đọc phản hồi mới trong tab đã bind. |
| Claude Web | READY khi đăng nhập | Kiểm tra editor trước khi bắt đầu. |
| Gemini Web | READY | Gửi prompt và nhận response trong tab Gemini đã bind. |
| DeepSeek Web | READY khi đăng nhập | Hỗ trợ gửi prompt, đọc JSON streaming, ảnh và tạo chat mới. |
| Local AI Web fixture | TEST ONLY | Hoàn tất pipeline tự động trong môi trường giả lập `127.0.0.1`; không gọi dịch vụ AI thật. |

Extension không dùng API riêng của OpenAI/Claude làm provider chính và không yêu cầu các API key đó cho AI Web. Cấu hình/key cũ được giữ trong storage; các mục API legacy không xuất hiện trong provider selector chính. Không dùng private endpoint, cookie hay session token để vượt giới hạn của website.

### Audit cầu nối `Extension_Protoeic`

Đã đọc manifest, service worker, `content/gemini.js`, `content/protoeic.js` và README trong project tham khảo. TNU chỉ tái sử dụng ý tưởng định tuyến request có ID, báo tiến độ/result/error qua background, tách bước submit khỏi bước chờ phản hồi, và xác minh chat mới trước khi dùng. Các ý tưởng này đã được ánh xạ vào `ANSWER_QUESTION`, lifecycle `waiting → dispatching → in_flight → completed/unknown`, `WebAIAdapter`, correlation bằng `sessionId/requestId/executionEpoch/questionId`, và `createVerifiedConversation`.

Không chép `findOrCreateGeminiTab()` vì nó chọn tab Gemini được dùng gần nhất thay vì tab người dùng bind. Không chép `fillEditor()` hoặc selector DOM của Gemini. Không chép polling `model-response` với ngưỡng ổn định 2,2 giây, retry tự gửi ở chat mới sau timeout, hay parser A–D; các cách đó không xác nhận chắc request đã hoàn tất, có thể gửi trùng và không ánh xạ được option ID của TNU. Không dùng bộ trích xuất câu hỏi ProTOEIC cho Moodle.

V3.2 dùng content script trên đúng tab người dùng chọn. Nó không đọc cookie/token, không gọi private endpoint và không tự tìm tab gần nhất. Mỗi response phải khớp session, request, execution epoch, question và conversation hiện tại; response cũ bị loại bỏ.

## Sử dụng với hai cửa sổ Chrome/Edge

1. Cài extension từ `release/v3.3.1/chrome-mv3` hoặc `release/v3.3.1/edge-mv3`.
2. Mở trang làm bài TNU và mở tab AI Web trong **cùng một profile trình duyệt**.
3. Mở **Hàng đợi**, chọn tab TNU, provider Web và tab AI; bấm **Liên kết hai tab**.
4. Bấm **Kiểm tra liên kết** để xác nhận editor, đăng nhập và conversation identity.
5. Chọn bài và **Từ câu hiện tại**. Extension gửi prompt, ảnh nếu provider nhận được file input, cache và tài liệu đã chọn sang tab AI rồi chỉ nhận JSON khớp request.

Danh sách tab dùng các tab mà extension nhìn thấy trong profile hiện tại. Window ID và Tab ID được lưu cùng phiên; đổi focus giữa cửa sổ không làm mất binding. Đóng, tải lại hoặc chuyển tab sang domain khác sẽ yêu cầu bind lại. Nếu editor hoặc nút gửi của provider thay đổi, bước **Kiểm tra liên kết** sẽ báo lỗi trước khi bắt đầu.

## Gemini API

Trong tab **AI**, Gemini API giữ key, model discovery từ danh sách model hỗ trợ `generateContent`, kiểm tra khả năng, retry có điều kiện, ngân sách usage và kiểm tra phản hồi. Các lời gọi API thật chỉ phát sinh khi người dùng chọn Gemini API, cấu hình key và bắt đầu yêu cầu. Key lưu trong `chrome.storage.local`, không phải kho bí mật được mã hóa.

Trong **Cài đặt**, có prompt riêng cho Gemini API, chế độ cache, số đoạn tài liệu, ngưỡng tin cậy, retry, giới hạn yêu cầu/token/chi phí ước tính và chế độ kiểm tra kép. Các key OpenAI/Claude đã lưu không bị xóa, nhưng không cần dùng cho provider Web hoặc Gemini API chính.

## Dữ liệu câu hỏi, ảnh, cache và tài liệu

Question builder dùng nội dung, loại câu, lựa chọn, ảnh TNU, cache theo chế độ đã chọn và các đoạn tài liệu được chọn. Prompt gắn Request ID/Question ID, yêu cầu trả JSON bằng option ID ổn định, và đánh dấu cache/tài liệu là dữ liệu tham khảo. Ảnh được xác minh trước khi gửi; lỗi đọc hoặc đính kèm làm dừng câu đó. Tối đa 5 đoạn tài liệu được dùng mặc định, có thể tăng tới 20.

Tab **Tài liệu** lập chỉ mục PDF cục bộ theo môn. Người dùng có thể tìm từ khóa hoặc chọn các tài liệu sẽ được đưa vào câu hỏi. Cache đáp án chỉ được học khi người dùng tự nộp và Moodle hiển thị trang xem lại có đáp án đúng.

## Dừng, đổi provider và khôi phục

- **Dừng** vô hiệu hóa execution epoch cũ, abort observer và giữ vị trí câu.
- Khi đổi provider/model, phiên chỉ tiếp tục với lựa chọn đã xác nhận và binding mới.
- Response đến muộn không được áp dụng vào TNU.
- Nếu kết quả gửi đi chưa rõ, phiên chuyển sang UNKNOWN và không tự gửi lại. Nếu fixture xác nhận generation đã dừng thì có thể Resume an toàn; nếu không, người dùng phải kiểm tra tab AI và đối soát rõ ràng.
- Worker MV3 restart khôi phục run từ storage; response đã lưu được dùng lại mà không gửi request lần hai.
- Bài kiểm tra tính điểm vẫn dừng để người dùng xác nhận. Extension không bấm **Nộp bài và kết thúc**.

Conversation rotation mặc định sau 10 câu hoàn tất, cấu hình tại **Cài đặt**; `0` tắt rotation. Adapter xác minh identity chat mới trước khi gửi câu tiếp theo. Gemini API dùng request độc lập, không dùng bộ đếm chat.

## Chạy và kiểm thử

```powershell
npm install
npm run typecheck
npm test
npm run test:coverage
npm run build:release
npm run test:release
```

`test:e2e:web` mở TNU fixture và local AI fixture trong hai cửa sổ trình duyệt, kiểm tra streaming, ảnh, rotation, Stop/switch/resume và dừng trước khi nộp. `test:e2e`/`test:e2e:auto` kiểm tra các luồng API fixture cũ; chúng không gọi API thật. `test:release` kiểm checksum artifact rồi chạy E2E trên đúng bản Chrome/Edge build.

### Release artifacts

`npm run build:release` tạo thư mục riêng, không xóa `.output` và không đóng/kill Chrome/Edge. Release trước được giữ để rollback.

- Chrome: `release/v3.3.1/chrome-mv3`
- Edge: `release/v3.3.1/edge-mv3`
- SHA-256 receipt: `release/v3.3.1/release-manifest.json`

Trong `chrome://extensions` hoặc `edge://extensions`, bật **Chế độ dành cho nhà phát triển**, bấm **Tải tiện ích đã giải nén** và chọn thư mục tương ứng.

### Smoke test Gemini API thật

Mặc định runner không gửi yêu cầu. `npm run test:real-api` chỉ chạy Gemini API khi người dùng chủ động bật `TNU_REAL_SMOKE=1`, cung cấp `GEMINI_API_KEY`, `TNU_GEMINI_MODEL`, giá tham khảo, `TNU_REAL_SMOKE_MAX_REQUESTS` (tối đa 3, gồm model discovery) và `TNU_REAL_SMOKE_MAX_COST_USD` lớn hơn 0. Nếu thiếu cấu hình, trạng thái là **NOT RUN**. AI Web được kiểm thử riêng qua content bridge và fixture trình duyệt.

## Quyền riêng tư và an toàn

- API key, cache đáp án, cài đặt và chỉ mục tài liệu lưu trong profile extension; có thể xóa trong **Cài đặt**.
- Khi chọn Gemini API, nội dung câu hỏi, ảnh và tài liệu/cache đã chọn được gửi tới Google Gemini API. Không gửi cookie hoặc toàn bộ HTML TNU.
- Khi dùng local fixture, nội dung chỉ được gửi tới máy chủ giả lập loopback do bộ E2E khởi động.
- Khi chọn AI Web, prompt, ảnh, cache và tài liệu đã chọn được đưa vào tab provider mà người dùng đã bind.
- Chỉ bài luyện tập được tự điền theo thiết lập. Bài tính điểm cần xác nhận; extension luôn dừng trước bước nộp.
