import { lazy, Suspense } from 'react';
import { Skeleton } from './ui.jsx';

const GeoMap = lazy(() => import('./GeoMap.jsx'));

/** The attendance map, downloaded only when a location is involved. Same props as GeoMap. */
export default function LazyMap(props) {
  return (
    <Suspense fallback={<Skeleton className="w-full rounded-xl" style={{ height: props.height ?? 260 }} />}>
      <GeoMap {...props} />
    </Suspense>
  );
}
