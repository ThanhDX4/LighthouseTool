# Đặc tả yêu cầu phần mềm: Công cụ tự động hóa Lighthouse Audit (Web App)

**Phiên bản tài liệu:** 1.0
**Ngôn ngữ:** Tiếng Việt
**Đối tượng:** Đội phát triển (Backend Node.js + Frontend Web)
**Ngày phát hành:** 05/06/2026

---

## 1. Tổng quan và mục tiêu

Tài liệu này đặc tả một **ứng dụng web nội bộ** giúp **tự động hóa toàn bộ quy trình đo lường hiệu năng web** bằng Google Lighthouse, thay thế cho việc chạy thủ công và viết báo cáo bằng tay vốn rất tốn thời gian của đội audit hiệu năng. **Đầu vào** là một URL gốc, cấu hình xác thực hai lớp (nginx basic auth + form login), và danh sách các pathname/route cần đo. **Đầu ra** là **một file Excel duy nhất** chứa mỗi sheet một route (với 5 lần chạy mỗi route trên cả desktop lẫn mobile, kèm tính median) và một sheet tổng hợp so sánh giữa các màn hình.

**Vì sao cần công cụ này.** Một chu kỳ audit hiện tại cho một web app có 10 màn hình tốn 8–12 giờ vận hành thủ công: mở DevTools, đăng nhập, chạy Lighthouse 5 lần × 2 form factor × 10 trang, copy số liệu vào Excel, tô màu, viết báo cáo. Công cụ này thu gọn còn **một lần submit form** và một file Excel hoàn chỉnh để bàn giao cho dev team. **Độ tin cậy của số đo** được đảm bảo bằng phương pháp median-of-5 chính thức của Lighthouse, vốn cho phương sai chỉ bằng một nửa so với chạy đơn lẻ.

**Mục tiêu chính:** (i) **Tự động hóa 100% quy trình** từ nhập cấu hình đến tải file Excel; (ii) **Đo đủ 5 hạng mục Lighthouse** (Performance, Accessibility, Best Practices, SEO, PWA nếu còn áp dụng) trên **cả desktop lẫn mobile** với throttling 3G/4G; (iii) **Xử lý xác thực hai lớp** an toàn (nginx Basic Auth + form session); (iv) **Sinh báo cáo Excel chuyên nghiệp** có tô màu theo ngưỡng Lighthouse, gồm sheet riêng cho mỗi route và một sheet so sánh tổng hợp.

**Mục tiêu phụ:** giảm sai số đo bằng median-of-5; chạy được trên Docker; bảo mật credential (không lưu trữ); báo cáo tiến trình thời gian thực; chịu được job dài 10–30 phút.

---

## 2. Phạm vi và ngoài phạm vi

### 2.1 Trong phạm vi (In-scope)

Công cụ phải hỗ trợ: **giao diện web có form nhập liệu** (không phải CLI); **chạy Lighthouse lập trình** qua `lighthouse` npm package v13+ và `chrome-launcher`; **đo cả 5 hạng mục** trên cả desktop và mobile; **5 lần chạy cho mỗi cặp (route, form factor)** và lấy median bằng `computeMedianRun`; **xác thực hai lớp** (HTTP Basic Auth qua `extraHeaders` cho lớp nginx + form login qua Puppeteer cho lớp ứng dụng); **network throttling mô phỏng 3G/4G** (cấu hình được); **xuất một file Excel duy nhất** đa-sheet (mỗi route một sheet + một sheet summary) với màu sắc theo ngưỡng 0–49 đỏ / 50–89 cam / 90–100 xanh; **hàng đợi job** dài, **báo tiến trình thời gian thực**, **tải file** an toàn; **đóng gói Docker**.

### 2.2 Ngoài phạm vi (Out-of-scope)

Phiên bản đầu tiên KHÔNG bao gồm: lập lịch chạy định kỳ (cron-style scheduling); so sánh báo cáo giữa các lần chạy ở các thời điểm khác nhau (regression tracking dài hạn — sẽ làm ở giai đoạn 2); xác thực OAuth2/SAML/MFA phức tạp (chỉ basic auth + form login đơn lớp); audit cho mobile app native; tạo PDF; gửi email/Slack notification; multi-tenant (mặc định một instance cho một team); ghi lịch sử kết quả vào database lâu dài (chỉ giữ file 24h); chạy Lighthouse trên thiết bị thật (real device); test A/B; load testing; chỉnh sửa Lighthouse config theo người dùng cuối ở mức audit-level.

---

## 3. Kiến trúc đề xuất

### 3.1 Tổng quan kiến trúc

Hệ thống gồm bốn thành phần logic chạy trong **một container Docker duy nhất** (có thể tách thành nhiều container ở giai đoạn sản phẩm hoá): (1) **Frontend SPA** — React + Vite, đóng vai trò form nhập liệu và bảng hiển thị tiến trình; (2) **API server** — Fastify (Node.js 22 LTS), tiếp nhận job, phát SSE tiến trình, phục vụ download; (3) **Worker process** — tiến trình con xử lý các job Lighthouse, dùng BullMQ; (4) **Redis** — backing store cho job queue và pub/sub. Trình duyệt Google Chrome stable được cài sẵn trong image và được điều khiển qua `chrome-launcher` + Puppeteer.

**Luồng dữ liệu chính:**

```
┌──────────────────────────────────────────────────────────┐
│              Browser (React SPA)                         │
│  Form → POST /jobs        EventSource /jobs/:id/events   │
└─────────────────▲────────────────────▲───────────────────┘
                  │ HTTPS              │ SSE
┌─────────────────┴────────────────────┴───────────────────┐
│   Fastify API                                            │
│   POST /jobs   GET /jobs/:id/events   GET /jobs/:id/dl   │
└─────────────────▲────────────────────▲───────────────────┘
                  │ BullMQ Queue       │ QueueEvents
                  ▼                    │
┌─────────────────────────────────────┴────────────────────┐
│         Redis 7 (queue + pub/sub)                        │
└─────────────────▲────────────────────────────────────────┘
                  │
┌─────────────────┴────────────────────────────────────────┐
│   Worker process (BullMQ Worker, concurrency=1)          │
│   ├─ Puppeteer launch Chrome (chrome-launcher)           │
│   ├─ (Optional) form-login via Puppeteer                 │
│   ├─ lighthouse(url, flags, config) × 5 runs             │
│   ├─ computeMedianRun(runs)                              │
│   └─ ExcelJS multi-sheet workbook → /var/lib/lh/jobs/    │
└──────────────────────────────────────────────────────────┘
```

### 3.2 Tech stack chính thức

| Lớp | Lựa chọn | Phiên bản |
|---|---|---|
| Runtime | Node.js LTS | **22.x** (yêu cầu của Lighthouse 13) |
| Web framework | Fastify | **^4.28** |
| Validation | Zod hoặc JSON Schema (Fastify built-in) | latest |
| Job queue | BullMQ + ioredis | **^5.x** / **^5.x** |
| Queue backing | Redis | **7-alpine** |
| Lighthouse | `lighthouse` (npm) | **^13.x** |
| Trình duyệt control | `chrome-launcher` + `puppeteer` | **^1.x** / **^22.x** |
| Excel | `exceljs` | **^4.4** |
| Logger | Pino (Fastify mặc định) | latest |
| Frontend | React + Vite + TypeScript | **18 / 5 / 5** |
| UI lib | Mantine (hoặc shadcn/ui) | latest |
| Reverse proxy | NGINX hoặc Caddy (HTTPS terminator) | latest |
| Container base | `node:22-bookworm-slim` + google-chrome-stable | latest stable |

