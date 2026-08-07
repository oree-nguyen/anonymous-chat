# Self-Audit Report — anonymous-chat

Đây là quá trình chính AI đã viết code tự đọc và kiểm tra lại code của mình. Việc này có giá trị trong việc bắt các lỗi implementation phổ biến, đặc biệt là tái sử dụng nonce, vòng đời khóa, race condition và xử lý lỗi, nhưng không tương đương với một cuộc audit bảo mật độc lập do chuyên gia thực hiện. Self-audit có thể chịu thiên kiến xác nhận, không thay thế penetration testing trên môi trường chạy thật, và không phát hiện được lỗi nằm trong implementation Web Crypto của từng trình duyệt.

## Tóm tắt

- Tổng số phát hiện: 16
- Nghiêm trọng: 6 | Trung bình: 6 | Thấp/thông tin: 4
- Code sản phẩm đã sửa trong vòng này: Không. Theo yêu cầu self-audit, báo cáo toàn cảnh được tạo trước khi quyết định sửa.
- Test sau audit: 37 test; 24 pass, 0 fail, 13 TODO tái hiện các kỳ vọng an toàn hiện chưa đạt.

Không nên dùng phiên bản hiện tại cho nội dung thực sự nhạy cảm trước khi ít nhất các phát hiện nghiêm trọng được xử lý và có một người có chuyên môn bảo mật review độc lập.

## Kết quả checklist implementation 1a–1g

- **1a — Nonce/IV:** Có một lệnh `subtle.encrypt`, mặc định sinh IV mới bằng `crypto.getRandomValues`. Tuy nhiên API công khai cho phép caller truyền `options.iv`, nên invariant “mọi lần mã hóa đều tự sinh IV” chưa được cưỡng chế. Handshake chỉ chứa SDP và public key công khai, không mã hóa AES và không có IV để tái sử dụng. OTP từ chối rollback trong một tracker, nhưng không ngăn tái sử dụng giữa hai phía hoặc nhiều tab.
- **1b — So sánh nhạy cảm:** Không tìm thấy so sánh thủ công MAC/tag/key trong luồng sản phẩm. AES-GCM xác thực tag ở native Web Crypto. `equalBytes` dùng XOR tích lũy cho dữ liệu cùng độ dài; nhánh trả sớm khi khác độ dài không làm lộ bí mật trong các call site hiện tại vì key/hash đều có độ dài cố định. Việc sort safety number có early return nhưng chỉ xử lý public key công khai.
- **1c — Vòng đời khóa:** Ratchet ghi đè chain key cũ ở đường chạy thành công và message key được zeroize. Tuy nhiên chain key hiện tại được lưu rõ trong `localStorage`; một số đường lỗi và nút xóa phiên chưa chủ động zeroize toàn bộ bản sao trong RAM.
- **1d — Oracle lỗi:** Có. UI hiển thị nguyên văn lỗi codec, envelope, padding và decrypt, nên lỗi sai khóa, ciphertext hỏng và emoji sai định dạng có thể phân biệt.
- **1e — Random:** Không có `Math.random()` trong codebase. Salt, IV và OTP key mặc định đều dùng `crypto.getRandomValues()`.
- **1f — Race ratchet:** Có. `RatchetState` không có mutex/Promise queue; test đồng thời tái hiện hai lần `next()` cùng trả sequence 1 và cùng message key.
- **1g — Padding oracle:** AES-GCM xác thực trước khi unpad nên nhánh padding không tạo oracle cho luồng AES. OTP không có xác thực và gọi cùng hàm unpad có loop/early-return phụ thuộc dữ liệu, vì vậy luồng OTP vẫn có oracle lỗi/thời gian tiềm năng.

## Danh sách phát hiện

### [NGHIÊM TRỌNG] Hai chiều hội thoại dùng cùng một chain và cùng message key

