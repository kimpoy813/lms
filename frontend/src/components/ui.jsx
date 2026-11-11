// The component kit every page is built from. Keeping it in one file makes the visual language
// (spacing, radii, colours, focus behaviour) easy to keep consistent.
import clsx from 'clsx';
import { AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, Info, Loader2, Search, X, XCircle } from 'lucide-react';
import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router';
import { fileUrl } from '../lib/api.js';
import { initials } from '../lib/format.js';

export const cn = clsx;

// ── Buttons ──────────────────────────────────────────────────────────────────
const BUTTON = {
  base: 'inline-flex items-center justify-center gap-2 rounded-lg font-semibold whitespace-nowrap transition-colors select-none disabled:opacity-55 disabled:pointer-events-none',
  size: { sm: 'h-8 px-3 text-[13px]', md: 'h-10 px-4 text-sm', lg: 'h-12 px-5 text-base' },
  variant: {
    primary: 'bg-brand-fill text-white hover:bg-brand-fill-hover shadow-sm',
    secondary: 'bg-surface text-ink border border-line-strong hover:bg-raised',
    ghost: 'text-soft hover:bg-raised hover:text-ink',
    soft: 'bg-brand-soft text-brand hover:brightness-95 dark:hover:brightness-125',
    danger: 'bg-bad text-white hover:brightness-110 dark:text-[#2a0a12]',
    dangerGhost: 'text-bad hover:bg-bad-soft',
  },
};

export function Button({ variant = 'primary', size = 'md', loading = false, icon: Icon, children, className, type = 'button', disabled, to, ...props }) {
  const classes = cn(BUTTON.base, BUTTON.size[size], BUTTON.variant[variant], className);
  const content = (
    <>
      {loading ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : Icon ? <Icon className="size-4 shrink-0" aria-hidden="true" /> : null}
      {children}
    </>
  );
  if (to) return <Link to={to} className={classes} {...props}>{content}</Link>;
  return <button type={type} className={classes} disabled={disabled || loading} aria-busy={loading || undefined} {...props}>{content}</button>;
}

export function IconButton({ icon: Icon, label, className, size = 'md', variant = 'ghost', ...props }) {
  return (
    <button type="button" aria-label={label} title={label} className={cn('inline-flex shrink-0 items-center justify-center rounded-lg transition-colors disabled:opacity-50', size === 'sm' ? 'size-8' : 'size-10', BUTTON.variant[variant], className)} {...props}>
      <Icon className={size === 'sm' ? 'size-4' : 'size-5'} aria-hidden="true" />
    </button>
  );
}

// ── Form controls ────────────────────────────────────────────────────────────
const control = 'w-full rounded-lg border border-line-strong bg-surface px-3 text-sm text-ink placeholder:text-faint transition-colors focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/25 disabled:bg-raised disabled:text-faint aria-[invalid=true]:border-bad aria-[invalid=true]:ring-bad/20';

const FieldContext = createContext(null);

/** Label + control + hint/error, wired together for assistive technology. */
export function Field({ label, hint, error, required, children, className, optional }) {
  const id = useId();
  return (
    <FieldContext.Provider value={{ id, error: Boolean(error), describedBy: error ? `${id}-error` : hint ? `${id}-hint` : undefined }}>
      <div className={className}>
        {label && (
          <label htmlFor={id} className="mb-1.5 flex items-baseline gap-1.5 text-sm font-medium text-ink">
            {label}
            {required && <span className="text-bad" aria-hidden="true">*</span>}
            {optional && <span className="text-xs font-normal text-faint">optional</span>}
          </label>
        )}
        {children}
        {error ? <p id={`${id}-error`} className="mt-1.5 text-[13px] text-bad" role="alert">{error}</p> : hint ? <p id={`${id}-hint`} className="mt-1.5 text-[13px] text-faint">{hint}</p> : null}
      </div>
    </FieldContext.Provider>
  );
}

function useFieldProps(props) {
  const field = useContext(FieldContext);
  return { id: props.id ?? field?.id, 'aria-invalid': props['aria-invalid'] ?? (field?.error || undefined), 'aria-describedby': props['aria-describedby'] ?? field?.describedBy };
}