### 3.3 Lý do lựa chọn từng thành phần

**Fastify** được chọn thay Express vì có **JSON Schema validation tích hợp** (đặc biệt hữu ích cho payload submit job phức tạp với danh sách route và config auth), hỗ trợ TypeScript tốt, throughput cao hơn ~3× Express. Tuy nhiên nếu đội đã rất quen Express 5 thì dùng Express cũng hoàn toàn chấp nhận được — Chrome là điểm nghẽn, không phải HTTP. **NestJS bị loại** vì DI + decorator overhead không cần thiết cho công cụ nội bộ một mục đích.

**BullMQ + Redis** là chuẩn de facto hiện tại cho job queue Node.js: hỗ trợ `job.updateProgress()`, `QueueEvents` pub/sub (mapping sạch sang SSE), retry với backoff, giới hạn concurrency, và đã thay thế Bull cũ. Lý do **bắt buộc** phải có queue: một job audit có thể chạy 5–30 phút, vượt timeout của hầu hết load balancer (ALB 60s, NGINX 60s, Cloudflare 100s); chạy trong request handler sẽ chặn event loop của API.

**ExcelJS** là lựa chọn duy nhất hợp lý trong hệ sinh thái Node OSS: license MIT, hỗ trợ **conditional formatting native** (rule `cellIs`, `colorScale`, `dataBar`), multi-sheet, freeze pane, auto-filter, merged cell, formula. SheetJS Community Edition **không hỗ trợ styling/CF** (cần bản Pro thương mại) và bản trên npm còn dính CVE-2023-30533. `node-xlsx` không styling, `xlsx-populate` đã ngưng phát triển. ExcelJS không hỗ trợ chart native (issue mở từ 2016) — workaround là render PNG bằng `chartjs-node-canvas` rồi `worksheet.addImage` nếu cần biểu đồ; với báo cáo Lighthouse, **color-coded cells là đủ và rõ ràng hơn chart**.

**SSE thay vì WebSocket** vì luồng dữ liệu một chiều (server → client tiến trình), không cần bi-directional; `EventSource` tự reconnect; chạy tốt sau reverse proxy nếu disable buffering; không cần thêm thư viện.

---

## 4. Yêu cầu chức năng (Functional Requirements)

Các yêu cầu được đánh số có tiền tố **FR-** để dev team tham chiếu trong commit/PR/test case.

### 4.1 FR-01 Giao diện cấu hình đầu vào

**FR-01.1.** Trang chính của ứng dụng phải hiển thị một **form duy nhất** gồm các trường: **Base URL** (string URL hợp lệ, bắt buộc, ví dụ `https://staging.example.com`); **Display name** của lần audit (string, tùy chọn, mặc định lấy hostname); **Danh sách pathname** (multi-line text area, mỗi dòng một path, ví dụ `/`, `/products`, `/cart`); **Form factor cần đo** (checkbox: Desktop / Mobile — mặc định cả hai); **Throttling preset** (dropdown: "Slow 4G (Lighthouse mặc định)", "Fast 3G", "Slow 3G", "Custom" — chỉ áp dụng cho mobile); **Số lần chạy** (number input, mặc định **5**, min 1, max 11); **Danh mục Lighthouse cần đo** (checkbox group: Performance, Accessibility, Best Practices, SEO, PWA — mặc định bật cả 5; PWA hiển thị nhãn "deprecated từ LH12").

**FR-01.2.** Form phải có một section **"Authentication (tùy chọn)"** có thể mở/đóng (collapsed mặc định), gồm hai sub-section độc lập có thể bật/tắt riêng:

- **Lớp 1: HTTP Basic Auth (cho staging có nginx)** — checkbox bật; nếu bật, hiển thị `Username` và `Password` (cả hai là `type="password"` để mask).
- **Lớp 2: Form Login** — checkbox bật; nếu bật, hiển thị: **Login URL** (string URL, bắt buộc nếu bật); **Username selector** (CSS selector, mặc định `input[name="email"]`); **Username value**; **Password selector** (mặc định `input[name="password"]`); **Password value** (`type="password"`); **Submit selector** (mặc định `button[type="submit"]`); **Post-login wait** (dropdown: "Navigation" — đợi `page.waitForNavigation()`; "Selector" — chờ một selector cụ thể xuất hiện, kèm ô input selector; "Delay" — chờ N ms).

**FR-01.3.** Nút **"Bắt đầu audit"** chỉ được phép bấm khi form hợp lệ (URL parse được, có ít nhất một path, có ít nhất một form factor). Khi bấm, form bị disable và chuyển sang trang **"Job progress"**.

**FR-01.4.** Tất cả input password phải `type="password"`. Không bao giờ gửi password trong query string. Không hiển thị lại password trong bất kỳ trang review nào sau khi submit. UI không có chức năng "Show password" trong production build.

### 4.2 FR-02 Hàng đợi và lifecycle của job

**FR-02.1.** Khi `POST /jobs` được gọi, API server phải: (a) **validate** payload theo JSON Schema, trả 400 với danh sách lỗi nếu sai; (b) **mã hóa AES-256-GCM** các trường credential (basic auth password, form login password) bằng `ENCRYPTION_KEY` lấy từ biến môi trường; (c) tạo `jobId` UUIDv4; (d) đưa job vào BullMQ queue tên `lh-audits` với payload đã mã hoá; (e) trả `{ jobId, eventsUrl, downloadUrl }` cho client.

**FR-02.2.** Worker phải chạy với `concurrency: 1` để đảm bảo độ ổn định của số đo (chạy song song nhiều Chrome instance trên cùng máy làm sai timing). Có thể cấu hình lên đến 2 nếu host có ≥4 CPU core, nhưng KHÔNG được vượt 1 instance Lighthouse trên 2 CPU core.

**FR-02.3.** Job có các state tuần tự: `queued` → `running` → một trong `{completed, failed, partial}`. State `partial` được dùng khi có ≥1 route fail nhưng job nói chung vẫn cho ra file Excel.

**FR-02.4.** Mỗi job có TTL **24 giờ** sau khi completed; sau đó worker cleanup chạy mỗi giờ sẽ xoá thư mục `jobs/{jobId}/` và record BullMQ. Credential trong Redis bị xoá ngay sau khi job kết thúc (`removeOnComplete: { age: 60 }`).

### 4.3 FR-03 Xử lý xác thực hai lớp

**FR-03.1.** **Lớp 1 — HTTP Basic Auth (nginx).** Khi `basicAuth.enabled === true`, worker phải truyền header `Authorization: Basic <base64(user:pass)>` qua flag `extraHeaders` của Lighthouse, áp dụng cho **mọi request** của Lighthouse cũng như cho Puppeteer khi điều hướng form login (qua `page.setExtraHTTPHeaders`).

**FR-03.2.** **Lớp 2 — Form Login.** Khi `formLogin.enabled === true`, mỗi run Lighthouse phải được thực hiện theo trình tự sau, đảm bảo session cookie từ login được tái sử dụng:

1. Launch Chrome bằng `chromeLauncher.launch({ chromeFlags: ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage'] })`.
2. Kết nối Puppeteer: `puppeteer.connect({ browserURL: 'http://localhost:' + chrome.port })`.
3. Nếu có basic auth: `page.setExtraHTTPHeaders({ Authorization: 'Basic ...' })`.
4. `page.goto(loginUrl)`, fill credential vào selector, click submit, chờ điều kiện post-login đã chọn.
5. Gọi `lighthouse(targetUrl, { port: chrome.port, disableStorageReset: true, extraHeaders: {...basicAuth} }, configForFormFactor, page)` — **`disableStorageReset: true` là bắt buộc** để cookie session được giữ trong audit.
6. Sau khi hoàn tất 5 run cho một (route, form factor), `await chrome.kill()`.

**FR-03.3.** Nếu form login thất bại (selector không tìm thấy, không navigate trong 30s, response 4xx), worker phải ghi log lỗi (KHÔNG log credential), set state job thành `failed` với message rõ ràng (`"Form login failed: selector input[name=email] not found"`), và KHÔNG tiếp tục chạy Lighthouse.

**FR-03.4.** Worker KHÔNG bao giờ được phép log nội dung credential. Pino logger phải có cấu hình `redact: ['req.body.basicAuth.password', 'req.body.formLogin.password', 'job.data.credentials.*']`.

### 4.4 FR-04 Engine thực thi audit

**FR-04.1. Số lần chạy.** Cho mỗi cặp `(route, formFactor)`, worker phải chạy Lighthouse **đúng N lần** (mặc định N=5) tuần tự, mỗi lần với một instance Chrome mới (launch + kill). Không bao giờ tái sử dụng Chrome instance giữa các run khác nhau để tránh cache state ảnh hưởng kết quả (ngoại trừ trong cùng một run nếu cần form login).

**FR-04.2. Form factor.** Khi `formFactor === 'desktop'`, truyền `desktopConfig` đã import từ `lighthouse/core/config/desktop-config.js` làm tham số thứ 3 của hàm `lighthouse()`. Khi `formFactor === 'mobile'`, KHÔNG truyền config (Lighthouse mặc định là mobile Moto G Power với Slow 4G simulated throttling).

**FR-04.3. Danh mục đo.** Truyền `onlyCategories` theo danh sách người dùng đã chọn. Mặc định `['performance', 'accessibility', 'best-practices', 'seo']`. Nếu người dùng tick PWA, thêm `'pwa'` nhưng worker phải xử lý trường hợp `lhr.categories.pwa === undefined` (Lighthouse 12+ đã loại bỏ PWA category mặc định).

**FR-04.4. Throttling.** Mobile mặc định dùng preset Slow 4G:

```js
throttling: {
  rttMs: 150, throughputKbps: 1638.4, requestLatencyMs: 562.5,
  downloadThroughputKbps: 1474.56, uploadThroughputKbps: 675,
  cpuSlowdownMultiplier: 4,
}
```

Khi người dùng chọn "Fast 3G": `{ rttMs: 80, throughputKbps: 1638.4, cpuSlowdownMultiplier: 2 }`. "Slow 3G": `{ rttMs: 300, throughputKbps: 700, cpuSlowdownMultiplier: 8 }`. "Custom": hiển thị 3 ô nhập rttMs, throughputKbps, cpuSlowdownMultiplier. `throttlingMethod` luôn là `'simulate'` (Lantern) để đảm bảo độ deterministic.

**FR-04.5. Median.** Sau khi có N kết quả `lhr[]`, worker phải gọi `computeMedianRun(lhrs)` từ `lighthouse/core/lib/median-run.js` để chọn run đại diện (run có FCP và TTI gần median nhất). KHÔNG tự tính median số học của từng metric riêng lẻ — phải dùng `computeMedianRun` đúng theo cách Lighthouse khuyến nghị.

**FR-04.6. Timeout per run.** Mỗi lần gọi `lighthouse()` phải được bọc trong `Promise.race` với timeout **120 giây**. Nếu vượt, Chrome bị `kill()` và run đó được đánh dấu fail. `maxWaitForLoad` của Lighthouse set 60_000ms, `maxWaitForFcp` giữ mặc định.

**FR-04.7. Retry và partial success.** Nếu một run fail (timeout, `runtimeError`, exception), worker **không retry tự động** trong v1 (giữ tổng thời gian dự đoán được). Quy tắc tổng hợp: **≥3/5 run thành công** → tính `computeMedianRun` trên các run thành công, đánh dấu route là `degraded` với chú thích "x/5 run thành công"; **<3/5 thành công** → đánh dấu route đó `failed`, ghi lỗi vào sheet Diagnostics, tiếp tục các route khác.

**FR-04.8. Báo cáo tiến trình.** Sau mỗi run, worker phải gọi `job.updateProgress(payload)` với schema:

```json
{
  "percent": 42,
  "phase": "lighthouse-run",
  "message": "Đang chạy Lighthouse 3/5 cho /home (mobile)",
  "currentRoute": "/home",
  "formFactor": "mobile",
  "runIndex": 3,
  "runsTotal": 5,
  "completedRuns": 12,
  "totalRuns": 30,
  "etaSeconds": 540
}
```

ETA tính bằng moving average của duration các run đã xong × số run còn lại.

### 4.5 FR-05 Sinh báo cáo Excel

**FR-05.1.** Sau khi tất cả run hoàn thành, worker tạo workbook ExcelJS với cấu trúc sheet như sau (xem chi tiết §7):

1. **Sheet `Summary`** — luôn là sheet đầu tiên, tổng hợp so sánh tất cả route.
2. **Một sheet per route**, đặt tên theo path (sanitized: bỏ ký tự `\/?*[]:`, cắt tối đa 31 ký tự — giới hạn Excel). Nếu trùng tên, thêm hậu tố `-2`, `-3`.
3. **Sheet `Diagnostics`** — danh sách lỗi/cảnh báo của mọi run, dùng để debug.
4. **Sheet `Run Configuration`** — ghi lại cấu hình audit (base URL, throttling, danh mục, ngày chạy, Lighthouse version, Chrome version) để báo cáo tự document.

**FR-05.2.** File Excel được ghi vào `/var/lib/lh-audit/jobs/{jobId}/report.xlsx` rồi đính kèm hash SHA-256 (`report.xlsx.sha256`) để verify download.

**FR-05.3.** Conditional formatting áp dụng cho mọi ô score (0–100): `<50` đỏ `#FF4E40`, `50–89` cam `#FFA400`, `≥90` xanh `#0CCE6B`, kèm font trắng cho đỏ/xanh, font đen cho cam. Áp dụng cho cả category score và metric score quy đổi.

**FR-05.4.** Conditional formatting cho các metric raw numeric value áp dụng theo ngưỡng Core Web Vitals (xem §7.6).

### 4.6 FR-06 Download file

**FR-06.1.** Endpoint `GET /jobs/:id/download?token=...` — `token` là JWT một lần (`exp` 1 giờ, claim `jobId`) phát hành trong SSE event `done`. Streaming `fs.createReadStream(path).pipe(reply.raw)` với header `Content-Disposition: attachment; filename="lighthouse-{baseHost}-{YYYYMMDD-HHmm}.xlsx"`, `Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`.

**FR-06.2.** Sau khi tải xong (hoặc sau 24h), file vẫn được giữ trên đĩa cho đến khi cleanup job xoá. Token JWT chỉ dùng được một lần (lưu hash token đã consume vào Redis với TTL 1h).

