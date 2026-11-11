import { lazy, Suspense } from 'react';
import { Skeleton } from './ui.jsx';

const Editor = lazy(() => import('./CodeEditor.jsx'));

/** The code editor, downloaded the first time it is needed. Same props as CodeEditor. */
export default function LazyCodeEditor(props) {
  return (
    <Suspense fallback={<Skeleton className="w-full rounded-xl" style={{ height: props.minHeight ?? 280 }} />}>
      <Editor {...props} />
    </Suspense>
  );
}