export function Input({ className, ...props }) {
  return <input className={cn(control, 'h-10', className)} {...props} {...useFieldProps(props)} />;
}
export function Textarea({ className, rows = 4, ...props }) {
  return <textarea rows={rows} className={cn(control, 'py-2.5 leading-relaxed', className)} {...props} {...useFieldProps(props)} />;
}
export function Select({ className, children, ...props }) {
  return (
    <select className={cn(control, 'h-10 appearance-none bg-[length:1rem] bg-[right_0.7rem_center] bg-no-repeat pr-9', className)} style={{ backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%237c84a0' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")" }} {...props} {...useFieldProps(props)}>
      {children}
    </select>
  );
}

export function Checkbox({ label, description, className, ...props }) {
  const id = useId();
  return (
    <div className={cn('flex items-start gap-3', className)}>
      <input id={id} type="checkbox" className="mt-0.5 size-[18px] shrink-0 rounded border-line-strong accent-[var(--brand-fill)]" {...props} />
      {(label || description) && (
        <label htmlFor={id} className="min-w-0 text-sm leading-snug">
          <span className="font-medium text-ink">{label}</span>
          {description && <span className="mt-0.5 block text-[13px] text-faint">{description}</span>}
        </label>
      )}
    </div>
  );
}

export function Switch({ checked, onChange, label, description, disabled, className }) {
  const id = useId();
  return (
    <div className={cn('flex items-start justify-between gap-4', className)}>
      {(label || description) && (
        <label htmlFor={id} className="min-w-0 text-sm leading-snug">
          <span className="font-medium text-ink">{label}</span>
          {description && <span className="mt-0.5 block text-[13px] text-faint">{description}</span>}
        </label>
      )}
      <button id={id} type="button" role="switch" aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)} className={cn('relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50', checked ? 'bg-brand-fill' : 'bg-line-strong')}>
        <span className={cn('absolute left-0.5 top-0.5 size-5 rounded-full bg-white shadow transition-transform', checked && 'translate-x-5')} />
      </button>
    </div>
  );
}

export function SearchInput({ value, onChange, placeholder = 'Search…', className, ...props }) {
  return (
    <div className={cn('relative', className)}>
      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" aria-hidden="true" />
      <input type="search" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder} className={cn(control, 'h-10 pl-9')} {...props} />
    </div>
  );
}

