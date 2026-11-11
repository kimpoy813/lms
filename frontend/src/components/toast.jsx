// Small notification toasts. `toast.success('Saved')` works from anywhere, React or not.
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { useSyncExternalStore } from 'react';

let items = [];
let nextId = 1;
const subscribers = new Set();
const emit = () => subscribers.forEach((fn) => fn());

function push(kind, message, options = {}) {
  const id = nextId++;
  // The same message twice in a row (a double click) shows once.
  if (items.some((t) => t.kind === kind && t.message === message)) return id;
  items = [...items.slice(-3), { id, kind, message }];
  emit();
  const duration = options.duration ?? (kind === 'error' ? 7000 : 4000);
  if (duration > 0) setTimeout(() => dismiss(id), duration);
  return id;
}
function dismiss(id) {
  items = items.filter((t) => t.id !== id);
  emit();
}

export const toast = {
  success: (m, o) => push('success', m, o),
  error: (m, o) => push('error', m, o),
  info: (m, o) => push('info', m, o),
  warning: (m, o) => push('warning', m, o),
  dismiss,
};

const STYLES = {
  success: { icon: CheckCircle2, tone: 'text-ok' },
  error: { icon: XCircle, tone: 'text-bad' },
  warning: { icon: AlertTriangle, tone: 'text-warn' },
  info: { icon: Info, tone: 'text-info' },
};

export function Toaster() {
  const list = useSyncExternalStore((fn) => (subscribers.add(fn), () => subscribers.delete(fn)), () => items);
  return (
    <div className="no-print pointer-events-none fixed inset-x-0 bottom-0 z-[100] flex flex-col items-center gap-2 p-4 sm:items-end" aria-live="polite" aria-atomic="false">
      {list.map((t) => {
        const { icon: Icon, tone } = STYLES[t.kind];
        return (
          <div key={t.id} role={t.kind === 'error' ? 'alert' : 'status'} className="animate-pop pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-xl border border-line bg-surface p-3.5 shadow-pop">
            <Icon className={`mt-0.5 size-5 shrink-0 ${tone}`} aria-hidden="true" />
            <p className="min-w-0 flex-1 text-sm leading-snug text-ink">{t.message}</p>
            <button type="button" onClick={() => dismiss(t.id)} className="-m-1 rounded-md p-1 text-faint hover:bg-raised hover:text-ink" aria-label="Dismiss">
              <X className="size-4" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
