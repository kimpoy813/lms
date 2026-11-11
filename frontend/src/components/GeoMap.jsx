// A small map for attendance: shows the classroom pin and the allowed radius, and (when
// `onPick` is given) lets the teacher place the pin by tapping the map or dragging it.
// Loaded on demand — see LazyMap below in components/LazyMap.jsx.
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useEffect, useRef, useState } from 'react';

const pin = L.divIcon({
  className: '',
  iconSize: [28, 36],
  iconAnchor: [14, 34],
  html: '<svg width="28" height="36" viewBox="0 0 28 36" aria-hidden="true"><path d="M14 35C14 35 26 22.5 26 13.5C26 6.6 20.6 1 14 1S2 6.6 2 13.5C2 22.5 14 35 14 35Z" fill="#4f46e5" stroke="#fff" stroke-width="2"/><circle cx="14" cy="13.5" r="4.5" fill="#fff"/></svg>',
});

export default function GeoMap({ center, radius, onPick, tileUrl, attribution, height = 260, zoom = 18 }) {
  const node = useRef(null);
  const map = useRef(null);
  const marker = useRef(null);
  const circle = useRef(null);
  const pick = useRef(onPick);
  pick.current = onPick;
  const [tilesFailed, setTilesFailed] = useState(false);

  // Create the map once.
  useEffect(() => {
    const m = L.map(node.current, { center: [center.latitude, center.longitude], zoom, scrollWheelZoom: false, attributionControl: Boolean(attribution) });
    map.current = m;
    if (tileUrl) {
      let failures = 0;
      const tiles = L.tileLayer(tileUrl, { maxZoom: 19, attribution });
      tiles.on('tileerror', () => { failures += 1; if (failures >= 3) setTilesFailed(true); });
      tiles.on('tileload', () => setTilesFailed(false));
      tiles.addTo(m);
    } else {
      setTilesFailed(true);
    }
    circle.current = L.circle([center.latitude, center.longitude], { radius: radius ?? 0, color: '#4f46e5', weight: 2, fillColor: '#6366f1', fillOpacity: 0.16 }).addTo(m);
    marker.current = L.marker([center.latitude, center.longitude], { icon: pin, draggable: Boolean(onPick), keyboard: Boolean(onPick), alt: 'Classroom location' }).addTo(m);
    marker.current.on('dragend', () => {
      const p = marker.current.getLatLng();
      pick.current?.({ latitude: p.lat, longitude: p.lng });
    });
    m.on('click', (e) => pick.current?.({ latitude: e.latlng.lat, longitude: e.latlng.lng }));
    // The container may get its size after the first paint (e.g. inside a dialog).
    const resize = new ResizeObserver(() => m.invalidateSize());
    resize.observe(node.current);
    return () => {
      resize.disconnect();
      m.remove();
      map.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Follow changes of the pin and the radius.
  useEffect(() => {
    if (!map.current) return;
    const at = [center.latitude, center.longitude];
    marker.current.setLatLng(at);
    circle.current.setLatLng(at);
    circle.current.setRadius(radius ?? 0);
    if (radius) map.current.fitBounds(circle.current.getBounds(), { padding: [24, 24], maxZoom: 19, animate: false });
    else map.current.panTo(at, { animate: false });
  }, [center.latitude, center.longitude, radius]);

  return (
    <div className="relative">
      <div ref={node} style={{ height }} className="map-grid w-full overflow-hidden rounded-xl border border-line" role="application" aria-label={onPick ? 'Map. Tap to place the classroom pin, or drag the pin.' : 'Map of the classroom location and allowed radius'} />
      {tilesFailed && <p className="pointer-events-none absolute inset-x-2 bottom-2 z-[500] rounded-lg bg-surface/90 px-2.5 py-1.5 text-center text-[11px] text-faint">The map background could not be loaded. The pin and the radius still work.</p>}
    </div>
  );
}