- **File/dòng:** `app.js:132`, `app.js:133`, `crypto/ratchet.js:12`
- **Mô tả:** Send ratchet và receive ratchet đều được khởi tạo trực tiếp từ cùng `rootKey`, không có nhãn hướng A→B/B→A. Ở cùng sequence, hai phía tạo đúng cùng một AES key. Đây là lỗi cách ghép KDF/ratchet, liên quan mục 1a và mục 3.
- **Vì sao đây là rủi ro:** Kẻ trung gian có thể phản chiếu ciphertext A vừa gửi trở lại A; receive ratchet của A chấp nhận và hiển thị nó như tin từ B. Đồng thời, hai message độc lập ở hai hướng dùng lại cùng khóa AES, trái với mục tiêu “mỗi message một key”.
- **Đã sửa hay chưa:** Chưa — cần thống nhất quy ước vai trò và dẫn xuất hai chain có domain separation mà không làm A/B lệch nhau.
- **Test xác nhận:** `self-audit TODO: opposite directions derive independent message keys`; `self-audit TODO: a reflected outbound envelope is rejected by the sender`.

### [NGHIÊM TRỌNG] Race condition cho phép hai thao tác ratchet dùng cùng sequence và key

- **File/dòng:** `crypto/ratchet.js:27`, `crypto/ratchet.js:31`, `crypto/ratchet.js:36`, `app.js:119`, `app.js:231`
- **Mô tả:** `advanceTo()` đọc rồi cập nhật `position`/`chainKey` qua nhiều `await` nhưng không có queue hoặc mutex. Hai `next()` đồng thời đều có thể đọc position 0 và dẫn xuất step 1. Hai event nhận liên tiếp cũng có thể commit candidate không đúng thứ tự. Liên quan mục 1f.
- **Vì sao đây là rủi ro:** Hai thao tác có thể tái sử dụng message key, phát cùng sequence, hoặc làm receive state lùi lại sau khi một decrypt chậm hơn ghi đè state mới hơn. Hậu quả gồm mất đồng bộ và phá invariant forward secrecy.
- **Đã sửa hay chưa:** Chưa — cần tuần tự hóa toàn bộ read/derive/commit, đồng thời không để lỗi của một job làm hỏng queue.
- **Test xác nhận:** `self-audit TODO: concurrent ratchet advances receive distinct sequences and keys`.

### [NGHIÊM TRỌNG] Chain key được lưu dạng đọc được trong localStorage

- **File/dòng:** `crypto/ratchet.js:49`, `crypto/ratchet.js:50`, `app.js:97`, `app.js:98`, `app.js:102`
- **Mô tả:** `serialize()` xuất `chainKey` base64 và `persistConversation()` ghi thẳng object này vào `localStorage`. Đây không chỉ là “vị trí ratchet” như checklist mục 1c.
- **Vì sao đây là rủi ro:** Base64 không phải mã hóa. Bất kỳ script cùng origin, extension có quyền, người có quyền đọc browser profile hoặc bản backup storage đều có thể lấy khóa hiện tại và giải mã tin tương lai cho tới khi chain thay đổi ngoài tầm quan sát. Việc lưu khóa cũng kéo dài vòng đời bí mật qua restart.
- **Đã sửa hay chưa:** Chưa — đây là trade-off giữa resume sau reload và không lưu khóa; cần người dùng quyết định chính sách rõ ràng. Chỉ lưu position thì không đủ để khôi phục ratchet.
- **Test xác nhận:** `self-audit TODO: serialized ratchet state contains no chain key`.

### [NGHIÊM TRỌNG] Lịch sử plaintext được lưu vào localStorage

- **File/dòng:** `app.js:83`, `app.js:99`, `app.js:102`, `app.js:176`
- **Mô tả:** Toàn bộ `conversationMessages`, gồm trường `text` chưa mã hóa, được ghi và phục hồi từ localStorage dù README nói không có message database. Liên quan mục 1c.
- **Vì sao đây là rủi ro:** Mã hóa trên đường truyền không còn bảo vệ nội dung đã lưu. Một lần đọc browser profile hoặc chạy script cùng origin có thể lấy toàn bộ lịch sử mà không cần phá AES hay ECDH.
- **Đã sửa hay chưa:** Chưa — cần bỏ persistence plaintext hoặc đưa ra thiết kế lưu trữ được người dùng chấp thuận; self-audit không tự đổi kiến trúc.
- **Test xác nhận:** `self-audit TODO: persisted conversations contain no plaintext transcript`.

