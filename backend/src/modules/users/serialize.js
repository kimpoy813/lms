import { fullName } from '../../lib/http.js';

/** The signed-in user's own account, as returned by /api/auth/session. */
export function serializeSelf(user) {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    status: user.status,
    firstName: user.firstName,
    lastName: user.lastName,
    middleName: user.middleName,
    name: fullName(user),
    phone: user.phone,
    avatarFileId: user.avatarFileId,
    emailVerified: Boolean(user.emailVerifiedAt),
    mustChangePassword: user.mustChangePassword,
    emailNotifications: user.emailNotifications,
    isDemo: user.isDemo,
    lastLoginAt: user.lastLoginAt,
    studentProfile: user.studentProfile
      ? {
          studentNumber: user.studentProfile.studentNumber,
          programId: user.studentProfile.programId,
          sectionId: user.studentProfile.sectionId,
          yearLevel: user.studentProfile.yearLevel,
        }
      : null,
    teacherProfile: user.teacherProfile
      ? {
          employeeNumber: user.teacherProfile.employeeNumber,
          departmentId: user.teacherProfile.departmentId,
          position: user.teacherProfile.position,
          specialization: user.teacherProfile.specialization,
          consultationHours: user.teacherProfile.consultationHours,
          bio: user.teacherProfile.bio,
        }
      : null,
  };
}

/** Full account record for the administrator's user management screens. */
export function serializeAdminUser(user) {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    status: user.status,
    firstName: user.firstName,
    lastName: user.lastName,
    middleName: user.middleName,
    name: fullName(user),
    phone: user.phone,
    emailVerified: Boolean(user.emailVerifiedAt),
    mustChangePassword: user.mustChangePassword,
    isDemo: user.isDemo,
    lockedUntil: user.lockedUntil && user.lockedUntil > new Date() ? user.lockedUntil : null,
    suspendedAt: user.suspendedAt,
    suspendedReason: user.suspendedReason,
    anonymizedAt: user.anonymizedAt,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
    studentProfile: user.studentProfile
      ? {
          studentNumber: user.studentProfile.studentNumber,
          programId: user.studentProfile.programId,
          program: user.studentProfile.program ? { id: user.studentProfile.program.id, code: user.studentProfile.program.code, name: user.studentProfile.program.name } : null,
          sectionId: user.studentProfile.sectionId,
          section: user.studentProfile.section ? { id: user.studentProfile.section.id, name: user.studentProfile.section.name } : null,
          yearLevel: user.studentProfile.yearLevel,
        }
      : null,
    teacherProfile: user.teacherProfile
      ? {
          employeeNumber: user.teacherProfile.employeeNumber,
          departmentId: user.teacherProfile.departmentId,
          department: user.teacherProfile.department ? { id: user.teacherProfile.department.id, code: user.teacherProfile.department.code, name: user.teacherProfile.department.name } : null,
          position: user.teacherProfile.position,
        }
      : null,
  };
}
