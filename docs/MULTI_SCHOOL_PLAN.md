# Multi-School SaaS & Superadmin Vision Roadmap

This document outlines how to evolve EduSphere from its current **single-institution deployment**
into a **multi-school SaaS platform** where:
- Schools subscribe (free or paid plans) to get isolated access to EduSphere, and
- A platform **Superadmin** provisions schools, manages plan access, and creates the initial
  school **Admin** account for each school.

> Current status: **Planning blueprint only.** The live single-school schema and routes remain
> untouched so production stays stable until you are ready to implement Phase 1.

---

## 1. Role & Tenant Hierarchy

| Role / Entity | Scope | Responsibilities |
|---|---|---|
| `SUPER_ADMIN` | Platform-wide (`schoolId = null`) | Creates/suspends schools, assigns subscription/free plans, creates initial school `ADMIN` accounts, views platform health & aggregate usage |
| `ADMIN` | Single `School` (`schoolId` required) | Manages that school's teachers, students, academic years, courses, sections, enrollments, AI key config, and school settings |
| `TEACHER` | Single `School` (`schoolId` required) | Teaches classes, builds modules/quizzes/assignments/coding problems, uses AI Studio, grades work |
| `STUDENT` | Single `School` (`schoolId` required) | Enrolls in classes within their school, checks attendance, takes quizzes, views grades, uses opt-in Study Coach |

---

## 2. Database Schema Additions (`backend/prisma/schema.prisma`)

1. **Add `SUPER_ADMIN` to `enum Role`** (`SUPER_ADMIN`, `ADMIN`, `TEACHER`, `STUDENT`).
2. **Create `School`, `SubscriptionPlan`, and `SchoolSubscription` models**:
   - `School`: `id`, `slug` (unique, URL/login friendly), `name`, `domain` (optional custom domain),
     `logoUrl`, `status` (`TRIAL` | `ACTIVE` | `SUSPENDED`), `plan` (`FREE` | `PRO` | `ENTERPRISE`),
     `maxStudents`, `maxTeachers`, `storageQuotaMb`, `aiModeAllowed`, `createdAt`, `updatedAt`.
   - `SchoolSubscription`: `id`, `schoolId`, `provider` (e.g. `MANUAL` / `STRIPE` / `PAYMONGO`),
     `externalCustomerId`, `externalSubscriptionId`, `planCode`, `status` (`ACTIVE` | `PAST_DUE` |
     `CANCELED` | `TRIALING`), `currentPeriodEnd`, `createdAt`.
3. **Add `schoolId` (non-null once backfilled) to top-level tenant-owned tables**:
   - `User` (`@@unique([schoolId, email])` or globally unique email with `schoolId` nullable only for `SUPER_ADMIN`),
   - `AcademicYear`, `Department`, `AcademicProgram`, `Course`, `Section`, `GradingScale`,
     `Class`, `Announcement` (school-wide announcements scoped by `schoolId`),
   - `SystemSetting` (`@@id([schoolId, key])` or composite unique `[schoolId, key]` so each school
     has its own `institution.name`, attendance defaults, and encrypted `ai.providerConfig`),
   - `FileObject` (per-school storage quota enforcement),
   - `AuditLog` (`schoolId` nullable for platform-level `SUPER_ADMIN` actions).
4. **Zero-downtime backfill migration**:
   - Create a default `School` row (`id: 'default-school'`, `slug: 'default'`, `name` copied from
     existing `SystemSetting['institution.name']`), backfill `schoolId = 'default-school'` across
     existing rows, then apply `NOT NULL` + foreign key constraints.

---

## 3. Tenant Resolution & Strict Isolation

### Request Context (`backend/src/middleware/tenant.js`)
- Authenticated routes resolve `req.schoolId = req.user.schoolId` from the session user (never
  trusted from client body/query parameters unless `req.user.role === 'SUPER_ADMIN'` in `/api/superadmin/*`).
- Public/auth routes (`/api/auth/login`, `/api/auth/register`, `/api/auth/config`) resolve the
  school by:
  1. Custom hostname / subdomain (`school-a.edusphere.app`), OR
  2. Explicit `schoolSlug` on sign-in / registration forms (or direct link `/s/:schoolSlug/login`).
- Wrap every module query (`classes`, `users`, `catalog`, `enrollments`, `gradebook`, `files`,
  `announcements`, `search`, `ai`, `programming`) with mandatory `schoolId: req.schoolId` filtering
  (plus a shared test suite asserting cross-school isolation: Teacher/Admin of School A always
  gets `404`/`403` when probing School B IDs).

---

## 4. Superadmin Portal & School Provisioning Flow

1. **New backend module `backend/src/modules/superadmin/routes.js`** (`requireRole('SUPER_ADMIN')`):
   - `GET /api/superadmin/schools` — list schools, plan tier, active user/class counts, storage used.
   - `POST /api/superadmin/schools` — create a school (`name`, `slug`, `plan`: `FREE`/`PRO`/`ENTERPRISE`,
     `status`), seed its default grading scale + role permissions + `SystemSetting` defaults, AND
     atomically create its initial `ADMIN` user (with temporary password + `mustChangePassword: true`
     or password-setup e-mail token).
   - `PATCH /api/superadmin/schools/:schoolId` — upgrade/downgrade plan, toggle `ACTIVE`/`SUSPENDED`,
     adjust seat/storage quotas.
   - `POST /api/superadmin/schools/:schoolId/admins` — create additional school `ADMIN` accounts or
     reset a locked-out school admin's password.
2. **Frontend routes (`frontend/src/pages/superadmin/*`)**:
   - Dedicated `SUPER_ADMIN` nav section (`Schools`, `Plans & Subscriptions`, `Platform Audit`).
   - One-screen **"Create School & Initial Admin"** wizard returning the login URL (`/s/<slug>/login`)
     and temporary admin credentials / setup link.

---

## 5. Free vs. Paid Subscription Model

| Feature | Free School Tier | Paid School Tier (`PRO` / `ENTERPRISE`) |
|---|---|---|
| Core LMS (classes, modules, quizzes, QR attendance, gradebook) | Included (capped seats, e.g. 150 students) | Higher/unlimited seats + custom domain |
| Built-in zero-key AI (`edusphere-builtin-v1`) & Study Coach | Included | Included + optional school-owned external LLM keys |
| Browser Python runner (Pyodide) | Included | Included |
| Server Sandbox multi-language judge (`C/C++/Java/JS/Python`) | Rate-capped / optional | Full quota |
| Database / Object storage | e.g. 250 MB per school | e.g. 10 GB+ (requires S3/R2 driver in `services/storage.js`) |
| Self-service school onboarding | Public `/signup-school` creates `FREE` or `TRIAL` school -> webhook upgrades via Stripe/PayMongo | Instant checkout -> automatic plan & quota update |

### Recommended Implementation Order (When Ready)
1. **Phase 1 (Tenant Core):** Add `School` + `SUPER_ADMIN` role + `schoolId` backfill migration + tenant middleware + cross-tenant API tests.
2. **Phase 2 (Superadmin Console):** Build `/api/superadmin/*` and Superadmin UI for creating schools, assigning free/paid plans, and creating each school's `ADMIN`.
3. **Phase 3 (Self-Service Billing & S3 Storage):** Add public school signup, Stripe/PayMongo webhook integration, plan-quota enforcement middleware, and an S3/R2 storage adapter in `backend/src/services/storage.js`.
