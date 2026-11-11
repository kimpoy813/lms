// Everything announced to the signed-in user: institution-wide news and posts from their classes.
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../auth/AuthContext.jsx';
import { PageHeader } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import AnnouncementFeed from './announcements/Feed.jsx';
import { classLabel } from './classes/useClass.js';

export default function Announcements() {
  const { isStudent, isAdmin } = useAuth();
  const classes = useQuery({ queryKey: ['classes', { status: 'ACTIVE', term: '' }], queryFn: () => api.get('/classes', { status: 'ACTIVE' }), enabled: !isStudent });
  const options = (classes.data ?? []).map((c) => ({ id: c.id, label: `${classLabel(c)} — ${c.course.title}` }));
  return (
    <>
      <PageHeader title="Announcements" description={isStudent ? 'News from your school and your classes.' : isAdmin ? 'Post news for the whole institution, or read what classes have announced.' : 'News from the school, and what you have posted to your classes.'} />
      <AnnouncementFeed canPost={isAdmin || (!isStudent && options.length > 0)} classes={options} />
    </>
  );
}
