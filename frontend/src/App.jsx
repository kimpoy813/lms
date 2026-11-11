// Routes. Pages are loaded on demand so the first screen stays small on slow connections.
import { lazy, Suspense } from 'react';
import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router';
import { useAuth } from './auth/AuthContext.jsx';
import { ErrorBoundary } from './components/ErrorBoundary.jsx';
import { Button, EmptyState, PageLoader } from './components/ui.jsx';
import AppShell from './layout/AppShell.jsx';

const page = (loader) => lazy(loader);

// Public
const Login = page(() => import('./pages/auth/Login.jsx'));
const Register = page(() => import('./pages/auth/Register.jsx'));
const ForgotPassword = page(() => import('./pages/auth/ForgotPassword.jsx'));
const SetPassword = page(() => import('./pages/auth/SetPassword.jsx'));
const VerifyEmail = page(() => import('./pages/auth/VerifyEmail.jsx'));
const ChangePassword = page(() => import('./pages/auth/ChangePassword.jsx'));
const Privacy = page(() => import('./pages/Privacy.jsx'));

// Everyone
const Dashboard = page(() => import('./pages/Dashboard.jsx'));
const Classes = page(() => import('./pages/classes/Classes.jsx'));
const ClassLayout = page(() => import('./pages/classes/ClassLayout.jsx'));
const ClassOverview = page(() => import('./pages/classes/Overview.jsx'));
const Modules = page(() => import('./pages/classes/Modules.jsx'));
const ModuleView = page(() => import('./pages/classes/ModuleView.jsx'));
const Assignments = page(() => import('./pages/classes/Assignments.jsx'));
const AssignmentDetail = page(() => import('./pages/classes/AssignmentDetail.jsx'));
const Submissions = page(() => import('./pages/classes/Submissions.jsx'));
const Quizzes = page(() => import('./pages/classes/Quizzes.jsx'));
const QuizDetail = page(() => import('./pages/classes/QuizDetail.jsx'));
const QuizResults = page(() => import('./pages/classes/QuizResults.jsx'));
const QuizAttempt = page(() => import('./pages/classes/QuizAttempt.jsx'));
const Attendance = page(() => import('./pages/classes/Attendance.jsx'));
const ClassGrades = page(() => import('./pages/classes/Grades.jsx'));
const Gradebook = page(() => import('./pages/classes/Gradebook.jsx'));
const People = page(() => import('./pages/classes/People.jsx'));
const Discussions = page(() => import('./pages/classes/Discussions.jsx'));
const Thread = page(() => import('./pages/classes/Thread.jsx'));
const Resources = page(() => import('./pages/classes/Resources.jsx'));
const ClassAnnouncements = page(() => import('./pages/classes/ClassAnnouncements.jsx'));
const Analytics = page(() => import('./pages/classes/Analytics.jsx'));
const ClassSettings = page(() => import('./pages/classes/ClassSettings.jsx'));

const Scan = page(() => import('./pages/Scan.jsx'));
const MyGrades = page(() => import('./pages/MyGrades.jsx'));
const Announcements = page(() => import('./pages/Announcements.jsx'));
const Messages = page(() => import('./pages/Messages.jsx'));
const Calendar = page(() => import('./pages/Calendar.jsx'));
const Consultations = page(() => import('./pages/Consultations.jsx'));
const Notifications = page(() => import('./pages/Notifications.jsx'));
const Profile = page(() => import('./pages/Profile.jsx'));
const Programming = page(() => import('./pages/Programming.jsx'));
const ProblemView = page(() => import('./pages/ProblemView.jsx'));

// Teachers
const QuestionBanks = page(() => import('./pages/QuestionBanks.jsx'));
const BankView = page(() => import('./pages/BankView.jsx'));
const Rubrics = page(() => import('./pages/Rubrics.jsx'));
const AiStudio = page(() => import('./pages/AiStudio.jsx'));

// Administrators
const AdminUsers = page(() => import('./pages/admin/Users.jsx'));
const AdminCatalog = page(() => import('./pages/admin/Catalog.jsx'));
const AdminEnrollments = page(() => import('./pages/admin/Enrollments.jsx'));
const AdminSettings = page(() => import('./pages/admin/Settings.jsx'));
const AdminPermissions = page(() => import('./pages/admin/Permissions.jsx'));
const AdminAudit = page(() => import('./pages/admin/Audit.jsx'));

function FullScreen({ children }) {
  return <Suspense fallback={<div className="grid min-h-dvh place-items-center"><PageLoader /></div>}>{children}</Suspense>;
}

/** Signed-out pages. A signed-in visitor is sent to where they were going. */
function PublicOnly() {
  const { status } = useAuth();
  const location = useLocation();
  if (status === 'loading') return <div className="grid min-h-dvh place-items-center"><PageLoader /></div>;
  if (status === 'in') return <Navigate to={location.state?.from ?? '/'} replace />;
  return <FullScreen><Outlet /></FullScreen>;
}