### [NGHIÊM TRỌNG] OTP có thể tái dùng cùng vùng khóa ở hai hướng

- **File/dòng:** `crypto/otp.js:33`, `crypto/otp.js:38`, `crypto/otp.js:48`, `app.js:14`, `app.js:310`, `app.js:323`
- **Mô tả:** Tracker chỉ biết offset cục bộ. Nếu A và B cùng gửi trước khi nhận message của nhau, cả hai đều cấp phát offset 0 từ cùng key file. Nhiều tab cùng origin cũng không có thao tác reserve nguyên tử. Liên quan mục 1a và phần review OTP.
- **Vì sao đây là rủi ro:** Dùng lại one-time pad giống như dùng lại chìa khóa dùng một lần: XOR hai ciphertext loại bỏ pad và làm lộ quan hệ giữa hai plaintext, có thể dẫn tới khôi phục nội dung.
- **Đã sửa hay chưa:** Chưa — cần chia vùng khóa cố định theo hướng/vai trò hoặc một giao thức cấp phát không thể xung đột.
- **Test xác nhận:** `12: OTP refuses reuse of an already consumed region` chứng minh tracker đơn lẻ chặn rollback; `self-audit TODO: opposite OTP directions cannot allocate the same key bytes` tái hiện lỗ hổng hai phía.

### [NGHIÊM TRỌNG] OTP không xác thực ciphertext và cho phép sửa plaintext có chủ đích

- **File/dòng:** `crypto/otp.js:18`, `crypto/otp.js:23`, `crypto/otp.js:59`, `app.js:324`
- **Mô tả:** OTP chỉ XOR rồi unpad, không có MAC hoặc cơ chế xác thực. Sửa bit trong phần message của ciphertext tạo đúng thay đổi bit tương ứng trong plaintext mà vẫn qua kiểm tra padding. Liên quan mục 1d/1g và phần review OTP.
- **Vì sao đây là rủi ro:** Người sửa được emoji payload có thể thay nội dung người nhận thấy mà ứng dụng không báo lỗi. Tính bí mật của OTP không tự cung cấp tính toàn vẹn/xác thực.
- **Đã sửa hay chưa:** Chưa — thêm xác thực sẽ thay đổi định dạng và cách phân bổ key material, nên cần quyết định giao thức thay vì vá ngầm.
- **Test xác nhận:** `self-audit TODO: OTP ciphertext modification is rejected`.

### [TRUNG BÌNH] Snapshot ratchet cũ có thể tái tạo key đã dùng

- **File/dòng:** `app.js:237`, `app.js:239`, `app.js:247`, `crypto/ratchet.js:49`, `crypto/ratchet.js:53`
- **Mô tả:** Ratchet advance và gửi/hiển thị message xảy ra trước khi `localStorage` được cập nhật. Nếu tab crash, reload, storage quota lỗi hoặc snapshot cũ được restore trong cửa sổ đó, state cũ tạo lại message key đã tiêu thụ. Không có version chống rollback hay commit nguyên tử. Liên quan mục 1a/1f.
- **Vì sao đây là rủi ro:** Một vị trí ratchet tưởng đã hủy có thể sống lại. Điều này làm mất forward secrecy theo kỳ vọng và có thể gây key/sequence reuse hoặc lệch state hai bên.
- **Đã sửa hay chưa:** Chưa — cần thiết kế thứ tự commit và cơ chế phát hiện rollback; chỉ đảo một dòng persist có thể gây mất message khi send thất bại.
- **Test xác nhận:** `self-audit TODO: restoring a stale snapshot cannot recreate a consumed message key`.

