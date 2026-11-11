// Reads a QR code with the device camera. Frames are decoded on the device; no picture leaves it.
import jsQR from 'jsqr';
import { CameraOff } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from './ui.jsx';

const explain = (err) => {
  if (err?.name === 'NotAllowedError' || err?.name === 'SecurityError') return 'Camera permission was denied. Allow camera access for this site, or type the attendance code instead.';
  if (err?.name === 'NotFoundError' || err?.name === 'OverconstrainedError') return 'No camera was found on this device. Type the attendance code instead.';
  if (err?.name === 'NotReadableError') return 'The camera is being used by another app. Close it and try again.';
  return 'The camera could not be started. Type the attendance code instead.';
};

export default function QrScanner({ onResult, paused = false }) {
  const video = useRef(null);
  const [error, setError] = useState(null);
  const [attempt, setAttempt] = useState(0);
  const deliver = useRef(onResult);
  deliver.current = onResult;
  const hold = useRef(paused);
  hold.current = paused;

  useEffect(() => {
    let stream = null;
    let frame = 0;
    let stopped = false;
    let last = { text: null, at: 0 };
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const detector = 'BarcodeDetector' in window ? new window.BarcodeDetector({ formats: ['qr_code'] }) : null;

    const found = (text) => {
      // The same code stays in view for a while: report it once every few seconds.
      if (!text || (text === last.text && Date.now() - last.at < 4000)) return;
      last = { text, at: Date.now() };
      deliver.current(text);
    };
    const scan = async () => {
      if (stopped) return;
      const el = video.current;
      if (el && el.readyState >= 2 && !hold.current) {
        try {
          if (detector) {
            const codes = await detector.detect(el);
            found(codes[0]?.rawValue);
          } else {
            // Decode a reduced frame: plenty for a QR code and much lighter on old phones.
            const scale = Math.min(1, 640 / Math.max(el.videoWidth, el.videoHeight));
            canvas.width = Math.round(el.videoWidth * scale);
            canvas.height = Math.round(el.videoHeight * scale);
            context.drawImage(el, 0, 0, canvas.width, canvas.height);
            const image = context.getImageData(0, 0, canvas.width, canvas.height);
            found(jsQR(image.data, image.width, image.height, { inversionAttempts: 'dontInvert' })?.data);
          }
        } catch {
          /* a frame that cannot be decoded is simply skipped */
        }
      }
      frame = window.setTimeout(scan, 180);
    };

    if (!navigator.mediaDevices?.getUserMedia) {
      setError('This browser cannot use the camera here. Type the attendance code instead.');
      return undefined;
    }
    navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } })
      .then((s) => {
        if (stopped) { s.getTracks().forEach((t) => t.stop()); return; }
        stream = s;
        setError(null);
        video.current.srcObject = s;
        video.current.play().catch(() => {});
        scan();
      })
      .catch((err) => setError(explain(err)));

    return () => {
      stopped = true;
      clearTimeout(frame);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [attempt]);

  if (error) {
    return (
      <div className="flex aspect-square w-full flex-col items-center justify-center gap-3 rounded-2xl border border-line bg-raised p-6 text-center">
        <CameraOff className="size-8 text-faint" aria-hidden="true" />
        <p className="text-sm text-soft" role="alert">{error}</p>
        <Button variant="secondary" size="sm" onClick={() => { setError(null); setAttempt((n) => n + 1); }}>Try the camera again</Button>
      </div>
    );
  }
  return (
    <div className="relative aspect-square w-full overflow-hidden rounded-2xl bg-black">
      <video ref={video} playsInline muted className="size-full object-cover" aria-label="Camera preview. Point it at the QR code on your teacher’s screen." />
      {/* Viewfinder */}
      <div className="pointer-events-none absolute inset-[14%] rounded-2xl border-2 border-white/90 shadow-[0_0_0_100vmax_rgba(0,0,0,0.35)]" aria-hidden="true" />
      <p className="pointer-events-none absolute inset-x-0 bottom-3 text-center text-[13px] font-medium text-white drop-shadow">Point at the QR code on your teacher’s screen</p>
    </div>
  );
}