---

## 5. Luồng người dùng và sự kiện (User flows & events)

### 5.1 Happy path — luồng chuẩn

1. **Người dùng truy cập** `https://lh-tool.internal/` → trang form được phục vụ tĩnh.
2. **Điền form**: Base URL `https://staging.app.example.com`; paths `[/, /products, /cart, /checkout]`; bật cả Desktop + Mobile; throttling "Slow 4G"; runs = 5; categories tất cả; Basic Auth bật với `staging-user / ***`; Form Login bật với login URL, selectors, credentials.
3. **Bấm "Bắt đầu audit"** → client gửi `POST /jobs` với payload JSON (FR-02.1). Backend validate → mã hoá credentials → enqueue → trả `{ jobId, eventsUrl: '/jobs/{id}/events' }`.
4. **Client chuyển trang** sang `/jobs/{id}` và mở `new EventSource('/jobs/{id}/events')`.
5. **Backend SSE stream**: phát `event: queued` ngay lập tức, sau đó các `event: progress` mỗi khi `job.updateProgress` được gọi (sau mỗi run Lighthouse). Payload progress chứa percent, message, ETA — UI cập nhật progress bar và log line.
6. **Worker thực thi**: với mỗi (route, formFactor) lặp 5 lần Lighthouse → `computeMedianRun` → tích lũy vào kết quả. Tổng số run = `routes × formFactors × 5` (ví dụ 4×2×5 = 40 runs).
7. **Sau khi xong**, worker build Excel, lưu file, gọi `job.complete(result)` với result chứa `downloadUrl` và `downloadToken`.
8. **Backend phát event** `event: done` qua SSE với `{ downloadUrl, downloadToken, summary: { routes: 4, runsTotal: 40, runsSucceeded: 40, durationSec: 1320 } }`. UI hiển thị nút **"Tải báo cáo Excel"**.
9. **Người dùng bấm nút** → browser navigate `GET /jobs/{id}/download?token=...` → file `.xlsx` tải về.

### 5.2 Sự kiện SSE chuẩn hoá

| Event name | Payload | Khi nào phát |
|---|---|---|
| `queued` | `{ jobId, queuePosition }` | Ngay sau khi enqueue |
| `started` | `{ jobId, startedAt, totalRuns }` | Worker pick up job |
| `progress` | (xem FR-04.8) | Sau mỗi run Lighthouse hoàn tất |
| `warn` | `{ route, formFactor, runIndex, message }` | Run đơn lẻ fail nhưng tiếp tục |
| `route-completed` | `{ route, formFactor, scores }` | Sau khi xong 5 run của 1 cặp |
| `excel-generating` | `{ message: "Đang tạo file Excel..." }` | Bắt đầu build workbook |
| `done` | `{ downloadUrl, downloadToken, summary }` | Job kết thúc thành công/partial |
| `failed` | `{ error, code }` | Job lỗi không hồi phục |

### 5.3 Luồng lỗi (Error flows)

**Lỗi validation form**: API trả 400 ngay lập tức, UI hiển thị inline error. **Lỗi auth lớp 1 (basic auth sai)**: tất cả run nhận 401, ghi vào Diagnostics, job state = `failed`, UI hiển thị "Sai username/password Basic Auth". **Lỗi auth lớp 2 (form login)**: dừng job ngay, không chạy Lighthouse, state = `failed`. **Lỗi Chrome crash**: retry Chrome launch 1 lần; nếu vẫn fail, run đó được đánh dấu fail và tiếp tục. **Mất kết nối SSE**: client dùng `EventSource` retry tự động với `Last-Event-ID`; backend resend các event đã miss từ Redis ring buffer (tuỳ chọn nâng cao, có thể bỏ qua trong v1).

---

## 6. Yêu cầu phi chức năng (Non-functional requirements)

### 6.1 Hiệu năng

**NFR-PERF-01.** Một job 5 route × 2 form factor × 5 run = 50 lần Lighthouse phải hoàn thành trong **<25 phút** trên host 4 vCPU / 8 GB RAM (giả định mỗi run ~25–30 giây trên trang trung bình). **NFR-PERF-02.** Memory peak của container không vượt **2.5 GB** (Chrome ~500MB × tối đa 2 instance đồng thời + Node ~300MB + buffer). **NFR-PERF-03.** API response time cho `POST /jobs` và `GET /jobs/:id/events` (initial connection) **<500ms** ở P95.

### 6.2 Độ tin cậy

**NFR-REL-01.** Mỗi Chrome instance phải được `kill()` trong block `finally` để tránh zombie process. Container chạy với Docker `--init` (PID 1 = tini) để reap orphan. **NFR-REL-02.** Worker process tự restart sau mỗi **50 job hoàn tất** để tránh memory leak tích luỹ (PM2 hoặc Docker `--restart`). **NFR-REL-03.** Redis phải dùng `appendonly yes` (AOF persistence) để job không mất khi restart. **NFR-REL-04.** Cleanup job xoá file >24h chạy mỗi giờ (BullMQ repeatable job).

### 6.3 Bảo mật

**NFR-SEC-01. Credential không bao giờ persist.** Credentials chỉ tồn tại trong RAM của worker khi job đang chạy, và trong Redis dưới dạng AES-256-GCM ciphertext với TTL 60s sau khi complete. **NFR-SEC-02. HTTPS bắt buộc** ở reverse proxy; HSTS header; cookie `Secure`, `HttpOnly`, `SameSite=Strict`. **NFR-SEC-03. CSRF protection** trên `POST /jobs` (double-submit cookie hoặc CSRF token). **NFR-SEC-04. Rate limit** `POST /jobs` 10 req/giờ/IP để chống abuse. **NFR-SEC-05. Logging redaction** như FR-03.4. **NFR-SEC-06.** Chrome chạy với `--no-sandbox` (cần cho container) BÙ LẠI bằng: container chạy `USER lhuser` không phải root, `--cap-drop=ALL`, read-only root filesystem (trừ `/var/lib/lh-audit`, `/tmp`). **NFR-SEC-07. Cảnh báo người dùng**: UI hiển thị disclaimer "Chỉ audit các site bạn tin cậy" vì `--no-sandbox` làm Chrome ít isolation hơn.

### 6.4 Xử lý lỗi và timeout

**NFR-ERR-01.** Mọi `await lighthouse()` bọc trong `Promise.race([..., timeout(120_000)])`. **NFR-ERR-02.** Mọi `chrome-launcher` thất bại sau 3 lần retry → fail toàn job. **NFR-ERR-03.** Mọi exception trong worker phải được catch, log với context (jobId, route, formFactor, runIndex, KHÔNG kèm credential), và phát SSE `warn` hoặc `failed`. **NFR-ERR-04.** Lighthouse `lhr.runtimeError` phải được kiểm tra sau mỗi run — nếu có, đánh dấu run đó fail.

### 6.5 Concurrency

**NFR-CONC-01.** BullMQ worker `concurrency: 1` mặc định. Cấu hình được qua env `WORKER_CONCURRENCY` nhưng kèm cảnh báo. **NFR-CONC-02.** Bên trong một job, các run Lighthouse luôn tuần tự (KHÔNG `Promise.all`) để đảm bảo nhất quán timing — đây là khuyến nghị từ Lighthouse variability docs. **NFR-CONC-03.** Nếu nhiều job được submit cùng lúc, queue serialize chúng; UI hiển thị `queuePosition`.

