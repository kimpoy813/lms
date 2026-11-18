# Multi-School SaaS, PayMongo Billing & Superadmin Blueprint

This document is the concrete architecture and rollout blueprint for evolving **EduSphere** from its
current **single-institution deployment** into a **multi-school SaaS platform** tailored for
Philippine schools, colleges, and review centers — supporting:

1. **Free and Paid School Subscriptions** powered by **PayMongo** (**GCash**, **Maya**, **QR Ph**,
   **Online Banking**, and **Visa/Mastercard**), plus manual institutional billing (bank transfer / PO),
2. **Self-Service School Onboarding** alongside **Superadmin-Assisted Provisioning**, and
3. A platform **`SUPER_ADMIN`** who creates schools, controls free/paid plan access and quotas, and
   provisions each school's **`ADMIN`** account(s).

> **Current status:** **Blueprint only.** The live single-school schema, auth flows, and production
> deployment remain untouched so current production stays stable until you decide to start Phase 1.

---

## 1. Role & Tenant Hierarchy

| Role | `schoolId` | Scope & Capabilities |
|---|---|---|
| `SUPER_ADMIN` | `null` | Platform owner. Creates/suspends schools, assigns `FREE`/`PRO`/`CAMPUS` plans or custom pilots, creates initial or backup school `ADMIN` accounts, records manual/PO payments, views platform-wide usage & billing health. |
| `ADMIN` | Required (`School.id`) | School administrator. Manages **only their school's** teachers, students, academic years, departments, programs, courses, sections, enrollments, grading scales, announcements, school settings, encrypted AI provider key, and billing/subscription renewal. |
| `TEACHER` | Required (`School.id`) | Teaches classes inside their school; creates modules, lessons, quizzes, assignments, coding problems; runs QR attendance; uses AI Studio; grades work. |
| `STUDENT` | Required (`School.id`) | Enrolls in classes within their school; checks attendance; submits assignments/quizzes/code; views grades; uses opt-in Lesson Study Coach. |

---

## 2. Philippine Plan Tiers, Seat Caps & Storage Quotas

These tiers are sized to cover EduSphere's real infrastructure costs (**Vercel Serverless**, **Neon
PostgreSQL**, **Cloudflare R2 / S3**, **Vercel Sandbox**, and optional **AI keys**) while offering an
accessible free entry tier for small Philippine schools and pilot departments.

| Feature / Quota | `FREE` (Starter / Pilot) | `PRO` (High School / Small College) | `CAMPUS` (University / Multi-Dept) |
|---|---|---|---|
| **Price (PHP)** | **₱0 / month** | **₱1,990 / month** (or **₱19,900 / year**, 2 months free) | **₱5,990 / month** (or **₱59,900 / year**, 2 months free) |
| **Effective cost at cap** | Free | ~₱3.30 / active student / mo | ~₱2.40 / active student / mo |
| **Active Students** | Up to **150** | Up to **600** | Up to **2,500** *(custom quote above 2,500)* |
| **Teachers & Staff** | Up to **10** | Up to **40** | Up to **150** |
| **Active Classes** | Up to **15** *(archived allowed)* | Up to **80** | **Unlimited** |
| **File Storage Quota** | **250 MB** *(fits PostgreSQL `FileBlob`)* | **5 GB** *(Cloudflare R2 / S3)* | **25 GB** *(Cloudflare R2 / S3)* |
| **Max Upload per File** | **4 MB** | **15 MB** *(presigned R2 upload)* | **25 MB** *(presigned R2 upload)* |
| **AI Studio & Study Coach** | Built-in zero-key AI (`edusphere-builtin-v1`), **15 req/teacher/day** | Built-in AI (**50 req/teacher/day**) + **School-owned BYO LLM key** | Built-in AI (**150 req/teacher/day**) + **School-owned BYO LLM key** |
| **Browser Python (Pyodide)** | Included (runs on student device) | Included | Included |
| **Server Code Sandbox (`C/C++/Java/JS/Py`)** | Disabled or **50 runs/day/school** | **1,000 runs/day/school** | **5,000 runs/day/school** |
| **School Address** | Shared path `/s/<slug>` | Shared path or `<slug>.edusphere.ph` | Custom domain (`lms.yourschool.edu.ph`) |
| **Support & Onboarding** | Self-service + docs | Email support + Superadmin setup | Priority onboarding + CSV bulk setup + PO/Cheque invoicing |

