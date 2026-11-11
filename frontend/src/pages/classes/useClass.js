import { useOutletContext } from 'react-router';

/** The class a workspace page belongs to: { cls, canManage, isStudent, base } */
export const useClass = () => useOutletContext();

export const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const DAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const classLabel = (c) => `${c.course.code}${c.section ? ` · ${c.section.name}` : ''}`;
