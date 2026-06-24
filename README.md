# Lighthouse Audit Tool

Công cụ nội bộ để chạy Lighthouse audit (median-of-N) trên nhiều route và xuất kết quả ra file Excel.

---

## Tính năng chính

### **Chế độ Static Flow (mặc định)**

- Form cấu hình React + Vite với hỗ trợ Basic Auth và form login
- API Fastify: CSRF protection, validation, rate limiting, mã hóa credentials, SSE progress, JWT download token
- Worker BullMQ (`concurrency: 1`): Chrome mới mỗi lần chạy, giữ cookie form-login, tính median qua `computeMedianRun`
- Xuất Excel: sheet `Summary`, sheet theo route, `Diagnostics`, `Run Configuration`

### **Chế độ Manual Chrome Tabs** _(tùy chọn)_

- Audit các tab đã xác thực (OTP/login) trong Chrome profile riêng
- **Chỉ dùng local, single-user** — tắt mặc định, chỉ chấp nhận loopback caller
- Yêu cầu `MANUAL_CHROME_ENABLED=true` và `ALLOWED_HOSTS` (whitelist domain)
- Chrome profile tái sử dụng được, không cần login lại giữa các lần chạy
- **Privacy:** URL hiển thị chỉ gồm `origin + pathname` (không lưu query/fragment), HTML evidence tắt mặc định

---

## Cài đặt & Chạy

### **Yêu cầu**

- Node.js (khuyến nghị LTS)
- pnpm (corepack)
- Redis (local hoặc remote)
- Chrome/Chromium

### **Development Mode**

```bash
# Cài đặt dependencies
corepack enable
pnpm install

# Terminal 1: Chạy API + UI (Vite dev server)
pnpm run dev

# Terminal 2: Chạy Worker
pnpm run dev:worker
```

- **UI:** `http://localhost:5173` (proxy API → `http://localhost:3000`)
- **Secrets thiếu:** Tự động dùng giá trị dev mặc định

### **Production Build**

```bash
# Build ứng dụng
pnpm run build

# Chạy cả API server + worker
pnpm start
```

**Lưu ý:**

- Yêu cầu `ENCRYPTION_KEY` và `DOWNLOAD_TOKEN_SECRET` trong `.env`
- Chỉ chạy API server (không worker): `pnpm run start:server`

### **Cấu hình Environment**

```bash
# Tạo file .env từ template
cp .env.example .env

# Tạo ENCRYPTION_KEY (32 bytes base64)
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

**Biến môi trường quan trọng:**

- `ENCRYPTION_KEY`: Mã hóa credentials (bắt buộc production)
- `DOWNLOAD_TOKEN_SECRET`: JWT token cho download (bắt buộc production)
- `ALLOWED_HOSTS`: Whitelist domain (khuyến nghị)
- `REDIS_URL`: Kết nối Redis (mặc định `redis://localhost:6379`)

---

## Cấu hình Manual Chrome Tabs

### **Bật chế độ**

```bash
MANUAL_CHROME_ENABLED=true
ALLOWED_HOSTS=example.com,staging.example.com
MANUAL_CHROME_PROFILE_DIR=.lh-audit/chrome-profile  # mặc định
MANUAL_CHROME_PORT=9222                              # mặc định
MANUAL_CHROME_AUTO_OPEN=true                         # tự động mở Chrome khi start
```

### **Sử dụng**

1. **Mở Chrome profile:**
    - UI → chọn `Manual Chrome Tabs` → click `Open Chrome profile`
    - Hoặc để `MANUAL_CHROME_AUTO_OPEN=true` để tự động mở khi start server

2. **Xác thực thủ công:**
    - Login/OTP trong các tab (chỉ domain trong `ALLOWED_HOSTS`)
    - Giữ các tab mở

3. **Chạy audit:**
    - Click `Scan tabs` → chọn tab cần audit → chạy
    - Chrome giữ nguyên sau audit, không cần login lại

### **Bảo mật & Privacy**

- **URL sanitization:** Chỉ lưu `origin + pathname`, không lưu query string/fragment
- **HTML evidence:** Tắt mặc định, cần checkbox đồng ý để bật
    - Giới hạn: `MANUAL_CHROME_MAX_EVIDENCE_BYTES`, `MANUAL_CHROME_MAX_EVIDENCE_FILES`
- **Không audit URL chứa:** OTP, password-reset token, session token trong query/fragment

### **Xử lý lỗi**

| Tình huống                        | Giải pháp                                          |
| --------------------------------- | -------------------------------------------------- |
| Server restart khi Chrome đang mở | Đóng Chrome → click `Open Chrome profile` lại      |
| Port `9222` bị chiếm              | Đóng Chrome khác hoặc đổi `MANUAL_CHROME_PORT`     |
| Auto-launch thất bại              | Kiểm tra log, click `Open Chrome profile` thủ công |

---

## Kiểm tra & Testing

### **Chạy tests**

```bash
# Type checking
pnpm run typecheck

# Unit tests
pnpm test

# Build verification
pnpm run build
```

### **Acceptance Testing** _(staging)_

- 3 paths × 2 form factors × 5 runs
- Basic Auth success/failure
- Form-login fixture
- Chrome crash recovery
- 24h cleanup verification

**Giới hạn domain:**

```bash
ALLOWED_HOSTS=staging.example.com,example.com
```

---

## Cấu trúc dự án

```
.
├── src/
│   ├── api/          # Fastify API server
│   ├── worker/       # BullMQ worker
│   └── web/          # React + Vite UI
├── .env.example      # Template biến môi trường
├── package.json
└── README.md
```

---

## Troubleshooting

### **Redis connection failed**

```bash
# Kiểm tra Redis đang chạy
redis-cli ping

# Hoặc cài Redis local
# macOS: brew install redis && brew services start redis
# Ubuntu: sudo apt install redis-server && sudo systemctl start redis
```

### **Chrome not found**

- Đảm bảo Chrome/Chromium đã cài đặt
- Hoặc cài Puppeteer Chrome: `npx puppeteer browsers install chrome`

### **Port conflicts**

- API port `3000`: Đổi `PORT` trong `.env`
- Chrome CDP port `9222`: Đổi `MANUAL_CHROME_PORT`
- Vite dev port `5173`: Đổi trong `vite.config.ts`

---

## License & Support

Internal tool - FPT Software only.