### [TRUNG BÌNH] Caller có thể ép AES-GCM dùng IV chỉ định

- **File/dòng:** `crypto/aes.js:33`, `crypto/aes.js:34`, `crypto/aes.js:40`
- **Mô tả:** Đường mặc định sinh IV mới đúng cách, nhưng export `encryptAesGcm()` chấp nhận `options.iv`. Không có production call site hiện tại truyền IV, nhưng invariant an toàn không được cưỡng chế. Liên quan mục 1a.
- **Vì sao đây là rủi ro:** Một caller mới hoặc refactor sau này có thể vô tình truyền lại IV cũ. Tái sử dụng IV với cùng AES-GCM key có thể phá nghiêm trọng tính bí mật và xác thực.
- **Đã sửa hay chưa:** Chưa — nên loại bỏ override khỏi API production hoặc tách helper test-only.
- **Test xác nhận:** `self-audit: default AES-GCM encryption generates a fresh IV for every call` pass; `self-audit TODO: callers cannot override the AES-GCM IV` ghi nhận phần chưa đạt.

### [TRUNG BÌNH] UI phân biệt lỗi codec, format, padding và sai khóa

- **File/dòng:** `app.js:23`, `app.js:25`, `app.js:26`, `app.js:281`, `crypto/emoji-codec.js:67`, `crypto/aes.js:53`
- **Mô tả:** `reportError()` đưa nguyên văn `error.message` lên UI. Emoji sai nhận lỗi “invalid symbol”, envelope sai nhận lỗi format, còn sai passphrase/ciphertext nhận lỗi decrypt chung. Liên quan mục 1d.
- **Vì sao đây là rủi ro:** Các lỗi khác nhau tạo oracle nhỏ cho người cung cấp dữ liệu độc hại và không đáp ứng yêu cầu một thông báo chung ở biên UI. Chi tiết kỹ thuật vẫn có thể giữ trong log debug cục bộ nếu cần.
- **Đã sửa hay chưa:** Chưa — cần map lỗi ở UI boundary sang một thông báo chung, không nhất thiết làm mất lỗi typed bên trong module.
- **Test xác nhận:** `self-audit TODO: malformed emoji and cryptographic failure expose one generic message`.

### [TRUNG BÌNH] OTP tiêu thụ offset trước khi biết giải mã thành công

- **File/dòng:** `app.js:322`, `app.js:323`, `app.js:324`
- **Mô tả:** Luồng nhận gọi `reserve()` trước `otpDecrypt()` và `fromUtf8()`. Ciphertext hỏng hoặc sai key làm decrypt thất bại nhưng offset đã được ghi vào localStorage. Liên quan mục 1a/1d.
- **Vì sao đây là rủi ro:** Một message hỏng có thể “đốt” vĩnh viễn một vùng pad và làm message hợp lệ ở cùng offset không bao giờ mở được, tạo denial of service và lệch trạng thái hai bên.
- **Đã sửa hay chưa:** Chưa — cần xác thực trước reserve và vẫn phải bảo đảm hai decrypt đồng thời không cùng commit một vùng.
- **Test xác nhận:** `self-audit TODO: failed OTP decryption does not consume key bytes`.

### [TRUNG BÌNH] Unpadding có nhánh phụ thuộc dữ liệu trong luồng OTP không xác thực

- **File/dòng:** `crypto/aes.js:18`, `crypto/aes.js:20`, `crypto/aes.js:21`, `crypto/aes.js:22`, `crypto/otp.js:60`
- **Mô tả:** `unpadPlaintext()` dừng sớm theo length marker và byte padding sai đầu tiên. Với AES-GCM, dữ liệu chỉ tới đây sau khi tag hợp lệ nên không phải padding oracle. Với OTP, ciphertext chưa xác thực đi thẳng vào hàm này. Liên quan mục 1g.
- **Vì sao đây là rủi ro:** Lỗi và thời gian xử lý phụ thuộc plaintext sau XOR. Khả năng khai thác từ xa bị hạn chế vì transport OTP là thủ công, nhưng đây vẫn là kênh phân biệt dữ liệu do implementation tạo ra.
- **Đã sửa hay chưa:** Chưa — sửa đúng cần đi cùng cơ chế xác thực OTP; chỉ viết loop “constant-time” không giải quyết tính malleable.
- **Test xác nhận:** Chưa có timing test đáng tin cậy trong Node; test tamper OTP ở trên xác nhận dữ liệu chưa xác thực có thể tới unpadding.