### Why These Storage & Compute Limits Matter
1. **Why `FREE` caps storage at 250 MB:** EduSphere currently supports `STORAGE_DRIVER=database`
   (`FileBlob` bytea rows in PostgreSQL). Keeping free schools under 250 MB prevents 50 free schools
   from exhausting Neon database storage. Moving `PRO` and `CAMPUS` files to **Cloudflare R2 / S3**
   (a third backend in `backend/src/services/storage.js`) brings object storage cost down to ~₱1/GB/mo
   with zero egress fees and bypasses Vercel's 4.5 MB function payload limit via presigned uploads.
2. **Why `FREE` uses built-in AI + browser Pyodide:** Neither `edusphere-builtin-v1` nor browser-side
   Pyodide costs external API tokens or Sandbox VM minutes, letting you offer a genuinely useful free
   tier at near-zero marginal cost.
3. **Seat counting rule:** Count `User` rows where `schoolId = X AND status IN ('ACTIVE', 'PENDING') AND anonymizedAt IS NULL`. Deactivated/graduated accounts should not block next year's incoming freshmen.

---

## 3. PayMongo Integration & Self-Service School Signup Flow

EduSphere already defaults to `Asia/Manila` and follows **RA 10173 (Philippine Data Privacy Act)**.
**PayMongo** is the ideal Philippine payment gateway because it supports zero monthly fees (pay-as-you-go),
**QR Ph** (~1.34% + VAT), **Maya** (~1.79% + VAT), **GCash** (~2.23% + VAT), **Online Banking**
(BDO, BPI, UnionBank, Metrobank, Landbank), and **Visa/Mastercard** (~3.125% + ₱13.39 + VAT).

### 3.1 Self-Service Flow (`/signup-school`)

```text
School Head / IT Coordinator opens /signup-school
  │
  ├── 1. Chooses Plan: FREE (₱0) | PRO (₱1,990/mo) | CAMPUS (₱5,990/mo)
  │      + Billing Cycle: Monthly | Semestral (6 mo) | Annual (12 mo)
  │      + Enters: School Name, URL Slug (e.g. "ispsc-tagudin"),
  │        Admin First/Last Name, Admin Email
  │
  ├── [Path A: FREE Plan]
  │     └─ Backend creates School (ACTIVE, plan=FREE) + initial ADMIN user
  │        + seeds GradingScale, RolePermissions, SystemSettings (Asia/Manila)
  │        + emails verification/invite link (or returns one-time setup link if SMTP off)
  │        └─ Redirects to /s/<slug>/login
  │
  └── [Path B: PAID Plan (PRO / CAMPUS)]
        ├─ 2. Backend creates School (status=PENDING_PAYMENT or 14-day TRIAL)
        │     + pending Admin user + Checkout record (SchoolInvoice status=PENDING)
        │     + Calls POST https://api.paymongo.com/v2/checkout_sessions:
        │       • amount in centavos (e.g. 199000 for ₱1,990.00)
        │       • currency: "PHP"
        │       • payment_method_types: ["qrph", "gcash", "paymaya", "card", "dob"]
        │       • metadata: { schoolId, planCode, billingCycle, invoiceId }
        │       • success_url: https://<app>/signup-school/success?invoice=<invoiceId>
        │       • cancel_url:  https://<app>/signup-school/cancel?invoice=<invoiceId>
        │
        ├─ 3. Redirects school to PayMongo hosted checkout_url (pays via GCash/Maya/QR Ph/Card)
        │
        └─ 4. PayMongo sends POST /api/webhooks/paymongo (checkout_session.payment.paid)
              ├─ Verify `Paymongo-Signature` header BEFORE parsing JSON (raw body required!)
              ├─ Check idempotency (`paymongoEventId` unique in `BillingEvent`)
              ├─ Update `SchoolInvoice` -> PAID (save payment method, fee/reference)
              ├─ Activate `School` (`status: ACTIVE`, set `plan`, quotas, `currentPeriodEnd`)
              └─ Activate/invite initial `ADMIN` (`ACCOUNT_INVITE` token via e-mail)
```

### 3.2 Important Security & Webhook Implementation Details
1. **Raw Body Before `express.json()`:** In `backend/src/app.js`, mount `POST /api/webhooks/paymongo`
   **before** `express.json({ limit: '2mb' })` using `express.raw({ type: 'application/json' })` and
   exempt it from `csrfProtection` (it authenticates via HMAC signature instead of session cookies).