### 6.6 Quan sát (Observability)

**NFR-OBS-01.** Pino structured JSON log với fields `jobId, route, formFactor, runIndex, durationMs, lhVersion, chromeVersion`. **NFR-OBS-02.** Endpoint `GET /healthz` trả 200 nếu Redis ping OK và Chrome binary tồn tại. **NFR-OBS-03.** Endpoint `GET /metrics` (tùy chọn) phát metric Prometheus: `lh_jobs_total{state}`, `lh_run_duration_seconds`, `lh_runs_failed_total`.

---

## 7. Đặc tả template báo cáo Excel (chi tiết)

### 7.1 Quy ước chung

Workbook dùng font **Calibri 11**, header row màu nền `#1F3864` (navy đậm) + chữ trắng đậm, freeze row 1 cho mọi sheet. Cột chứa URL có hyperlink. Mọi sheet đều có auto-filter trên header. Tên sheet bị sanitize: loại bỏ `\ / ? * [ ] :`, cắt tại 31 ký tự.

### 7.2 Sheet "Summary" — sheet so sánh tổng hợp

**Mục đích**: cho phép một dev nhìn vào sheet này và lập tức biết route nào tốt/kém ở chỉ số nào. Một dòng cho mỗi cặp `(route, formFactor)` — vì vậy nếu có 5 route × 2 form factor thì có 10 dòng.

**Cấu trúc cột:**

| Col | Header | Loại | Width |
|---|---|---|---|
| A | Route (path) | text | 28 |
| B | URL đầy đủ | hyperlink | 50 |
| C | Form factor | text (Mobile/Desktop) | 12 |
| D | Performance | number 0–100, CF score | 14 |
| E | Accessibility | number 0–100, CF score | 14 |
| F | Best Practices | number 0–100, CF score | 16 |
| G | SEO | number 0–100, CF score | 10 |
| H | PWA | number 0–100 hoặc "N/A", CF score | 10 |
| I | LCP (ms) | number, CF metric LCP | 12 |
| J | CLS | number 3 decimals, CF metric CLS | 10 |
| K | TBT (ms) | number, CF metric TBT | 12 |
| L | FCP (ms) | number, CF metric FCP | 12 |
| M | Speed Index (ms) | number, CF metric SI | 14 |
| N | TTI (ms) | number, CF metric TTI | 12 |
| O | Runs OK | text "5/5" hoặc "4/5" | 10 |
| P | Status | "OK" / "Degraded" / "Failed" | 12 |

Hàng cuối: hàng **AVERAGE** in đậm, tô nền xám nhạt `#F2F2F2`, dùng công thức `=AVERAGE(D2:Dx)` cho mỗi cột số.

### 7.3 Sheet per-route — chi tiết một màn hình

Mỗi route có **một sheet riêng**, đặt tên theo path đã sanitize. Cấu trúc gồm **4 block dọc**:

**Block 1 — Header (rows 1–3)**
- Row 1 (merged A1:H1): `"Lighthouse Report — {route}"`, font 14 bold.
- Row 2 (merged A2:H2): URL đầy đủ, hyperlink, font xanh underline.
- Row 3 (merged A3:H3): `"Audited at {ISO timestamp} · Lighthouse {version} · Chrome {version}"`.

**Block 2 — Category scores cho cả 2 form factor (rows 5–9)**

| | A | B | C | D | E | F |
|---|---|---|---|---|---|---|
| Row 5 (header) | Form factor | Performance | Accessibility | Best Practices | SEO | PWA |
| Row 6 | Mobile | (score) | (score) | (score) | (score) | (score) |
| Row 7 | Desktop | (score) | (score) | (score) | (score) | (score) |

CF score áp lên B6:F7.

**Block 3 — Core metrics median với cả 2 form factor (rows 10–16)**

Cấu trúc bảng dọc; mỗi metric một dòng, hai cột giá trị (Mobile / Desktop) + hai cột score quy đổi:

| Metric | Unit | Mobile value | Mobile score | Desktop value | Desktop score | Target (Good) |
|---|---|---|---|---|---|---|
| LCP | ms | (numericValue) | (score×100) | ... | ... | ≤ 2500 |
| CLS | unitless | (3 decimals) | (score×100) | ... | ... | ≤ 0.1 |
| TBT | ms | ... | ... | ... | ... | ≤ 200 |
| FCP | ms | ... | ... | ... | ... | ≤ 1800 |
| Speed Index | ms | ... | ... | ... | ... | ≤ 3400 |
| TTI | ms | ... | ... | ... | ... | ≤ 3800 |
| Max Pot. FID | ms | ... | ... | ... | ... | ≤ 130 |

CF metric áp lên cột "value" theo ngưỡng từng metric (§7.6). CF score áp lên cột "score".

**Block 4 — Tất cả 5 run thô cho Performance metrics (rows 18+)**

Đây là phần CHÌA KHOÁ cho minh bạch: hiển thị **từng run trong số 5 run** để người dùng kiểm tra phương sai. Một bảng cho Mobile và một bảng tương tự cho Desktop:

```
Mobile — 5 runs
                Run 1   Run 2   Run 3   Run 4   Run 5   Median  Min     Max
Performance     85      87      83      86      84      85      83      87
Accessibility   92      92      92      92      92      92      92      92
Best Practices  100     100     96      100     100     100     96      100
SEO             100     100     100     100     100     100     100     100
PWA             N/A     ...
LCP (ms)        2340    2410    2280    2390    2350    2350    2280    2410
CLS             0.08    0.09    0.07    0.08    0.08    0.08    0.07    0.09
TBT (ms)        180     190     175     185     180     180     175     190
FCP (ms)        1620    1680    1590    1640    1610    1620    1590    1680
Speed Index     2980    3050    2920    3010    2990    2990    2920    3050
TTI (ms)        3450    3520    3380    3490    3460    3460    3380    3520
```

**Lưu ý kỹ thuật quan trọng**: cột "Median" trong bảng này KHÔNG phải median số học của từng dòng — mà là giá trị từ **run được `computeMedianRun` chọn** (tức là cùng một run cho mọi metric trong cột Median). Cột "Min" và "Max" là min/max số học để người dùng thấy phương sai.

CF score áp lên hàng score (rows Performance, Accessibility, Best Practices, SEO, PWA). CF metric áp lên các cột Run 1–5 cho mỗi metric tương ứng.

Bảng Desktop tương tự, bắt đầu sau bảng Mobile có 2 dòng trống.

**Block 5 — Top opportunities (sau bảng runs)**

Bảng 5–10 audit có "opportunity savings" lớn nhất (từ `lhr.audits[...].details.overallSavingsMs`), gồm: Audit ID, Title, Savings (ms), Description (wrap text). Đây là các gợi ý cải tiến mà Lighthouse đưa ra.

### 7.4 Sheet "Diagnostics"

Bảng phẳng các sự kiện cần chú ý từ tất cả các run:

| Timestamp | Route | Form Factor | Run | Severity | Code | Message |
|---|---|---|---|---|---|---|
| 2026-06-05T10:11:12Z | /checkout | mobile | 3 | error | NO_FCP | Lighthouse did not detect FCP within 30s |
| ... | ... | ... | ... | warning | ... | ... |

Lấy từ `lhr.runtimeError`, `lhr.runWarnings`, và các exception worker bắt được.

### 7.5 Sheet "Run Configuration"