/** Signed-in pages. Remembers the requested address so sign-in can return to it (e.g. a QR link). */
function Protected() {
  const { status, user, error, refresh } = useAuth();
  const location = useLocation();
  if (status === 'loading') return <div className="grid min-h-dvh place-items-center"><PageLoader /></div>;
  if (status === 'error') {
    return (
      <div className="grid min-h-dvh place-items-center">
        <EmptyState title="Could not reach EduSphere" description={error?.message ?? 'Check your connection and try again.'} action={<Button onClick={refresh}>Try again</Button>} />
      </div>
    );
  }
  if (status === 'out') return <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}` }} />;
  // A temporary password must be replaced before anything else can be used.
  if (user.mustChangePassword && location.pathname !== '/change-password') return <Navigate to="/change-password" replace />;
  return <Outlet />;
}

function Shell() {
  const location = useLocation();
  return (
    <ErrorBoundary resetKey={location.pathname}>
      <AppShell />
    </ErrorBoundary>
  );
}

/** Hide a branch of routes from roles that may not use it. The server enforces the same rule. */
function Only({ roles }) {
  const { user } = useAuth();
  if (!roles.includes(user.role)) return <NotAllowed />;
  return <Outlet />;
}

function NotAllowed() {
  return <EmptyState title="This page is not available for your account" description="If you think you should have access, ask your administrator." action={<Button to="/">Go to dashboard</Button>} />;
}

function NotFound() {
  return (
    <div className="grid min-h-[60vh] place-items-center">
      <EmptyState title="Page not found" description="The link may be old, or the page may have been moved." action={<Button to="/">Go to dashboard</Button>} />
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route element={<PublicOnly />}>
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
      </Route>
      {/* These work signed in or out: the link in the e-mail decides. */}
      <Route path="/reset-password" element={<FullScreen><SetPassword mode="reset" /></FullScreen>} />
      <Route path="/accept-invite" element={<FullScreen><SetPassword mode="invite" /></FullScreen>} />
      <Route path="/verify-email" element={<FullScreen><VerifyEmail /></FullScreen>} />
      <Route path="/privacy" element={<FullScreen><Privacy /></FullScreen>} />

      <Route element={<Protected />}>
        <Route path="/change-password" element={<FullScreen><ChangePassword /></FullScreen>} />
        <Route path="/classes/:classId/quizzes/:quizId/attempt/:attemptId" element={<FullScreen><QuizAttempt /></FullScreen>} />

        <Route element={<Shell />}>
          <Route index element={<Dashboard />} />
          <Route path="dashboard" element={<Navigate to="/" replace />} />

          <Route path="classes" element={<Classes />} />
          <Route path="classes/:classId" element={<ClassLayout />}>
            <Route index element={<ClassOverview />} />
            <Route path="modules" element={<Modules />} />
            <Route path="modules/:moduleId" element={<ModuleView />} />
            <Route path="assignments" element={<Assignments />} />
            <Route path="assignments/:assignmentId" element={<AssignmentDetail />} />
            <Route path="assignments/:assignmentId/submissions" element={<Submissions />} />
            <Route path="quizzes" element={<Quizzes />} />
            <Route path="quizzes/:quizId" element={<QuizDetail />} />
            <Route path="quizzes/:quizId/results" element={<QuizResults />} />
            <Route path="attendance" element={<Attendance />} />
            <Route path="grades" element={<ClassGrades />} />
            <Route path="gradebook" element={<Gradebook />} />
            <Route path="people" element={<People />} />
            <Route path="discussions" element={<Discussions />} />
            <Route path="discussions/:threadId" element={<Thread />} />
            <Route path="resources" element={<Resources />} />
            <Route path="announcements" element={<ClassAnnouncements />} />
            <Route path="analytics" element={<Analytics />} />
            <Route path="settings" element={<ClassSettings />} />
            <Route path="*" element={<NotFound />} />
          </Route>

          <Route path="attendance/scan" element={<Scan />} />
          <Route path="grades" element={<MyGrades />} />
          <Route path="announcements" element={<Announcements />} />
          <Route path="messages" element={<Messages />} />
          <Route path="calendar" element={<Calendar />} />
          <Route path="consultations" element={<Consultations />} />
          <Route path="notifications" element={<Notifications />} />
          <Route path="profile" element={<Profile />} />
          <Route path="programming" element={<Programming />} />
          <Route path="programming/:problemId" element={<ProblemView />} />

          <Route element={<Only roles={['TEACHER', 'ADMIN']} />}>
            <Route path="question-banks" element={<QuestionBanks />} />
            <Route path="question-banks/:bankId" element={<BankView />} />
            <Route path="rubrics" element={<Rubrics />} />
            <Route path="ai" element={<AiStudio />} />
          </Route>

          <Route path="admin" element={<Only roles={['ADMIN']} />}>
            <Route index element={<Navigate to="/admin/users" replace />} />
            <Route path="users" element={<AdminUsers />} />
            <Route path="catalog" element={<AdminCatalog />} />
            <Route path="enrollments" element={<AdminEnrollments />} />
            <Route path="settings" element={<AdminSettings />} />
            <Route path="permissions" element={<AdminPermissions />} />
            <Route path="audit" element={<AdminAudit />} />
          </Route>

          <Route path="*" element={<NotFound />} />
        </Route>
      </Route>
    </Routes>
  );
}