2. **`Paymongo-Signature` Verification:** Parse `t=<timestamp>,te=<testSig>,li=<liveSig>` from
   `req.headers['paymongo-signature']`, compute `HMAC-SHA256(webhookSecret, "${t}.${rawBody}")`, and
   compare against `li` (live) or `te` (test) using `crypto.timingSafeEqual`.
3. **Never Trust `success_url` Alone:** On `/signup-school/success?invoice=...`, poll
   `GET /api/billing/checkout-status/:invoiceId` (which can also safely fall back to checking
   `GET https://api.paymongo.com/v2/checkout_sessions/:id` if the webhook is delayed by a few seconds).

### 3.3 Renewal & Grace Period (Because GCash / Maya / QR Ph Are Push Payments)
Unlike credit cards, **GCash, Maya, and QR Ph wallets cannot be auto-debited silently each month**:
* **Automated Reminders (`api/internal/cron`):** At **7 days**, **3 days**, and **1 day** before
  `SchoolSubscription.currentPeriodEnd`, send an e-mail + show an in-app banner to the school's
  `ADMIN` with a 1-click **"Renew Now (GCash / Maya / QR Ph / Card)"** button that generates a fresh
  PayMongo Checkout Session.
* **7-Day Grace Period (`PAST_DUE`):** If `currentPeriodEnd` passes unpaid, set `status = PAST_DUE`
  for 7 days. Classes continue normally with an admin renewal notice.
* **Soft Suspension (`SUSPENDED`):** After the grace period:
  * Students & teachers see *"This school's subscription has paused — contact your school administrator."*
  * School `ADMIN` can **still sign in** to: (a) pay & immediately restore access via PayMongo, or
    (b) export grades/records (preserving data portability under **RA 10173**).
* **Manual / Institutional Payments (DepEd / CHED / Bank Transfer):** Many Philippine schools pay by
  cheque, Landbank deposit, or Purchase Order for a full semester or school year. The `SUPER_ADMIN`
  can generate an invoice/reference and click **"Mark Paid & Extend Term"** in the Superadmin UI.

---

## 4. Superadmin Portal & Per-School Admin Provisioning

This satisfies your core workflow: **the platform `SUPER_ADMIN` creates each school and provisions
the school's `ADMIN` account(s)** (used both when you onboard schools personally and when managing
self-registered schools).

### 4.1 Superadmin API (`backend/src/modules/superadmin/routes.js`, gated by `requireRole('SUPER_ADMIN')`)

| Endpoint | Purpose |
|---|---|
| `GET /api/superadmin/overview` | Platform metrics: total schools by plan (`FREE`/`PRO`/`CAMPUS`), active users, total storage MB, expiring trials/subscriptions, failed webhooks. |
| `GET /api/superadmin/schools` | Search/filter schools with live counts (students, teachers, classes, storage used, `currentPeriodEnd`). |
| `POST /api/superadmin/schools` | **Create School & Initial Admin (atomic transaction):** accepts `name`, `slug`, `plan`, `status` (`TRIAL`/`ACTIVE`), custom quotas (optional override), and `admin: { firstName, lastName, email, temporaryPassword? }`. Seeds default `GradingScale`, `RolePermission`s, and `SystemSetting` rows for that school, creates the initial `ADMIN` (`mustChangePassword: true` or `ACCOUNT_INVITE` e-mail), and logs an `AuditLog` entry. |
| `PATCH /api/superadmin/schools/:schoolId` | Change `plan` (`FREE`/`PRO`/`CAMPUS`), adjust `maxStudents`/`maxTeachers`/`storageQuotaMb`/`aiDailyLimit`, toggle `status` (`ACTIVE`/`SUSPENDED`/`TRIAL`), or set custom `domain`. |
| `POST /api/superadmin/schools/:schoolId/admins` | Add another `ADMIN` to an existing school, or reset/unlock a locked-out school admin's password. |
| `POST /api/superadmin/schools/:schoolId/payments` | Record a manual/bank/cheque payment, extend `currentPeriodEnd` (e.g. +1 month, +6 months, +12 months), and automatically restore `ACTIVE` status. |

### 4.2 Superadmin UI (`frontend/src/pages/superadmin/`)
When signed in as `SUPER_ADMIN`, the sidebar displays a dedicated platform console:
* **Schools Directory:** Plan badge, seat meters (`312 / 600 students`), storage meter (`1.2 / 5 GB`),
  status pill (`ACTIVE`, `TRIAL`, `PAST_DUE`, `SUSPENDED`), and quick actions.
