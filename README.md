<div align="center">

# 🔐 anonymous-chat

### Nhắn tin mã hóa đầu-cuối. Không tài khoản. Không máy chủ. Không dấu vết.

Một web app **100% tĩnh**, chạy hoàn toàn trong trình duyệt của bạn —
mã hóa AES-256-GCM, trao đổi khóa qua ECDH, kết nối trực tiếp P2P qua
WebRTC, ngụy trang bản mã thành chuỗi emoji.

**Mã nguồn mở hoàn toàn — bạn không cần tin chúng tôi, chỉ cần đọc code.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](#-giấy-phép)
[![Zero Backend](https://img.shields.io/badge/backend-none-brightgreen)](#-kiến-trúc)
[![Zero Dependency](https://img.shields.io/badge/runtime%20deps-0-brightgreen)](#-kiến-trúc)
[![Encryption](https://img.shields.io/badge/encryption-AES--256--GCM-blue)](#-đặc-tả-mã-hóa)
[![Status](https://img.shields.io/badge/security%20audit-independent%20review%20pending-orange)](#-minh-bạch--giới-hạn-thật)

[Demo trực tiếp](#) · [Báo lỗi](../../issues) · [Đóng góp](#-đóng-góp)

</div>

---

## 📖 Mục lục

- [Vì sao dự án này tồn tại](#-vì-sao-dự-án-này-tồn-tại)
- [Tính năng nổi bật](#-tính-năng-nổi-bật)
- [Cách hoạt động](#-cách-hoạt-động)
- [Kiến trúc](#-kiến-trúc)
- [Đặc tả mã hóa](#-đặc-tả-mã-hóa)
- [Bắt đầu nhanh](#-bắt-đầu-nhanh)
- [Minh bạch & giới hạn thật](#-minh-bạch--giới-hạn-thật)
- [Lộ trình](#-lộ-trình)
- [Đóng góp](#-đóng-góp)
- [Giấy phép](#-giấy-phép)

---

## 🎯 Vì sao dự án này tồn tại

Hầu hết app nhắn tin "riêng tư" trên thị trường đều bắt bạn **tin tưởng mù
quáng** vào 1 công ty: tin rằng họ mã hóa đúng cách, tin rằng họ không lưu
log, tin rằng server của họ không bị xâm nhập. Bạn không có cách nào tự
kiểm chứng.

**anonymous-chat đi theo hướng ngược lại:**

- Không có server nào để bị hack, bị yêu cầu giao nộp dữ liệu, hay bị đóng cửa.
- Không có tài khoản nào để bị rò rỉ.
- Không có công ty nào đứng giữa bạn và người bạn đang nhắn tin.
- Toàn bộ mã nguồn công khai — an toàn nằm ở **toán học**, không nằm ở
  **lòng tin**.

> *"Đừng tin, hãy kiểm chứng." — nguyên lý Kerckhoffs, 1883*

---

## ✨ Tính năng nổi bật

| | |
|---|---|
| 🔒 **Mã hóa đầu-cuối thật sự** | AES-256-GCM + ECDH P-256, chạy 100% trong trình duyệt bằng Web Crypto API chuẩn |
| ⚡ **Kết nối P2P trực tiếp** | WebRTC DataChannel — tin nhắn bay thẳng giữa 2 máy, không qua bất kỳ máy chủ nào |
| 🎭 **Ngụy trang bằng Emoji** | Bản mã hiển thị dưới dạng chuỗi emoji — gửi qua bất kỳ kênh nào bạn muốn |
| 🕵️ **Không tài khoản, không đăng ký** | Mở trình duyệt, dùng ngay — không email, không số điện thoại |
| 🔄 **Forward Secrecy** | Ratchet tự động đổi khóa từng tin nhắn — lộ 1 khóa không lộ toàn bộ lịch sử |
| 🛡️ **Xác thực chống MITM** | Safety Number bắt buộc xác nhận trước khi gửi tin đầu tiên |
| 🌍 **11 ngôn ngữ** | Việt, Anh, Nhật, Hàn, Ả Rập, Nga, Pháp, Trung, Ba Tư, Ukraina, Đức — kể cả RTL |
| 📦 **Zero dependency** | Không 1 dòng thư viện ngoài trong runtime — mọi thứ tự viết, tự kiểm soát |
| 💻 **Chạy khắp nơi** | GitHub Pages, mở file HTML trực tiếp, hay tự host — đều được |

---

## 🚀 Cách hoạt động

```mermaid
sequenceDiagram
    participant A as Bạn
    participant K as Kênh bất kỳ (Zalo/SMS...)
    participant B as Người bạn muốn nhắn

    A->>A: Tạo "mã đề nghị" (SDP + khóa ECDH)
    A->>K: Gửi mã đề nghị
    K->>B: Chuyển tiếp
    B->>B: Tạo "mã phản hồi"
    B->>K: Gửi mã phản hồi
    K->>A: Chuyển tiếp
    A->>B: Kết nối P2P trực tiếp mở (WebRTC)
    Note over A,B: Xác nhận Safety Number qua điện thoại
    A->>B: 💬 Nhắn tin — mã hóa, tự động, thời gian thực
```

1. **Trao đổi 1 lần duy nhất** — gửi "mã đề nghị", nhận lại "mã phản hồi" qua bất kỳ kênh nào (Zalo, SMS, email...)
2. **Xác nhận danh tính** — đọc to mã Safety Number 8 ký tự qua điện thoại, chống bị đánh tráo giữa đường
3. **Chat trực tiếp** — mọi tin nhắn sau đó bay thẳng qua kết nối P2P, tự động mã hóa, không cần thao tác gì thêm

---

## 🏗️ Kiến trúc

```mermaid
flowchart LR
    subgraph GH["☁️ GitHub Pages"]
        F["File tĩnh — chỉ phát 1 lần"]
    end
    subgraph A["🖥️ Trình duyệt A"]
        WA["Web Crypto + WebRTC"]
    end
    subgraph B["🖥️ Trình duyệt B"]
        WB["Web Crypto + WebRTC"]
    end
    STUN["📡 STUN (chỉ ghép nối)"]

    GH -->|tải 1 lần| A
    GH -->|tải 1 lần| B
    A -.->|hỏi IP| STUN
    B -.->|hỏi IP| STUN
    A ===|"🔒 P2P trực tiếp, mã hóa"| B

    style GH fill:#2d2d2d,color:#fff
    style STUN fill:#3a3a3a,color:#fff
```

**Không có backend. Không có database. Không có ai đứng giữa cuộc trò
chuyện của bạn.** GitHub Pages chỉ làm đúng 1 việc: phát file 1 lần lúc bạn
mở trang — sau đó hoàn toàn đứng ngoài cuộc.

| Thành phần | Vai trò |
|---|---|
| `crypto/` | AES-GCM, PBKDF2, ECDH, HKDF ratchet, bit-packing emoji |
| `webrtc/` | Bắt tay, quản lý kết nối P2P, tự phát hiện rớt mạng |
| `qr/` | Mã hóa/giải mã trực quan (tùy chọn, không bắt buộc) |
| `i18n/` | 11 ngôn ngữ, hỗ trợ đầy đủ RTL |

---

## 🔬 Đặc tả mã hóa

<div align="center">

| Thông số | Giá trị |
|---|---|
| Cipher | `AES-256-GCM` |
| Trao đổi khóa | `ECDH P-256` |
| KDF (chế độ passphrase) | `PBKDF2-HMAC-SHA256` — 250.000 vòng |
| Forward secrecy | Ratchet đối xứng qua `HKDF-SHA256`, tách khóa theo hướng |
| Padding | Bội số cố định, chống lộ độ dài tin thật |
| Ngẫu nhiên | `crypto.getRandomValues()` — không bao giờ `Math.random()` |

</div>

Mọi phép toán chạy bằng **Web Crypto API chuẩn native của trình duyệt** —
không tự chế thuật toán mã hóa lõi nào. Phần tự viết (ratchet, bit-packing
emoji, mã bắt tay) được cô lập rõ ràng và ưu tiên review kỹ nhất.

---

## ⚡ Bắt đầu nhanh

**Không cần cài đặt gì cả** — đây là web app tĩnh:

```bash
# Clone về máy
git clone https://github.com/<user>/anonymous-chat.git
cd anonymous-chat

# Mở trực tiếp — không cần server, không cần build
open index.html
```

Hoặc chỉ cần vào thẳng bản deploy trên GitHub Pages. Muốn tự host bản của
riêng bạn? Bật GitHub Pages trong Settings của repo bạn fork — xong, không
cần cấu hình gì thêm.

---

## 🔍 Minh bạch & giới hạn thật

> Dự án này tin rằng **thành thật về giới hạn** đáng tin hơn nhiều so với
> những lời quảng cáo "bảo mật tuyệt đối". Đọc kỹ phần này trước khi dùng
> cho nội dung thực sự nhạy cảm.

- 🟡 **Chưa qua audit bảo mật độc lập bởi con người.** Dự án đã tự chạy
  self-audit (xem [`SELF-AUDIT.md`](./SELF-AUDIT.md)) và đang khắc phục các
  phát hiện — nhưng đây **không thay thế** được review bởi chuyên gia bảo
  mật thật sự.
- 🟡 **Địa chỉ IP lộ cho đối phương** khi kết nối P2P (bản chất của WebRTC),
  và **STUN server công khai thấy IP 2 bên** lúc ghép nối. Cần ẩn danh
  tuyệt đối? [Dùng qua Tor Browser](#) — xem hướng dẫn trong app.
- 🟡 **Chỉ bảo vệ nội dung, không bảo vệ metadata** — ai đó theo dõi được
  mạng vẫn biết *có* cuộc trò chuyện diễn ra, dù không đọc được nội dung.
- 🟡 **Ratchet đơn giản hóa**, không phải Double Ratchet đầy đủ như Signal.
- 🟢 **Không lưu trữ tin nhắn, không lưu khóa trần trụi** — tải lại trang
  cần bắt tay lại (đây là thiết kế cố ý, không phải lỗi).

**An toàn không phải trạng thái tĩnh — đây là quá trình liên tục.** Nếu
bạn tìm thấy lỗ hổng, [mở issue](../../issues) hoặc gửi PR — mọi đóng góp
về bảo mật đều được ưu tiên xem xét nhanh nhất.

---

## 🗺️ Lộ trình

- [x] Lõi mã hóa AES-GCM + ECDH + Ratchet
- [x] Kết nối P2P qua WebRTC + STUN
- [x] Mã hóa hiển thị bằng Emoji
- [x] Đa ngôn ngữ (11 thứ tiếng, hỗ trợ RTL)
- [x] Self-audit vòng 1 — khắc phục lỗi nghiêm trọng
- [ ] Giao diện thiết kế lại (glassmorphism, mobile-first)
- [ ] QR code chuẩn — quét bằng camera thật
- [ ] Giữ phiên qua reload (tùy chọn, mã hóa bằng PIN cục bộ)
- [ ] Audit bảo mật độc lập bởi bên thứ 3

---

## 🤝 Đóng góp

Mọi đóng góp đều được chào đón — đặc biệt là:

- 🐛 Báo lỗi bảo mật (xem cách báo cáo có trách nhiệm bên dưới)
- 🌐 Cải thiện bản dịch cho 11 ngôn ngữ hiện có
- 🎨 Cải thiện giao diện, trải nghiệm người dùng
- 📖 Cải thiện tài liệu, làm rõ hơn cho người không rành kỹ thuật

**Báo lỗi bảo mật:** nếu phát hiện lỗ hổng nghiêm trọng, vui lòng **không**
mở issue công khai ngay — liên hệ riêng trước để có thời gian khắc phục,
tránh bị lợi dụng trước khi có bản vá.

---

## 📜 Giấy phép

Phát hành theo giấy phép **MIT** — dùng, sửa, phân phối lại tự do, miễn
giữ nguyên thông báo bản quyền gốc. Xem chi tiết tại [`LICENSE`](./LICENSE).

---

<div align="center">

**Được xây dựng với niềm tin rằng quyền riêng tư không nên là đặc quyền.**

Nếu dự án này hữu ích, hãy để lại 1 ⭐ — nó thực sự giúp dự án được nhiều
người biết đến hơn.

</div>