Bảng key-value 2 cột để báo cáo tự document:

```
Base URL                https://staging.app.example.com
Auditor                 (user agent / API caller)
Started at              2026-06-05T09:50:00+07:00
Finished at             2026-06-05T10:12:34+07:00
Duration                22m 34s
Lighthouse version      13.3.0
Chrome version          138.0.7204.51
Node.js version         22.11.0
Form factors            mobile, desktop
Throttling preset       Slow 4G (Lighthouse default)
  rttMs                 150
  throughputKbps        1638.4
  cpuSlowdownMultiplier 4
Categories              performance, accessibility, best-practices, seo, pwa
Runs per page           5
Median method           computeMedianRun (closest to median FCP+TTI)
Total routes            5
Total runs              50
Successful runs         49
Auth                    Basic Auth: enabled; Form Login: enabled
```

### 7.6 Ngưỡng màu (Conditional Formatting) chính xác

**Category & metric score (0–100):** `<50` → đỏ `#FF4E40` font trắng bold; `50–89` → cam `#FFA400` font đen; `≥90` → xanh `#0CCE6B` font trắng bold.

**Metric numeric values** (ngưỡng từ developer.chrome.com và Core Web Vitals):

| Metric | Good (xanh) | Needs Improvement (cam) | Poor (đỏ) |
|---|---|---|---|
| LCP (ms) | ≤ 2500 | ≤ 4000 | > 4000 |
| CLS (unitless) | ≤ 0.1 | ≤ 0.25 | > 0.25 |
| TBT (ms) | ≤ 200 | ≤ 600 | > 600 |
| FCP (ms) | ≤ 1800 | ≤ 3000 | > 3000 |
| Speed Index (ms) | ≤ 3400 | ≤ 5800 | > 5800 |
| TTI (ms) | ≤ 3800 | ≤ 7300 | > 7300 |
| INP (ms, nếu có) | ≤ 200 | ≤ 500 | > 500 |

Dùng ExcelJS `addConditionalFormatting` với 3 rule `cellIs` (`lessThanOrEqual` good, `lessThanOrEqual` needs-imp, `greaterThan` poor) cho mỗi range cell metric.

---

## 8. Data model / Configuration schema

### 8.1 Payload `POST /jobs` (JSON Schema rút gọn)

```json
{
  "type": "object",
  "required": ["baseUrl", "paths", "formFactors"],
  "properties": {
    "baseUrl":     { "type": "string", "format": "uri" },
    "displayName": { "type": "string", "maxLength": 80 },
    "paths":       { "type": "array", "minItems": 1, "maxItems": 50,
                     "items": { "type": "string", "pattern": "^/" } },
    "formFactors": { "type": "array", "minItems": 1,
                     "items": { "enum": ["mobile", "desktop"] } },
    "categories":  { "type": "array", "default": ["performance","accessibility","best-practices","seo"],
                     "items": { "enum": ["performance","accessibility","best-practices","seo","pwa"] } },
    "runsPerPage": { "type": "integer", "minimum": 1, "maximum": 11, "default": 5 },
    "throttling": {
      "type": "object",
      "properties": {
        "preset": { "enum": ["slow-4g","fast-3g","slow-3g","custom"], "default": "slow-4g" },
        "custom": {
          "type": "object",
          "properties": {
            "rttMs":                 { "type": "number", "minimum": 0 },
            "throughputKbps":        { "type": "number", "minimum": 0 },
            "cpuSlowdownMultiplier": { "type": "number", "minimum": 1, "maximum": 20 }
          }
        }
      }
    },
    "basicAuth": {
      "type": "object",
      "properties": {
        "enabled":  { "type": "boolean", "default": false },
        "username": { "type": "string" },
        "password": { "type": "string" }
      }
    },
    "formLogin": {
      "type": "object",
      "properties": {
        "enabled":          { "type": "boolean", "default": false },
        "loginUrl":         { "type": "string", "format": "uri" },
        "usernameSelector": { "type": "string", "default": "input[name='email']" },
        "username":         { "type": "string" },
        "passwordSelector": { "type": "string", "default": "input[name='password']" },
        "password":         { "type": "string" },
        "submitSelector":   { "type": "string", "default": "button[type='submit']" },
        "postLogin": {
          "type": "object",
          "properties": {
            "mode":        { "enum": ["navigation","selector","delay"], "default": "navigation" },
            "selector":    { "type": "string" },
            "delayMs":     { "type": "integer" },
            "timeoutMs":   { "type": "integer", "default": 30000 }
          }
        }
      }
    }
  }
}
```

### 8.2 Job data model (BullMQ payload, ciphertext cho credential)

```ts
interface AuditJobData {
  jobId: string;
  config: AuditConfig;             // payload trên với password đã thay bằng ciphertext
  encryption: { iv: string; tag: string };  // metadata để decrypt
  createdAt: string;               // ISO
  createdBy?: string;              // từ session/header
}
```

### 8.3 Job result lưu trên đĩa

`/var/lib/lh-audit/jobs/{jobId}/`:
- `report.xlsx` — file Excel cuối cùng (file người dùng tải về)
- `report.xlsx.sha256` — hash
- `meta.json` — `{ jobId, summary, lighthouseVersion, chromeVersion, startedAt, finishedAt, status }`
- `runs/{route}/{formFactor}/run-{1..5}.json` — gzip JSON lhr (tùy chọn, có thể bỏ để tiết kiệm dung lượng, nhưng hữu ích để debug)

---

## 9. Acceptance criteria (tiêu chí nghiệm thu)

Dev team được coi là hoàn thành khi **tất cả** các tiêu chí sau pass trong môi trường staging:

**AC-01.** Submit form với 3 path × 2 form factor × 5 run cho `https://example.com` (không auth) hoàn thành trong **<15 phút**, sinh file Excel mở được trên Microsoft Excel 365, Google Sheets, và LibreOffice Calc.

**AC-02.** Workbook chứa đúng: 1 sheet `Summary` + 3 sheet per-route + 1 sheet `Diagnostics` + 1 sheet `Run Configuration`. Mỗi sheet per-route có đầy đủ 5 block như §7.3.

**AC-03.** Tất cả ô score được tô màu đúng theo ngưỡng 0–49 / 50–89 / 90–100. Tất cả ô metric numeric được tô màu đúng theo ngưỡng §7.6.

**AC-04.** Cột Median trong block 5-runs thực sự lấy giá trị từ run được `computeMedianRun` chọn, không phải median số học.

**AC-05.** Submit form với Basic Auth thành công trên một staging có nginx auth; submit với credential sai trả lỗi rõ ràng trong vòng 30s và **không lộ password** ở bất kỳ log nào.

**AC-06.** Submit form với form login (test với một dummy login server đính kèm fixture) thành công; session cookie được giữ qua audit (verified bằng cách audit endpoint yêu cầu auth và đảm bảo không bị redirect về login).

**AC-07.** Trong khi job chạy, UI hiển thị progress bar tăng dần, message cập nhật theo từng run, ETA hợp lý (giảm dần). SSE connection sống suốt 15+ phút mà không bị proxy buffer.

**AC-08.** Sau 24 giờ, file Excel của job đã complete bị xóa tự động.

**AC-09.** Test bảo mật: payload chứa password được mã hoá trong Redis (kiểm tra bằng `redis-cli` thấy ciphertext); Pino log không chứa plaintext password; file `report.xlsx` không chứa password.

