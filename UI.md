# UI Specification: anonymous-chat

Tài liệu này mô tả toàn bộ giao diện hiện tại của `anonymous-chat`, dùng làm brief/prompt cho việc thiết kế lại UI. Ứng dụng là web app tĩnh, local-first, không tài khoản, không backend, không message server và không signaling server.

## 1. Định hướng sản phẩm

- Mã hóa tin nhắn trong trình duyệt bằng Web Crypto.
- Direct chat qua WebRTC DataChannel hoặc manual transport bằng emoji copy/paste.
- Luôn làm trạng thái an toàn nhìn thấy được: unverified, connecting, verified, manual, lỗi checksum, sai khóa và mất đồng bộ.
- Ưu tiên hướng dẫn từng bước, warning đúng lúc và progressive disclosure hơn là nhồi tùy chọn.
- Không tạo cảm giác đây là messenger có server trung tâm, tài khoản hoặc presence online.

## 2. Visual direction

- Dark-first, nền gần đen pha xanh than; có light theme.
- Accent chính neon lime/lime green cho CTA, focus, active state và success.
- Semantic colors: xanh lục cho safe, vàng cam cho caution/connecting/manual, đỏ cho danger/unverified/error.
- Glass surfaces: nền bán trong suốt, border mảnh, blur nhẹ, shadow mềm và sâu.
- Landing có editorial/technical feel: typography lớn, grid bất đối xứng, hero image, ambient blobs, particles, signal line và reveal-on-scroll.
- Workspace dày thông tin hơn landing nhưng vẫn giữ glass cards, lime accent và spacing thoáng.
- Font chính Geist Variable; font mono cho eyebrow, step numbers, safety number, status và metadata.
- Không dùng purple gradient, dashboard template phổ thông hoặc decoration lấn át nội dung bảo mật.

## 3. Global shell

### Privacy banner

Banner ở đầu trang nhắc dùng private browsing window cho cuộc trò chuyện nhạy cảm. Có nút `Dismiss`; đóng banner không thay đổi cách dữ liệu được lưu.

### Header

Header glass, sticky ở phía trên:

- Bên trái: brand `a:` + `anonymous-chat`.
- Bên phải: language selector gồm English, Vietnamese, Japanese, Korean, Arabic, Russian, French, Simplified Chinese, Persian, Ukrainian, German.
- Nút dark/light theme.
- Landing có `Open app`.
- Workspace có `Clear session` màu danger.

Phía sau toàn app là ambient background gồm blob/gradient/particles chuyển động chậm. Phải giảm hoặc tắt motion khi `prefers-reduced-motion: reduce`.

## 4. Landing page

Landing là màn hình mặc định, mục tiêu giải thích trust model trước khi vào handshake.

### Hero

Desktop dùng hai cột:

- Cột trái:
  - Eyebrow mono uppercase `ENCRYPTION STAYS IN THIS BROWSER`.
  - Headline rất lớn `Say less to the network.`.
  - Đoạn mô tả: không account, không message database, kết nối trực tiếp hoặc tự mang ciphertext.
  - Primary CTA `Start a private chat`.
  - Link phụ `See how it works`.
  - Footnote `No install. No account. Session keys stay in memory.`.
- Cột phải là `TrustConsole` glass:
  - Header `SESSION PREVIEW` và trạng thái `LOCAL` có live dot.
  - Khối emoji ciphertext minh họa.
  - Route `01 Your browser` -> `02 Their browser`.
  - Facts: `Accounts stored 0`, `Messages stored 0`, `Runtime dependencies 0`.
- Hero có hero image crop phía sau, overlay tối và parallax nhẹ.

### Trust section

Heading `A SMALLER TRUST SURFACE` / `Privacy claims you can inspect.`. Bento grid gồm:

1. `Local encryption`: Web Crypto chạy trong tab, plaintext không gửi application server. Card rộng.
2. `Ephemeral by design`: reload xóa live keys và visible message history.
3. `No message server`: direct chat dùng peer channel, manual mode tự chọn transport.
4. `Explicit failure`: damaged data, wrong keys và unverified peers dừng flow. Card rộng, có chips `Verified`, `Manual`, `Unverified`.