* **"Create School & Admin" Wizard:** One screen returning:
  * School login URL: `https://edusphere-sigma-two.vercel.app/s/<slug>/login`
  * Admin email + invite status (or copyable one-time temporary password if SMTP is disabled).
* **Billing & Subscriptions:** View PayMongo transactions + log manual bank/PO payments.

---

## 5. Exact Database Schema & Tenant Isolation Plan

### 5.1 New Enums & Models (`backend/prisma/schema.prisma`)

```prisma
enum Role {
  SUPER_ADMIN
  ADMIN
  TEACHER
  STUDENT
}

enum SchoolPlan {
  FREE
  PRO
  CAMPUS
}

enum SchoolStatus {
  PENDING_PAYMENT
  TRIAL
  ACTIVE
  PAST_DUE
  SUSPENDED
}

enum BillingCycle {
  MONTHLY
  SEMESTRAL
  ANNUAL
}

model School {
  id                  String       @id @default(cuid())
  slug                String       @unique
  name                String
  customDomain        String?      @unique
  logoFileId          String?
  plan                SchoolPlan   @default(FREE)
  status              SchoolStatus @default(ACTIVE)
  maxStudents         Int          @default(150)
  maxTeachers         Int          @default(10)
  maxActiveClasses    Int?         @default(15)
  storageQuotaMb      Int          @default(250)
  aiDailyLimit        Int          @default(15)
  allowExternalAiKey  Boolean      @default(false)
  sandboxDailyLimit   Int          @default(0)
  trialEndsAt         DateTime?    @db.Timestamptz(3)
  createdAt           DateTime     @default(now()) @db.Timestamptz(3)
  updatedAt           DateTime     @updatedAt @db.Timestamptz(3)

  subscription        SchoolSubscription?
  invoices            SchoolInvoice[]
  users               User[]
  classes             Class[]
  settings            SystemSetting[]
  // ...relations to AcademicYear, Department, AcademicProgram, Course, Section, GradingScale,
  //    Announcement, File, ClassroomLocation, QuestionBank, Rubric, AuditLog
}

model SchoolSubscription {
  id                 String        @id @default(cuid())
  schoolId           String        @unique
  provider           String        // "FREE" | "PAYMONGO" | "MANUAL"
  plan               SchoolPlan
  billingCycle       BillingCycle  @default(MONTHLY)
  status             String        // "ACTIVE" | "TRIALING" | "PAST_DUE" | "CANCELED"
  currentPeriodStart DateTime?     @db.Timestamptz(3)
  currentPeriodEnd   DateTime?     @db.Timestamptz(3)
  graceEndsAt        DateTime?     @db.Timestamptz(3)
  lastReminderStage  Int           @default(0) // 0=none, 7=T-7d, 3=T-3d, 1=T-1d, -1=expired
  updatedAt          DateTime      @updatedAt @db.Timestamptz(3)

  school School @relation(fields: [schoolId], references: [id], onDelete: Cascade)
}

model SchoolInvoice {
  id                  String       @id @default(cuid())
  schoolId            String
  plan                SchoolPlan
  billingCycle        BillingCycle
  amountCentavos      Int          // e.g. 199000 = ₱1,990.00
  currency            String       @default("PHP")
  provider            String       // "PAYMONGO" | "MANUAL"
  checkoutSessionId   String?      @unique
  paymentIntentId     String?
  paymentMethod       String?      // "gcash" | "paymaya" | "qrph" | "card" | "dob" | "bank"
  referenceNumber     String?      @unique
  status              String       // "PENDING" | "PAID" | "FAILED" | "EXPIRED"
  paidAt              DateTime?    @db.Timestamptz(3)
  createdAt           DateTime     @default(now()) @db.Timestamptz(3)

  school School @relation(fields: [schoolId], references: [id], onDelete: Cascade)
}

model BillingEvent {
  id          String   @id @default(cuid())
  provider    String   // "PAYMONGO"
  eventId     String   @unique
  eventType   String
  processedAt DateTime @default(now()) @db.Timestamptz(3)
}
```

### 5.2 Scoping Existing EduSphere Models by `schoolId`
Add `schoolId` (nullable only on `User` and `AuditLog` for `SUPER_ADMIN`, non-null after backfill
on all school-owned models):
* **Identity & Settings:**
  * `User` (`schoolId String?` — `null` **only** when `role = 'SUPER_ADMIN'`)
  * `SystemSetting`: replace `@id` on `key` with `id String @id @default(cuid())` and
    `@@unique([schoolId, key])` so **each school independently configures** `institution.name`,
    `institution.timezone`, `attendance.*`, `analytics.*`, and encrypted `ai.providerConfig`.
  * `RolePermission`: either stay global defaults or support optional per-school overrides.
