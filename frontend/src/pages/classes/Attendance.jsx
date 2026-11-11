// Attendance tab: teachers run sessions and review records; students see their own record.
import { useClass } from './useClass.js';
import StudentAttendance from './attendance/StudentAttendance.jsx';
import TeacherAttendance from './attendance/TeacherAttendance.jsx';

export default function Attendance() {
  const { canManage } = useClass();
  return canManage ? <TeacherAttendance /> : <StudentAttendance />;
}