### [TRUNG BÌNH] Thư mục qr/ không triển khai QR/scan theo ràng buộc gốc

- **File/dòng:** `qr/qr-encode.js:70`, `qr/qr-decode.js:13`, `README.md:74`
- **Mô tả:** Đây là visual matrix riêng có CRC, không có Reed–Solomon, perspective correction, thresholding hoặc camera decode như giả định trong mục 2. README đã trung thực ghi đây là tính năng optional bị hoãn và UI không quảng bá nó là QR chuẩn.
- **Vì sao đây là rủi ro:** Không có nguy cơ làm lộ khóa vì handshake chỉ mang dữ liệu công khai. Rủi ro là độ tin cậy và không đáp ứng ràng buộc: module không thể đọc ảnh/camera hoặc sửa lỗi như QR chuẩn. CRC hiện có từ chối corruption thay vì âm thầm trả rác.
- **Đã sửa hay chưa:** Chưa — zero-dependency QR đầy đủ là một thay đổi tính năng/kiến trúc, bị cấm trong vòng self-audit và cần người dùng quyết định.
- **Test xác nhận:** `11: visual code matrix round-trips multiple payload sizes`; `self-audit: visual matrix corruption is rejected by checksum validation`.

### [THẤP/THÔNG TIN] Một số bản sao khóa không được zeroize trên đường lỗi/kết thúc one-shot

- **File/dòng:** `crypto/message.js:32`, `crypto/message.js:35`, `crypto/message.js:45`, `crypto/message.js:54`, `crypto/ratchet.js:39`, `webrtc/peer.js:116`
- **Mô tả:** Message key và chain key cũ được xóa ở đường thành công, nhưng candidate chain key sau decrypt lỗi, chain state tạm của passphrase mode, và identity/root references khi đóng peer không có API dispose thống nhất. Liên quan mục 1c.
- **Vì sao đây là rủi ro:** Secret có thể ở RAM lâu hơn cần thiết. JavaScript không bảo đảm xóa vật lý mọi bản sao, nhưng chủ động fill/null vẫn giảm cửa sổ phơi nhiễm và tránh giữ reference không cần thiết.
- **Đã sửa hay chưa:** Chưa — cần bổ sung lifecycle/dispose có `finally` mà không làm xóa state chính khi decrypt thất bại.
- **Test xác nhận:** Review control flow; không có cách portable để khẳng định xóa vật lý bộ nhớ JavaScript bằng unit test.

### [THẤP/THÔNG TIN] Xóa phiên không chủ động xóa secret đang giữ trong RAM

- **File/dòng:** `app.js:352`, `app.js:354`, `app.js:355`, `app.js:356`
- **Mô tả:** Nút xác nhận đóng transport, gọi `localStorage.clear()` và reload, nên saved state của app không thể phục hồi sau reload. Tuy nhiên `sendRatchet`, `receiveRatchet`, `otpKey`, key pair và plaintext arrays không được fill/null trước reload. Liên quan mục 1c.
- **Vì sao đây là rủi ro:** Reload thường làm document cũ được thu gom, nhưng chủ động xóa reference/byte array là hygiene tốt hơn và phù hợp với yêu cầu “xóa sạch”. Không thể cam kết xóa vật lý trong browser JS.
- **Đã sửa hay chưa:** Chưa. Kiểm tra tĩnh xác nhận localStorage được xóa và reload được gọi; chưa chạy browser automation để chứng minh hành vi qua một browser profile thật.
- **Test xác nhận:** Chưa có browser-level test; đây là khoảng trống kiểm thử được ghi nhận, không được báo cáo như đã “pass bảo mật”.