Cards reveal khi scroll và có spotlight lime khi hover.

### How it works

Heading `THREE DELIBERATE STEPS` / `Make the secure state visible.`. Vertical list:

1. `Exchange one-time codes`.
2. `Compare safety numbers`.
3. `Chat directly or manually`.

### Honest limits

Heading `HONEST LIMITS` / `Private is not invisible.`. Ba cards:

- IP addresses can be visible.
- No independent audit.
- Your device still matters: malware, screenshots, clipboard, keyboard và unlocked screen nằm ngoài phạm vi bảo vệ.

### Closing và footer

Closing CTA `READY WHEN YOU ARE` / `Start with a code, not an account.` / `Open secure workspace`.

Footer có brand, claim `No account. No message server. No silent failures.` và links README, SELF-AUDIT, font license.

## 5. Workspace shell

Workspace mở từ mọi CTA `Open app`, `Start a private chat` hoặc link handshake.

### Desktop

- `.app-view` gần full viewport.
- Grid hai cột: sidebar trái khoảng 320px, content phải chiếm phần còn lại.
- Sidebar sticky glass, cao gần viewport.
- Content là panel glass lớn, có border và padding responsive.

### Sidebar

Theo thứ tự:

1. Workspace heading và nút về landing.
2. Tab chính `Direct chat`.
3. Một trigger `Advanced settings` để progressive disclosure.
4. Advanced sections: TURN, auto-lock, backup, persistence và alternative modes.
5. `Local contacts` chỉ chứa metadata nickname.
6. `Local session` proof ở đáy sidebar, nhắc keys nằm trong memory.

### Workspace header

- Eyebrow `DIRECT WORKSPACE`.
- Heading `Direct chat`.
- Status card: `Manual mode`, `Connecting directly` hoặc `Direct P2P connection`.
- Status detail và dot indicator; connecting dot pulse, P2P dot xanh, manual/caution dot vàng.

## 6. Handshake flow

Handshake là progressive flow 4 bước, có progress dots và labels `Step 1 of 4` tới `Step 4 of 4`.

### Step 0: choose connection

Card centered, max-width khoảng 720px:

- Index `00`, heading `How do you want to connect?`, supporting text.
- Input `Display name`, bắt buộc, lưu local và chỉ là label trong handshake hiện tại.
- Primary `Start a conversation`.
- Secondary `Join a conversation`.

Nếu có session persistence, restore card có thể xuất hiện trước role picker:

- `Continue your previous session`.
- Session PIN.
- `Continue session` và `Handshake again`.
- Lỗi PIN inline màu đỏ.

### Step 1A: start a conversation

Card `01 Start a conversation`:

- Contact nickname local-only, có datalist.
- Note reload sẽ xóa keys/history.
- `Create offer`.

Sau khi tạo offer:

- Offer code readonly textarea.
- Actions `Copy`, `Share link`, `Show QR`.
- QR canvas chỉ hiện khi bấm Show QR.
- Share link dùng fragment `#code=...`, có warning public handshake data.
- Khối `Paste their answer` mở ra, có preview `You are about to connect with {name}.` và nút `Finish connection`.
- Lần đầu thấy responder name thì hiện preview; người dùng phải xác nhận đúng peer trước khi tiếp tục.

### Step 1B: join a conversation

Card `02 Join a conversation`:

- Preview `{name} wants to chat with you on anonymous-chat.` hiện ngay khi offer hợp lệ được paste/import.
- Textarea `Paste their offer`.
- `Scan QR with camera`.
- Scanner active gồm video camera, canvas processing và `Stop scanner`.
- Camera track phải dừng sau successful scan, stop, pagehide hoặc lỗi.
- `Create answer`.

Sau khi tạo answer: readonly answer code, `Copy`, `Share link`, `Show QR`, và IP disclosure alert màu vàng. Alert nói P2P lộ IP peer, Google STUN thấy IP lúc connect nhưng không mang message content.

### Step 3: safety verification

Chat main bị ẩn, chỉ security card centered max-width khoảng 680px:

- Security state banner danger/unverified.
- Heading `Verify your peer`.
- Đọc safety number của mình cho peer qua kênh khác; nhập số peer đọc lại, không tự gõ số của mình.
- Bắt buộc delay 8 giây; xác nhận trước 15 giây cho soft warning.
- Safety number card: label `Your safety number`, 8 ký tự uppercase monospace, letter spacing rộng.
- Input `Number read by your peer`, disabled trong delay, nhận 8 ký tự hex.
- Inline mismatch error màu đỏ, không có bypass.
- Primary `Confirm peer code`.
- Secondary `Try again` và danger `Restart handshake`.
- Chỉ unlock khi local confirmation và remote `verification_ack` đều có.

### Step 4: active chat

- Heading `ACTIVE SESSION` / `Conversation`.
- Badge xanh `Not saved`.
- Compact security button `Verified` + `View safety number`.
- Warning về late/out-of-order messages và key destruction.
- Message list scrollable, empty state nhắc verify trước khi nói.
- Composer gồm textarea và `Send`, disabled trước khi verified.
- Tin local căn phải, lime gradient, chữ tối; tin peer căn trái, surface tối, border nhẹ.
- Message có metadata mono và action copy nhỏ.

## 7. Fallback và recovery

### Manual fallback

Khi channel đóng hoặc heartbeat timeout, status chuyển manual/caution nhưng giữ ratchet trong memory:

- Khối `Encrypted emoji to send` readonly + Copy.
- Khối `Incoming emoji` + `Decrypt`.
- `Create a reconnect offer`.

### Heartbeat timeout

Ping/pong mỗi 15 giây. Không có pong trong 30 giây phải hiện hướng dẫn manual/reconnect, kể cả WebRTC vẫn báo connected.

### Ratchet drift

Khi vượt 1.000 positions hoặc key đã destroy:

- Recovery box caution/danger.
- `Key synchronization was lost.`.
- Giữ visible history nhưng báo message cũ có thể không decrypt lại.
- `Set up again` xóa secrets hiện tại, giữ visible history và quay về handshake.

## 8. Advanced settings

`Advanced settings` là accordion ẩn mặc định.

### TURN relay

- Label `Optional TURN relay`, badge `Advanced`.
- URL `turn:` hoặc `turns:`.
- Help text: mặc định Google STUN, TURN do user cung cấp, app không vận hành relay.
- `Save setting`.

### Auto-lock

- Label `Auto-lock`, badge `View protection`, toggle off mặc định.
- Khi bật: minutes mặc định 5 (giới hạn 1-120), PIN, confirm PIN, `Save setting`.
- Locked overlay: `WORKSPACE LOCKED`, `Enter your auto-lock PIN`, input, error và `Unlock`.
- Đây chỉ là casual-viewing barrier, không chống script đang chạy trong page.

### Encrypted backup

- Badge `Manual only`.
- Backup PIN, `Export backup`, `Import backup`, file picker JSON.
- Help text: chỉ current ratchet state và contact metadata, không live sync.

### Keep session after reload

- Badge `Optional convenience`, toggle off mặc định.
- Khi bật: `Lock with PIN` hoặc `Let this browser hold the key`.
- PIN/confirm PIN, weak PIN warning, note khi off không lưu gì, `Save session setting`.

### Alternative modes

Cuối panel có tabs `Manual passphrase` và `One-time pad`.

## 9. Manual passphrase mode

Panel heading + two-column form.

### Encrypt

- Shared passphrase password input.
- Strength/entropy note.
- Dưới 60-bit: Encrypt disabled và hiện warning panel.
- Override cần gõ chính xác `I understand this passphrase may be guessed.`.
- Message to encrypt textarea, `Encrypt`, readonly encrypted emoji textarea, `Copy`.

### Decrypt

- Incoming emoji textarea.
- `Decrypt`.
- Result box lớn, placeholder trước khi có kết quả.
- Checksum failure phải nói transfer damage; valid checksum nhưng GCM fail phải nói wrong key/tampering.

## 10. One-time pad mode