**AC-10.** Test giả lập 1 run fail (kill Chrome): job vẫn complete với status `degraded`, file Excel hiển thị "4/5" trong cột Runs OK, sheet Diagnostics có entry.

**AC-11.** Docker container build thành công bằng `docker build .`, chạy được bằng `docker run --shm-size=2g --init -p 3000:3000 ...`, healthcheck `/healthz` trả 200.

**AC-12.** `lighthouseVersion` trong sheet Run Configuration khớp với version trong `lhr.lighthouseVersion`.

**AC-13.** Submit 2 job liên tiếp: job thứ 2 vào hàng đợi với `queuePosition: 1` và chờ job 1 xong rồi mới bắt đầu (concurrency=1).

---

## 10. Ghi chú triển khai và code recipe gợi ý

### 10.1 Cấu trúc dự án đề xuất

```
lh-audit-tool/
├── package.json          // "type": "module", engines.node >= 22
├── Dockerfile
├── docker-compose.yml
├── src/
│   ├── server.ts                  // Fastify entry, mount routes
│   ├── routes/
│   │   ├── jobs.ts                // POST /jobs, GET /jobs/:id/events, /download
│   │   └── health.ts
│   ├── queue/
│   │   ├── connection.ts          // ioredis singleton
│   │   ├── audit-queue.ts         // BullMQ Queue("lh-audits")
│   │   └── audit-worker.ts        // BullMQ Worker (run in separate process)
│   ├── lighthouse/
│   │   ├── run-once.ts            // 1 lần Lighthouse với auth
│   │   ├── run-route.ts           // 5 lần + computeMedianRun cho 1 (route,ff)
│   │   ├── configs.ts             // desktop/mobile + throttling presets
│   │   └── auth-puppeteer.ts      // form login flow
│   ├── excel/
│   │   ├── builder.ts             // workbook builder
│   │   ├── summary-sheet.ts
│   │   ├── route-sheet.ts
│   │   ├── diagnostics-sheet.ts
│   │   └── conditional-formatting.ts
│   ├── crypto/credentials.ts      // AES-256-GCM encrypt/decrypt
│   ├── sse/broadcaster.ts         // map QueueEvents → SSE
│   └── types.ts
├── web/                           // React + Vite frontend
│   ├── src/{App.tsx, JobForm.tsx, JobProgress.tsx}
│   └── vite.config.ts
└── tests/
```

### 10.2 Recipe: chạy 1 lần Lighthouse với cả 2 lớp auth (TypeScript ESM)

```ts
import lighthouse from 'lighthouse';
import * as chromeLauncher from 'chrome-launcher';
import puppeteer from 'puppeteer';
import desktopConfig from 'lighthouse/core/config/desktop-config.js';
import type { Flags } from 'lighthouse/types/externs.js';

export interface RunOnceOpts {
  url: string;
  formFactor: 'mobile' | 'desktop';
  throttling?: any;
  basicAuth?: { username: string; password: string };
  formLogin?: {
    loginUrl: string; usernameSelector: string; passwordSelector: string;
    submitSelector: string; username: string; password: string;
    postLogin: { mode: 'navigation' | 'selector' | 'delay'; selector?: string; delayMs?: number; timeoutMs: number };
  };
  categories: string[];
  timeoutMs?: number;
}

export async function runOnce(opts: RunOnceOpts) {
  const chrome = await chromeLauncher.launch({
    chromeFlags: ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  try {
    const extraHeaders: Record<string, string> = {};
    if (opts.basicAuth) {
      extraHeaders.Authorization =
        'Basic ' + Buffer.from(`${opts.basicAuth.username}:${opts.basicAuth.password}`).toString('base64');
    }

    // (a) Nếu có form login → drive Puppeteer trên cùng Chrome instance
    let page: puppeteer.Page | undefined;
    let browser: puppeteer.Browser | undefined;
    if (opts.formLogin) {
      browser = await puppeteer.connect({ browserURL: `http://localhost:${chrome.port}` });
      [page] = await browser.pages();
      if (Object.keys(extraHeaders).length) await page.setExtraHTTPHeaders(extraHeaders);
      await page.goto(opts.formLogin.loginUrl, { waitUntil: 'networkidle2' });
      await page.type(opts.formLogin.usernameSelector, opts.formLogin.username);
      await page.type(opts.formLogin.passwordSelector, opts.formLogin.password);
      const submit = page.click(opts.formLogin.submitSelector);
      const wait = (() => {
        const m = opts.formLogin.postLogin;
        if (m.mode === 'navigation') return page!.waitForNavigation({ timeout: m.timeoutMs });
        if (m.mode === 'selector')   return page!.waitForSelector(m.selector!, { timeout: m.timeoutMs });
        return new Promise(r => setTimeout(r, m.delayMs ?? 2000));
      })();
      await Promise.all([submit, wait]);
    }

    // (b) Lighthouse flags
    const flags: Flags = {
      port: chrome.port,
      output: 'json',
      logLevel: 'error',
      onlyCategories: opts.categories,
      formFactor: opts.formFactor,
      extraHeaders,
      disableStorageReset: !!opts.formLogin, // bắt buộc khi dùng session cookie
    };

    // (c) Lấy config cho desktop hoặc undefined (mobile mặc định)
    const cfg = opts.formFactor === 'desktop' ? desktopConfig : undefined;

    // (d) Throttling override
    if (opts.throttling) {
      flags.throttlingMethod = 'simulate';
      flags.throttling = opts.throttling;
    }

    // (e) Race với timeout
    const lhPromise = page
      ? lighthouse(opts.url, flags, cfg, page)
      : lighthouse(opts.url, flags, cfg);
    const result = await Promise.race([
      lhPromise,
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error('LIGHTHOUSE_TIMEOUT')), opts.timeoutMs ?? 120_000)),
    ]);
    if (!result) throw new Error('Lighthouse returned null');
    if (result.lhr.runtimeError) throw new Error(`runtimeError: ${result.lhr.runtimeError.code}`);

    if (browser) await browser.disconnect();
    return result.lhr;
  } finally {
    await chrome.kill();
  }
}
```

### 10.3 Recipe: 5 lần + median cho một (route, formFactor)

```ts
import { computeMedianRun } from 'lighthouse/core/lib/median-run.js';

export async function runRoute(opts: RunOnceOpts, n: number, onRun: (i: number, ok: boolean) => void) {
  const lhrs = []; const errors = [];
  for (let i = 0; i < n; i++) {
    try { lhrs.push(await runOnce(opts)); onRun(i, true); }
    catch (e: any) { errors.push({ runIndex: i, message: e.message }); onRun(i, false); }
  }
  if (lhrs.length < Math.ceil(n / 2)) {
    return { status: 'failed' as const, lhrs, median: null, errors };
  }
  const median = computeMedianRun(lhrs);
  return {
    status: (lhrs.length === n ? 'ok' : 'degraded') as 'ok' | 'degraded',
    lhrs, median, errors,
  };
}
```

### 10.4 Recipe: throttling presets

```ts
export const THROTTLING_PRESETS = {
  'slow-4g': { rttMs: 150, throughputKbps: 1638.4, requestLatencyMs: 562.5,
               downloadThroughputKbps: 1474.56, uploadThroughputKbps: 675, cpuSlowdownMultiplier: 4 },
  'fast-3g': { rttMs: 80,  throughputKbps: 1638.4, requestLatencyMs: 150,
               downloadThroughputKbps: 1638.4, uploadThroughputKbps: 750, cpuSlowdownMultiplier: 2 },
  'slow-3g': { rttMs: 300, throughputKbps: 700,   requestLatencyMs: 300,
               downloadThroughputKbps: 500,    uploadThroughputKbps: 300, cpuSlowdownMultiplier: 8 },
};
```

### 10.5 Recipe: conditional formatting trong ExcelJS

```ts
const SCORE_COLORS = { good: 'FF0CCE6B', avg: 'FFFFA400', poor: 'FFFF4E40' };