### [THẤP/THÔNG TIN] Offset OTP hỏng trong localStorage biến thành NaN

- **File/dòng:** `crypto/otp.js:33`, `crypto/otp.js:35`, `crypto/otp.js:38`, `crypto/otp.js:40`
- **Mô tả:** `Number(raw)` không được kiểm tra integer/non-negative. Giá trị hỏng như `not-a-number` thành `NaN`; vì `NaN !== NaN`, mọi reserve sau đó đều bị từ chối mà thông báo giống reuse. Liên quan review OTP và mục 1d.
- **Vì sao đây là rủi ro:** Đây chủ yếu là lỗi độ tin cậy/khả năng phục hồi, không làm lộ khóa. Người dùng không được chỉ rõ storage hỏng và OTP mode bị khóa vĩnh viễn cho file đó.
- **Đã sửa hay chưa:** Chưa — cần validate dữ liệu restore và fail bằng lỗi corruption rõ ràng ở lớp nội bộ.
- **Test xác nhận:** `self-audit TODO: malformed persisted OTP offsets are rejected explicitly`.

### [THẤP/THÔNG TIN] emojiToBuf chấp nhận biểu diễn không canonical khi gọi trực tiếp

- **File/dòng:** `crypto/emoji-codec.js:29`, `crypto/emoji-codec.js:40`, `crypto/emoji-codec.js:47`, `crypto/emoji-codec.js:48`
- **Mô tả:** Sau khi đã đủ `byteLength`, decoder vẫn đọc symbol thừa. Nếu các symbol thừa đều có index 0, `buffer` vẫn 0 và input được chấp nhận. `unpackPayload()` an toàn hơn vì kiểm tra chính xác số symbol trước khi gọi. Liên quan mục 2.2.
- **Vì sao đây là rủi ro:** Không gây sai plaintext ở call path hiện tại, nhưng nhiều chuỗi khác nhau decode thành cùng byte array nếu helper được dùng trực tiếp, làm validation không canonical và dễ tạo bug ở caller mới.
- **Đã sửa hay chưa:** Chưa — ưu tiên thấp vì đường production hiện dùng `unpackPayload()` đã chặn độ dài thừa.
- **Test xác nhận:** Test gốc `9: emoji codec round-trips every byte length from 0 through 256` đã phủ các biên 0, 1 và mọi residue bit; `self-audit TODO: direct emoji decoding rejects non-canonical extra zero symbols` ghi nhận phần chưa đạt.

## Các ràng buộc kiến trúc đã đối chiếu (mục 4)

- [x] Không có `Math.random()`.
- [x] Không có `XMLHttpRequest`, CDN import hoặc ES module import từ URL.
- [x] `fetch()` duy nhất nằm ở `i18n.js:20` và chỉ đọc file locale cùng origin; không gọi dịch vụ ngoài.
- [x] Network endpoint duy nhất trong runtime code là Google STUN đã được cho phép ở `webrtc/peer.js:5`.
- [x] `package.json` không khai báo runtime/dev dependency; không có `node_modules`; browser chỉ import module thuộc repo.
- [x] Không có `manifest.json` hoặc `sw.js` trong repo.
- [x] Không có signaling server, TURN server hoặc backend được thêm.
- [ ] QR chuẩn zero-dependency/camera decoder chưa được triển khai. README ghi rõ giới hạn; đây vẫn là ràng buộc/tính năng bị hoãn cần người dùng quyết định.

## Các kiểm tra không tạo phát hiện