Đây là advanced tool, không được nổi bật hơn direct chat:

- Warning key phải random, đủ dài, không reuse byte.
- Key file input, generate/download key file, key size.
- Role A/B selector và direction/capacity warning.
- Encrypt/decrypt panels tương tự manual mode.
- Hiển thị rõ offset/reuse; không tạo cảm giác OTP tự động an toàn.

## 11. Responsive behavior

Breakpoint chính khoảng 768px:

- Landing hero từ hai cột thành một cột.
- Workspace thành một cột.
- Sidebar thành top mode rail với các tab gọn.
- Contacts, local proof và workspace heading ẩn trên mobile.
- Khi verifying/chatting, nav ẩn; chat chiếm gần toàn bộ màn hình.
- Chat header có `Back` để về role picker.
- Two-column forms thành một cột; role buttons xếp dọc khi hẹp.
- Header mobile rút gọn brand, language selector và clear-session thành phần compact.
- QR scanner, safety number, composer và error toast không được tràn ngang hoặc bị keyboard che.

## 12. Motion

- Hero staggered fade-up.
- Sections reveal khi scroll.
- Ambient blobs drift, hero image parallax nhẹ.
- Buttons hover/press/magnetic trên desktop pointer fine.
- Connecting dot pulse, error toast slide/fade, message bubble fade-up.
- Luôn có text thay cho animation; tắt/giảm tất cả motion với reduced-motion.

## 13. Component inventory

`PrivacyBanner`, `SiteHeader`, `LanguageSelect`, `ThemeToggle`, `LandingHero`, `TrustConsole`, `BentoTrustGrid`, `HowItWorksSteps`, `HonestLimits`, `WorkspaceShell`, `WorkspaceSidebar`, `AdvancedSettingsAccordion`, `ConnectionStatus`, `HandshakeProgress`, `RolePicker`, `SessionRestoreCard`, `OfferCard`, `AnswerCard`, `QrDisplay`, `QrScanner`, `IpDisclosure`, `SafetyVerificationCard`, `ChatPanel`, `MessageList`, `MessageBubble`, `Composer`, `ManualFallbackPanel`, `RatchetRecovery`, `ManualPassphrasePanel`, `WeakPassphraseOverride`, `OtpPanel`, `AutoLockOverlay`, `ErrorToast`, `ClearSessionDialog`.

## 14. Accessibility

- Dùng semantic header/main/nav/aside/section/form/dialog.
- Mọi input có label hoặc accessible name.
- Connection status, errors và decrypted result dùng aria-live phù hợp.
- Không chỉ dùng màu cho safe/caution/danger; luôn có text/icon.
- Focus ring rõ trên cả dark/light theme.
- Tất cả flow dùng được bằng keyboard.
- QR scanner có stop action và camera error rõ ràng.
- Safety number contrast cao, select/copy được.
- Hỗ trợ RTL Arabic/Persian bằng logical CSS properties.
- Tôn trọng reduced motion.

## 15. Không được thay đổi khi redesign

- Không biến app thành SaaS/dashboard có account, avatar online, inbox hoặc presence.
- Không che warning về IP, STUN, no audit, device compromise và ephemeral state.
- Không cho gửi trước mutual safety verification.
- Auto-lock, backup và persistence luôn opt-in, không được trông như mặc định.
- Không thêm TURN mặc định ngoài Google STUN.
- QR/camera không phải đường duy nhất; paste code và manual fallback luôn phải có.
- Không dùng claim `fully anonymous`, `untraceable`, `military-grade` hoặc `audited`.
- Ratchet recovery phải giữ visible history nhưng nói rõ message cũ có thể không decrypt lại.

## 16. Mục tiêu redesign

UI mới phải tạo cảm giác đây là một privacy tool có chủ đích, bình tĩnh và minh bạch, không phải messenger thương mại giả lập. Người mới phải hiểu trong vài giây rằng dữ liệu nằm trong browser, sau đó được dẫn qua handshake từng bước. Người dùng nâng cao vẫn truy cập được TURN, backup, persistence, manual passphrase và OTP mà không làm rối luồng chính.