* **Catalog & Academic Structure:**
  * `Department`, `AcademicProgram`, `AcademicYear`, `Course`, `Section`, `GradingScale`, `Class`.
* **Shared / Top-Level Content & Telemetry:**
  * `Announcement` (school-wide announcements must only show to users in that school),
  * `File` (enforces per-school `storageQuotaMb` efficiently via `SUM(sizeBytes) WHERE schoolId = ? AND deletedAt IS NULL`),
  * `ClassroomLocation`, `QuestionBank`, `Rubric`, `AIGenerationUsage`, `AuditLog`.
* **Email Uniqueness Design Choice (Recommended):**
  * **Keep `User.email` globally unique (`@unique`) in Phase 1**, while still offering branded
    school URLs (`/s/:schoolSlug/login`) and hostname routing (`ispsc.edusphere.ph`).
  * Why: users logging in at `/` only type their email and password without needing to remember a
    school code — the backend resolves `user.schoolId` automatically after login!

### 5.3 Zero-Downtime Migration & Backfill
1. Insert a default `School` row (`id: 'default-school'`, `slug: 'default'`, `plan: 'CAMPUS'`,
   `status: 'ACTIVE'`, `name` copied from `SystemSetting['institution.name']`).
2. Add nullable `schoolId` columns + backfill `UPDATE ... SET school_id = 'default-school'`.
3. Verify zero nulls on tenant tables, add foreign keys + composite indexes (`@@index([schoolId, ...])`),
   and enforce `NOT NULL` on all school-owned tables.

### 5.4 Tenant Isolation & Quota Enforcement Middleware
* `backend/src/middleware/tenant.js`:
  * Authenticated routes attach `req.schoolId = req.user.schoolId` (and reject non-`SUPER_ADMIN`
    users if their school is `SUSPENDED` except `/api/billing/*` and `/api/auth/logout` for `ADMIN`).
  * Public/auth routes resolve school context from `customDomain` / subdomain (`req.hostname`) OR
    `/s/:schoolSlug` / `req.body.schoolSlug`.
* **Quota Guards:**
  * `createUser` / self-registration / CSV bulk import → checks `maxStudents` / `maxTeachers`.
  * `createClass` / `rolloverClass` → checks `maxActiveClasses`.
  * `services/storage.js` (`checkSchoolStorageQuota`) → sums `File.sizeBytes` for `req.schoolId` vs `storageQuotaMb`.
  * `ai` routes → reads school `aiDailyLimit` and blocks external BYO keys unless `allowExternalAiKey` is true.
  * `programming` server judge → checks school `sandboxDailyLimit` (browser Pyodide remains free & unlimited).
* **Mandatory Security Tests:** Add a dedicated `backend/tests/api/tenant-isolation.test.js` suite
  asserting that an `ADMIN` or `TEACHER` from School A receives `403`/`404` when probing any ID
  (class, student, grade, file, announcement, AI key, audit log) belonging to School B.

---

## 6. Recommended Implementation Phases (When You Are Ready)

| Phase | Scope | Deliverables |
|---|---|---|
| **Phase 1: Multi-Tenant Core** | Schema + isolation without billing UI yet | `School` + `SUPER_ADMIN` role, `schoolId` backfill migration, `SystemSetting` per-school scoping, `tenant.js` middleware, `/s/:slug/login` route, cross-tenant API isolation tests. |
| **Phase 2: Superadmin Portal** | Manual school & admin provisioning | `/api/superadmin/*` routes, Superadmin UI (**Create School & Initial Admin** wizard, quota controls, suspend/reactivate, school admin password resets). |
| **Phase 3: Object Storage (R2/S3)** | Lift Neon database file cap | Add S3/Cloudflare R2 driver to `backend/src/services/storage.js` + per-school storage quota enforcement (needed before onboarding paid schools). |
| **Phase 4: Self-Service + PayMongo** | Automated PHP subscriptions | `/signup-school` wizard, `POST /api/webhooks/paymongo` (raw-body HMAC check + idempotency), Checkout Sessions (`qrph`, `gcash`, `paymaya`, `card`, `dob`), T-7/T-3/T-1 renewal cron & 7-day grace period. |