- ECDH root key được kiểm tra với 8 cặp identity ngẫu nhiên mới; hai phía luôn cho cùng root key.
- Safety number sort hai public key theo byte, cho kết quả giống nhau bất kể thứ tự A/B trong 8 lần ngẫu nhiên.
- QR visual matrix hiện tại kiểm tra magic, length và CRC; thay đổi module dữ liệu bị từ chối thay vì trả payload rác.
- Emoji codec đã round-trip mọi độ dài từ 0 đến 256 byte, bao gồm 0, 1 và các biên không chia hết cho 10 bit/symbol.
- Không có IV handshake riêng vì handshake không được mã hóa; SDP và ECDH public key là dữ liệu công khai. IV nội dung được tạo trong AES helper độc lập.
- Không thấy chain key cũ bị log hoặc giữ trong mảng debug. Ở đường ratchet thành công, array cũ được fill 0 và message key được fill 0 trong `finally`.

## Khuyến nghị bước tiếp theo

1. Sửa trước bốn cụm nghiêm trọng: directional KDF + chống reflection, queue/mutex cho ratchet, chính sách không lưu plaintext/chain key rõ, và thiết kế lại OTP có phân vùng hai chiều cùng xác thực.
2. Sau mỗi cụm sửa, bỏ trạng thái `TODO` của regression test tương ứng và yêu cầu test pass thật; không xóa test để làm số liệu đẹp.
3. Chạy browser-level test cho xóa phiên, reload, nhiều tab, burst message WebRTC và storage failure. Unit test Node hiện không mô phỏng đầy đủ các tình huống này.
4. Nhờ một chuyên gia bảo mật độc lập review `crypto/ratchet.js`, định dạng envelope và mô hình persistence trước khi dùng cho nhu cầu nhạy cảm; sau đó mới thực hiện penetration testing trên deployment thật.
5. Giữ nguyên cảnh báo README rằng dự án chưa được audit độc lập. Báo cáo này không phải chứng nhận “đã qua kiểm tra bảo mật”.

## Cập nhật sau vòng sửa lỗi

Ngày cập nhật: 2026-08-07.

Vòng sửa này giữ nguyên kiến trúc static/zero-dependency/WebRTC thủ công. Kết quả kiểm thử sau sửa là **41 pass, 0 fail, 0 TODO**. Cảnh báo đầu báo cáo vẫn còn hiệu lực: đây không phải audit bảo mật độc lập hay penetration test.

### Trạng thái 6 phát hiện nghiêm trọng

1. **Hai chiều dùng chung chain/message key — Đã sửa.** Public-key byte order gán vai trò A/B ổn định. `createRatchetState()` dùng HKDF với nhãn `ratchet-A-to-B` hoặc `ratchet-B-to-A`; envelope phiên bản 2 mang direction byte và direction nằm trong AES-GCM AAD. Receive chain từ chối envelope sai hướng trước khi derive/decrypt. Test xác nhận: `self-audit TODO: opposite directions derive independent message keys`, `self-audit TODO: a reflected outbound envelope is rejected by the sender`, và `self-audit: ratchet role ordering supports authenticated traffic in both directions` đều PASS.
2. **Race condition ratchet — Đã sửa.** Mỗi `RatchetState` có Promise queue riêng bao trọn derive/read/commit; queue tự phục hồi sau job reject. Encrypt và toàn bộ candidate-decrypt-commit chạy trong cùng lock. Test xác nhận: `self-audit TODO: concurrent ratchet advances receive distinct sequences and keys` và `self-audit: a failed ratchet queue job does not block later jobs` PASS.
3. **Chain key trong localStorage — Đã sửa.** `serialize()` chỉ trả `{ position }`; `restore()` từ metadata bị từ chối và UI yêu cầu bắt tay mới sau reload. Startup migration scrub `chainKey` khỏi record cũ. Test xác nhận: `self-audit TODO: serialized ratchet state contains no chain key` PASS.
4. **Plaintext trong localStorage — Đã sửa.** `persistConversation()` không ghi message history; lịch sử chỉ tồn tại trong RAM và biến mất khi reload. Startup migration loại trường message cũ. Test xác nhận: `self-audit TODO: persisted conversations contain no plaintext transcript` PASS.
5. **OTP hai chiều trùng vùng khóa — Đã sửa.** 64 byte đầu file dành cho hai HMAC key theo hướng; phần còn lại chia thành hai XOR region không giao nhau. Direct handshake tự đặt OTP role theo cùng public-key ordering; chế độ OTP độc lập yêu cầu hai người chọn hai role đối nhau. Test xác nhận: `self-audit TODO: opposite OTP directions cannot allocate the same key bytes` PASS.
6. **OTP không xác thực — Đã sửa.** Native Web Crypto HMAC-SHA256 xác thực domain label, direction, absolute offset và ciphertext trước XOR/unpad. Tag dài 32 byte và dùng key material không trùng vùng XOR. Test xác nhận: `self-audit TODO: OTP ciphertext modification is rejected` và `self-audit: authenticated OTP round-trips independently in both directions` PASS.