export function applyScoreCF(ws: ExcelJS.Worksheet, range: string) {
  ws.addConditionalFormatting({
    ref: range,
    rules: [
      { type: 'cellIs', operator: 'lessThan', formulae: [50], priority: 1,
        style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: SCORE_COLORS.poor } },
                 font: { color: { argb: 'FFFFFFFF' }, bold: true } } },
      { type: 'cellIs', operator: 'between', formulae: [50, 89], priority: 2,
        style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: SCORE_COLORS.avg } },
                 font: { color: { argb: 'FF000000' } } } },
      { type: 'cellIs', operator: 'greaterThanOrEqual', formulae: [90], priority: 3,
        style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: SCORE_COLORS.good } },
                 font: { color: { argb: 'FFFFFFFF' }, bold: true } } },
    ],
  });
}

export function applyLcpCF(ws: ExcelJS.Worksheet, range: string) {
  ws.addConditionalFormatting({
    ref: range,
    rules: [
      { type: 'cellIs', operator: 'lessThanOrEqual', formulae: [2500], priority: 1,
        style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: SCORE_COLORS.good } } } },
      { type: 'cellIs', operator: 'lessThanOrEqual', formulae: [4000], priority: 2,
        style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: SCORE_COLORS.avg } } } },
      { type: 'cellIs', operator: 'greaterThan', formulae: [4000], priority: 3,
        style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: SCORE_COLORS.poor } },
                 font: { color: { argb: 'FFFFFFFF' } } } },
    ],
  });
}
// Tạo hàm tương tự cho CLS (0.1/0.25), TBT (200/600), FCP (1800/3000),
// Speed Index (3400/5800), TTI (3800/7300).
```

### 10.6 Recipe: SSE endpoint với BullMQ QueueEvents

```ts
import { QueueEvents } from 'bullmq';

fastify.get('/jobs/:id/events', async (req, reply) => {
  const { id } = req.params as { id: string };
  reply.raw.setHeader('Content-Type', 'text/event-stream');
  reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
  reply.raw.setHeader('Connection', 'keep-alive');
  reply.raw.setHeader('X-Accel-Buffering', 'no');  // QUAN TRỌNG cho NGINX

  const send = (event: string, data: any) =>
    reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const qEvents = new QueueEvents('lh-audits', { connection });
  const heartbeat = setInterval(() => reply.raw.write(`: ping\n\n`), 15000);

  const onProgress = ({ jobId, data }: any) => { if (jobId === id) send('progress', data); };
  const onCompleted = ({ jobId, returnvalue }: any) => {
    if (jobId === id) { send('done', returnvalue); cleanup(); reply.raw.end(); }
  };
  const onFailed = ({ jobId, failedReason }: any) => {
    if (jobId === id) { send('failed', { error: failedReason }); cleanup(); reply.raw.end(); }
  };
  qEvents.on('progress', onProgress);
  qEvents.on('completed', onCompleted);
  qEvents.on('failed', onFailed);

  function cleanup() { clearInterval(heartbeat); qEvents.close().catch(() => {}); }
  req.raw.on('close', cleanup);
});
```

### 10.7 Dockerfile mẫu

```dockerfile
FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    CHROME_PATH=/usr/bin/google-chrome-stable \
    NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends \
      wget gnupg ca-certificates dumb-init \
 && wget -qO- https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor > /etc/apt/trusted.gpg.d/google.gpg \
 && echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google.list \
 && apt-get update && apt-get install -y --no-install-recommends \
      google-chrome-stable \
      fonts-liberation fonts-noto-color-emoji fonts-ipafont-gothic fonts-wqy-zenhei \
      libnss3 libatk-bridge2.0-0 libxkbcommon0 libgbm1 libdrm2 libasound2 \
 && rm -rf /var/lib/apt/lists/*
RUN groupadd -r lhuser && useradd -r -g lhuser -G audio,video lhuser \
 && mkdir -p /home/lhuser/Downloads /app /var/lib/lh-audit \
 && chown -R lhuser:lhuser /home/lhuser /app /var/lib/lh-audit
WORKDIR /app
COPY --from=builder --chown=lhuser:lhuser /app/node_modules ./node_modules
COPY --from=builder --chown=lhuser:lhuser /app/dist ./dist
COPY --from=builder --chown=lhuser:lhuser /app/web/dist ./public
COPY --from=builder --chown=lhuser:lhuser /app/package.json ./
USER lhuser
EXPOSE 3000
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/server.js"]
```

Chạy:

```bash
docker compose up -d
# docker-compose.yml mount Redis + app, set --shm-size=2g --init
```

### 10.8 Cảnh báo và best practice cuối cùng cho dev team

**Không bao giờ tái sử dụng Chrome instance giữa các run** — luôn launch + kill mỗi lần để tránh state cache làm sai số đo. **Luôn truyền `disableStorageReset: true`** khi đã pre-login bằng Puppeteer. **`formFactor` phải khớp với `screenEmulation.mobile`** — Lighthouse throw error nếu lệch (vì lý do này, an toàn nhất là dùng `desktopConfig` import sẵn cho desktop và để Lighthouse mặc định cho mobile). **Container phải có `--shm-size=2g`** — đây là bug deploy phổ biến nhất; `/dev/shm` mặc định 64MB làm Chrome crash ngẫu nhiên. **Chrome version phải pin** trong Dockerfile để score không drift theo thời gian giữa các lần audit. **Ghi rõ Lighthouse và Chrome version vào báo cáo** (sheet Run Configuration) để các báo cáo cùng version mới so sánh được với nhau.

---

## Kết luận

Đặc tả này cung cấp đầy đủ thông tin để đội phát triển khởi tạo dự án và xây dựng công cụ trong **khoảng 4–6 tuần** với một dev backend full-time. **Quyết định kiến trúc then chốt**: Node 22 + Fastify + BullMQ + Redis + ExcelJS + Lighthouse 13, đóng gói Docker với Chrome stable pin version. **Quyết định kỹ thuật then chốt**: dùng `computeMedianRun` chính thức của Lighthouse (không tự tính median số học), bắt buộc `disableStorageReset: true` cho form login, `concurrency: 1` cho worker, mã hoá AES-256-GCM cho credential với TTL ngắn. **Rủi ro chính cần theo dõi**: phương sai score giữa các lần audit khác nhau (giảm thiểu bằng pin Chrome version và chạy trên host dedicated), security của `--no-sandbox` (giảm thiểu bằng non-root user + read-only FS + allowlist URL), và Lighthouse breaking change trong các bản major sau (giảm thiểu bằng pin major `~13.x` và smoke test sau mỗi bump). Khi tất cả 13 acceptance criteria pass, công cụ sẵn sàng bàn giao cho team audit hiệu năng sử dụng hằng ngày.
