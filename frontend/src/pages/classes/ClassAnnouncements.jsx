import AnnouncementFeed from '../announcements/Feed.jsx';
import { useClass } from './useClass.js';

export default function ClassAnnouncements() {
  const { cls, canManage } = useClass();
  return <AnnouncementFeed classId={cls.id} canPost={canManage} readOnly={cls.status === 'ARCHIVED'} />;
}