### Trạng thái các phát hiện trung bình/thấp

- **Snapshot ratchet cũ — Đã sửa.** Không còn chain key để restore; reload bắt buộc handshake mới. Test `self-audit TODO: restoring a stale snapshot cannot recreate a consumed message key` PASS.
- **Caller override AES-GCM IV — Đã sửa.** `encryptAesGcm()` từ chối property `iv` và luôn gọi CSPRNG nội bộ. Test `self-audit TODO: callers cannot override the AES-GCM IV` PASS.
- **Thông báo lỗi phân biệt — Đã sửa ở UI boundary.** `runDecryption()` luôn hiển thị `openFailed`; lỗi gốc vẫn đi vào console cho debug. Test `self-audit TODO: malformed emoji and cryptographic failure expose one generic message` PASS.
- **OTP tiêu thụ offset trước khi decrypt thành công — Đã sửa.** Verify HMAC, XOR và unpad hoàn tất trước `reserve()`. Test `self-audit TODO: failed OTP decryption does not consume key bytes` PASS.
- **Padding oracle OTP — Đã sửa theo nguyên nhân gốc.** Dữ liệu không có HMAC hợp lệ không tới XOR/unpad; không chỉ thay loop padding để che triệu chứng.
- **Visual matrix không phải QR chuẩn — Chưa sửa.** Đây vẫn là optional feature bị hoãn, được ghi rõ trong README và không xuất hiện trong UI. Reed–Solomon/camera/perspective decode là mở rộng tính năng/kiến trúc, không được tự ý thêm trong vòng sửa này. CRC hiện tại vẫn từ chối corruption trong format nội bộ.
- **Zeroize trên đường lỗi/kết thúc — Đã cải thiện.** Candidate ratchet, passphrase one-shot state, root byte arrays và reachable peer references được dispose trong `finally`/`close()`. Giới hạn vật lý của garbage-collected JavaScript vẫn như cảnh báo ban đầu.
- **Nút xóa phiên chưa chủ động dọn RAM — Đã sửa.** Ratchet, OTP key, plaintext array, transport root/reference được fill/null trước `localStorage.clear()` và reload.
- **OTP offset NaN — Đã sửa.** Offset restore phải là safe integer không âm; dữ liệu hỏng nhận lỗi corruption rõ ràng. Test `self-audit TODO: malformed persisted OTP offsets are rejected explicitly` PASS.
- **Emoji representation không canonical — Đã sửa.** `emojiToBuf()` yêu cầu chính xác số symbol theo byte length. Test `self-audit TODO: direct emoji decoding rejects non-canonical extra zero symbols` PASS.

### Thay đổi tương thích cần biết

- Ratchet envelope mới dùng version 2 và OTP envelope mới dùng version 4; payload từ bản cũ không tương thích.
- Reload không còn resume được direct/manual-fallback ratchet. Người dùng phải bắt tay mới; message history cũ không được khôi phục.
- OTP file tối thiểu là 320 byte. 64 byte dành cho HMAC và mỗi hướng chỉ dùng một nửa phần còn lại.
- Hai bên dùng OTP độc lập phải chọn role đối nhau. Chọn cùng role là sử dụng sai và không an toàn; UI và README đã cảnh báo rõ.