/** Buttons that behave like radio options (e.g. Present / Late / Absent). */
export function Segmented({ value, onChange, options, size = 'md', className, label }) {
  return (
    <div role="radiogroup" aria-label={label} className={cn('inline-flex rounded-lg border border-line bg-raised p-0.5', className)}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button key={o.value} type="button" role="radio" aria-checked={active} onClick={() => onChange(o.value)} title={o.title} className={cn('rounded-md font-medium transition-colors', size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3.5 py-1.5 text-sm', active ? cn('bg-surface shadow-sm', o.tone ?? 'text-ink') : 'text-soft hover:text-ink')}>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// ── Surfaces ─────────────────────────────────────────────────────────────────
export function Card({ className, children, as: Tag = 'div', padded = true, ...props }) {
  return <Tag className={cn('rounded-2xl border border-line bg-surface shadow-card', padded && 'p-5', className)} {...props}>{children}</Tag>;
}

export function CardHeader({ title, description, action, icon: Icon, className }) {
  return (
    <div className={cn('mb-4 flex items-start justify-between gap-3', className)}>
      <div className="flex min-w-0 items-center gap-2.5">
        {Icon && <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-brand-soft text-brand"><Icon className="size-4" aria-hidden="true" /></span>}
        <div className="min-w-0">
          <h2 className="truncate text-[15px] font-semibold text-ink">{title}</h2>
          {description && <p className="mt-0.5 text-[13px] text-faint">{description}</p>}
        </div>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

export function PageHeader({ title, description, actions, back, eyebrow }) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
      <div className="min-w-0">
        {back && (
          <Link to={back.to} className="mb-1.5 inline-flex items-center gap-1 text-[13px] font-medium text-soft hover:text-brand">
            <ChevronLeft className="size-4" aria-hidden="true" />{back.label}
          </Link>
        )}
        {eyebrow && <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-brand">{eyebrow}</p>}
        <h1 className="text-2xl font-bold tracking-tight text-ink text-balance">{title}</h1>
        {description && <p className="mt-1 max-w-2xl text-sm text-soft">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

const TONES = {
  neutral: 'bg-raised text-soft',
  brand: 'bg-brand-soft text-brand',
  ok: 'bg-ok-soft text-ok',
  warn: 'bg-warn-soft text-warn',
  bad: 'bg-bad-soft text-bad',
  info: 'bg-info-soft text-info',
};

export function Badge({ tone = 'neutral', children, className, icon: Icon, dot }) {
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold whitespace-nowrap', TONES[tone], className)}>
      {dot && <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />}
      {Icon && <Icon className="size-3" aria-hidden="true" />}
      {children}
    </span>
  );
}

export function Alert({ tone = 'info', title, children, className, action }) {
  const Icon = { info: Info, ok: CheckCircle2, warn: AlertTriangle, bad: XCircle }[tone] ?? Info;
  return (
    <div role={tone === 'bad' ? 'alert' : 'status'} className={cn('flex gap-3 rounded-xl border p-3.5 text-sm', { info: 'border-info/25 bg-info-soft', ok: 'border-ok/25 bg-ok-soft', warn: 'border-warn/30 bg-warn-soft', bad: 'border-bad/25 bg-bad-soft' }[tone], className)}>
      <Icon className={cn('mt-0.5 size-[18px] shrink-0', { info: 'text-info', ok: 'text-ok', warn: 'text-warn', bad: 'text-bad' }[tone])} aria-hidden="true" />
      <div className="min-w-0 flex-1 text-ink">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className={cn('text-soft', title && 'mt-0.5')}>{children}</div>}
      </div>
      {action}
    </div>
  );
}

export function Spinner({ className, label = 'Loading' }) {
  return <Loader2 className={cn('size-5 animate-spin text-brand', className)} role="status" aria-label={label} />;
}

export function PageLoader({ label = 'Loading…' }) {
  return (
    <div className="grid min-h-[40vh] place-items-center" role="status">
      <div className="flex items-center gap-3 text-sm text-soft"><Loader2 className="size-5 animate-spin text-brand" aria-hidden="true" />{label}</div>
    </div>
  );
}

export function Skeleton({ className }) {
  return <div className={cn('animate-pulse rounded-lg bg-raised', className)} aria-hidden="true" />;
}

export function EmptyState({ icon: Icon, title, description, action, className, compact }) {
  return (
    <div className={cn('flex flex-col items-center justify-center text-center', compact ? 'px-4 py-8' : 'px-6 py-14', className)}>
      {Icon && <span className="mb-3 grid size-12 place-items-center rounded-2xl bg-raised text-faint"><Icon className="size-6" aria-hidden="true" /></span>}
      <p className="text-[15px] font-semibold text-ink">{title}</p>
      {description && <p className="mt-1 max-w-sm text-sm text-soft">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/** What a query shows while loading, on failure, and when empty. */
export function QueryState({ query, children, empty, loader }) {
  if (query.isPending) return loader ?? <PageLoader />;
  if (query.isError) {
    return (
      <EmptyState
        icon={AlertTriangle}
        title={query.error?.status === 404 ? 'Not found' : query.error?.status === 403 ? 'You do not have access to this' : 'Could not load this'}
        description={query.error?.message}
        action={query.error?.status === 404 || query.error?.status === 403 ? null : <Button variant="secondary" onClick={() => query.refetch()}>Try again</Button>}
      />
    );
  }
  if (empty && (Array.isArray(query.data) ? query.data.length === 0 : !query.data)) return empty;
  return typeof children === 'function' ? children(query.data) : children;
}

const AVATAR_COLORS = ['bg-indigo-500', 'bg-emerald-600', 'bg-amber-600', 'bg-rose-500', 'bg-sky-600', 'bg-violet-500', 'bg-teal-600', 'bg-fuchsia-600'];
export function Avatar({ name, fileId, size = 36, className }) {
  const [broken, setBroken] = useState(false);
  const color = AVATAR_COLORS[[...String(name ?? '')].reduce((a, c) => a + c.charCodeAt(0), 0) % AVATAR_COLORS.length];
  const style = { width: size, height: size, fontSize: Math.max(11, size * 0.38) };
  if (fileId && !broken) return <img src={fileUrl(fileId)} alt="" style={style} onError={() => setBroken(true)} className={cn('shrink-0 rounded-full object-cover', className)} />;
  return <span style={style} className={cn('grid shrink-0 place-items-center rounded-full font-semibold text-white', color, className)} aria-hidden="true">{initials(name)}</span>;
}

export function ProgressBar({ value, max = 100, tone = 'brand', className, label }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div className={cn('h-2 w-full overflow-hidden rounded-full bg-raised', className)} role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
      <div className={cn('h-full rounded-full transition-[width] duration-500', { brand: 'bg-brand-fill', ok: 'bg-ok', warn: 'bg-warn', bad: 'bg-bad' }[tone])} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function StatCard({ label, value, hint, icon: Icon, tone = 'brand', to }) {
  const body = (
    <Card className={cn('h-full max-sm:p-4', to && 'transition-shadow hover:shadow-pop')}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[13px] font-medium text-soft">{label}</p>
          <p className="mt-1 text-[28px] font-bold leading-none tracking-tight text-ink tabular-nums">{value}</p>
          {hint && <p className="mt-1.5 text-xs text-faint">{hint}</p>}
        </div>
        {Icon && <span className={cn('grid size-9 shrink-0 place-items-center rounded-xl sm:size-10', TONES[tone])}><Icon className="size-[18px] sm:size-5" aria-hidden="true" /></span>}
      </div>
    </Card>
  );
  return to ? <Link to={to} className="block rounded-2xl">{body}</Link> : body;
}

// ── Overlays ─────────────────────────────────────────────────────────────────
const FOCUSABLE = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

export function Modal({ open, onClose, title, description, children, footer, size = 'md', dismissible = true }) {
  const ref = useRef(null);
  const titleId = useId();
  const lastFocus = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    lastFocus.current = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const node = ref.current;
    // Focus the first field (or the dialog itself) once it is on screen.
    const first = node?.querySelector('[data-autofocus]') ?? node?.querySelector('input:not([type=hidden]), textarea, select') ?? node;
    first?.focus({ preventScroll: true });
    const onKey = (e) => {
      if (e.key === 'Escape' && dismissible) {
        e.stopPropagation();
        onClose?.();
      }
      if (e.key === 'Tab' && node) {
        const items = [...node.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
        if (items.length === 0) return;
        const [head, tail] = [items[0], items.at(-1)];
        if (e.shiftKey && document.activeElement === head) {
          e.preventDefault();
          tail.focus();
        } else if (!e.shiftKey && document.activeElement === tail) {
          e.preventDefault();
          head.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
      lastFocus.current?.focus?.({ preventScroll: true });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4">
      <div className="animate-in absolute inset-0 bg-[#0b0d17]/55 backdrop-blur-[2px]" onClick={dismissible ? onClose : undefined} aria-hidden="true" />
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={title ? titleId : undefined} tabIndex={-1} className={cn('animate-pop relative flex max-h-[92dvh] w-full flex-col rounded-t-2xl border border-line bg-surface shadow-pop outline-none sm:rounded-2xl', { sm: 'sm:max-w-md', md: 'sm:max-w-lg', lg: 'sm:max-w-2xl', xl: 'sm:max-w-4xl', full: 'sm:max-w-6xl' }[size])}>
        {(title || dismissible) && (
          <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
            <div className="min-w-0">
              {title && <h2 id={titleId} className="text-lg font-semibold text-ink">{title}</h2>}
              {description && <p className="mt-0.5 text-sm text-soft">{description}</p>}
            </div>
            {dismissible && <IconButton icon={X} label="Close" size="sm" onClick={onClose} className="-mr-1.5 -mt-0.5" />}
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-5 py-3.5">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/** A confirmation step for destructive or irreversible actions. */
export function ConfirmDialog({ open, onClose, onConfirm, title, children, confirmLabel = 'Confirm', tone = 'danger', loading }) {
  return (
    <Modal open={open} onClose={onClose} title={title} size="sm" footer={<><Button variant="secondary" onClick={onClose} disabled={loading}>Cancel</Button><Button variant={tone === 'danger' ? 'danger' : 'primary'} onClick={onConfirm} loading={loading} data-autofocus>{confirmLabel}</Button></>}>
      <div className="text-sm leading-relaxed text-soft">{children}</div>
    </Modal>
  );
}

/** A small menu anchored to a button. */
export function Menu({ trigger, children, align = 'right', className }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => !ref.current?.contains(e.target) && setOpen(false);
    const onKey = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div ref={ref} className={cn('relative', className)}>
      {trigger({ open, toggle: () => setOpen((v) => !v), props: { 'aria-haspopup': 'menu', 'aria-expanded': open } })}
      {open && (
        <div role="menu" className={cn('animate-pop absolute z-40 mt-1.5 min-w-[12rem] rounded-xl border border-line bg-surface p-1.5 shadow-pop', align === 'right' ? 'right-0' : 'left-0')} onClick={(e) => e.target.closest('[role="menuitem"]') && setOpen(false)}>
          {children}
        </div>
      )}
    </div>
  );
}

export function MenuItem({ icon: Icon, children, tone, to, ...props }) {
  const classes = cn('flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm font-medium', tone === 'danger' ? 'text-bad hover:bg-bad-soft' : 'text-ink hover:bg-raised');
  const content = <>{Icon && <Icon className="size-4 shrink-0 opacity-70" aria-hidden="true" />}<span className="min-w-0 flex-1">{children}</span></>;
  return to ? <Link role="menuitem" to={to} className={classes} {...props}>{content}</Link> : <button type="button" role="menuitem" className={classes} {...props}>{content}</button>;
}

// ── Navigation within a page ─────────────────────────────────────────────────
export function Tabs({ tabs, value, onChange, className }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    ref.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [value]);
  return (
    <div ref={ref} role="tablist" className={cn('flex gap-1 overflow-x-auto border-b border-line [scrollbar-width:none]', className)}>
      {tabs.map((t) => {
        const active = t.value === value;
        const classes = cn('relative -mb-px flex shrink-0 items-center gap-2 border-b-2 px-3 py-2.5 text-sm font-medium transition-colors', active ? 'border-brand text-brand' : 'border-transparent text-soft hover:text-ink');
        const content = <>{t.icon && <t.icon className="size-4" aria-hidden="true" />}{t.label}{t.count ? <span className={cn('rounded-full px-1.5 text-[11px] font-bold', active ? 'bg-brand-soft' : 'bg-raised')}>{t.count}</span> : null}</>;
        return t.to
          ? <Link key={t.value} role="tab" aria-selected={active} to={t.to} className={classes}>{content}</Link>
          : <button key={t.value} type="button" role="tab" aria-selected={active} onClick={() => onChange(t.value)} className={classes}>{content}</button>;
      })}
    </div>
  );
}

export function Pagination({ meta, onPage }) {
  if (!meta || meta.totalPages <= 1) return null;
  return (
    <nav className="mt-4 flex items-center justify-between gap-3 text-sm text-soft" aria-label="Pages">
      <span>Page {meta.page} of {meta.totalPages} · {meta.total} in total</span>
      <div className="flex gap-2">
        <Button variant="secondary" size="sm" icon={ChevronLeft} disabled={meta.page <= 1} onClick={() => onPage(meta.page - 1)}>Previous</Button>
        <Button variant="secondary" size="sm" disabled={meta.page >= meta.totalPages} onClick={() => onPage(meta.page + 1)}>Next<ChevronRight className="size-4" aria-hidden="true" /></Button>
      </div>
    </nav>
  );
}

// ── Tables ───────────────────────────────────────────────────────────────────
export function Table({ children, className }) {
  return (
    <div className={cn('overflow-x-auto rounded-2xl border border-line bg-surface shadow-card', className)}>
      <table className="w-full border-collapse text-left text-sm">{children}</table>
    </div>
  );
}
export const Th = ({ children, className, ...props }) => <th scope="col" className={cn('border-b border-line bg-raised/60 px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-faint whitespace-nowrap first:rounded-tl-2xl last:rounded-tr-2xl', className)} {...props}>{children}</th>;
export const Td = ({ children, className, ...props }) => <td className={cn('border-b border-line px-4 py-3 align-middle text-ink', className)} {...props}>{children}</td>;
export const Tr = ({ children, className, ...props }) => <tr className={cn('last:[&>td]:border-b-0 hover:bg-raised/40', className)} {...props}>{children}</tr>;

/** "Label: value" rows for detail panels. */
export function DescriptionList({ items, className }) {
  return (
    <dl className={cn('grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm', className)}>
      {items.filter(Boolean).map(([term, value]) => (
        <div key={term} className="contents">
          <dt className="text-faint">{term}</dt>
          <dd className="min-w-0 font-medium text-ink">{value ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Debounce a fast-changing value (search boxes). */
export function useDebounced(value, delay = 300) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

/** Form state with server-side field errors: const f = useForm({ title: '' }); <Input {...f.bind('title')} /> */
export function useForm(initial) {
  const [values, setValues] = useState(initial);
  const [errors, setErrors] = useState({});
  const set = (name, value) => {
    setValues((v) => ({ ...v, [name]: value }));
    setErrors((e) => (e[name] ? { ...e, [name]: undefined } : e));
  };
  return {
    values,
    errors,
    set,
    setValues,
    setErrors,
    reset: (next = initial) => {
      setValues(next);
      setErrors({});
    },
    bind: (name) => ({ value: values[name] ?? '', onChange: (e) => set(name, e.target.value) }),
    /** Put the server's per-field messages next to the fields. Returns true when there were any. */
    fail: (err) => {
      if (err?.fields) {
        setErrors(err.fields);
        return true;
      }
      return false;
    },
  };
}
