import { lazy, Suspense } from 'react';
import { Skeleton } from './ui.jsx';

const Editor = lazy(() => import('./RichEditor.jsx'));

/** The rich-text editor, downloaded the first time it is needed. Same props as RichEditor. */
export default function LazyEditor(props) {
  return (
    <Suspense fallback={<Skeleton className="w-full" style={{ height: (props.minHeight ?? 160) + 44 }} />}>
      <Editor {...props} />
    </Suspense>
  );
}
