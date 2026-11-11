// Global search (Ctrl/⌘ K). Results only ever include things the signed-in user may open.
import { useQuery } from '@tanstack/react-query';
import { BookOpen, ClipboardList, CornerDownLeft, FileQuestion, FileText, FolderOpen, Layers, Megaphone, MessagesSquare, Search, UserRound, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router';
import { cn, Spinner, useDebounced } from '../components/ui.jsx';
import { api } from '../lib/api.js';

const ICONS = { class: BookOpen, module: Layers, lesson: FileText, assignment: ClipboardList, quiz: FileQuestion, announcement: Megaphone, resource: FolderOpen, discussion: MessagesSquare, person: UserRound };

export function SearchDialog({ onClose }) {
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const [active, setActive] = useState(0);
  const term = useDebounced(text.trim(), 250);
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const results = useQuery({ queryKey: ['search', term], queryFn: () => api.get('/search', { q: term }), enabled: term.length >= 2, staleTime: 30_000 });

  const flat = useMemo(() => (results.data?.groups ?? []).flatMap((g) => g.items.map((item) => ({ ...item, type: g.type }))), [results.data]);

  useEffect(() => {
    inputRef.current?.focus();
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);
  useEffect(() => setActive(0), [term]);
  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const go = (item) => {
    onClose();
    navigate(item.link);
  };
  const onKeyDown = (e) => {
    if (e.key === 'Escape') onClose();
    else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(flat.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter' && flat[active]) go(flat[active]);
  };

  let index = -1;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center p-3 pt-[10vh]" onKeyDown={onKeyDown}>
      <div className="animate-in absolute inset-0 bg-[#0b0d17]/55 backdrop-blur-[2px]" onClick={onClose} aria-hidden="true" />
      <div role="dialog" aria-modal="true" aria-label="Search" className="animate-pop relative w-full max-w-xl overflow-hidden rounded-2xl border border-line bg-surface shadow-pop">
        <div className="flex items-center gap-3 border-b border-line px-4">
          <Search className="size-5 shrink-0 text-faint" aria-hidden="true" />
          <input ref={inputRef} value={text} onChange={(e) => setText(e.target.value)} placeholder="Search classes, lessons, assignments, people…" aria-label="Search" role="combobox" aria-expanded={flat.length > 0} aria-controls="search-results" className="h-14 w-full bg-transparent text-[15px] text-ink placeholder:text-faint focus:outline-none" style={{ outline: 'none' }} />
          {results.isFetching ? <Spinner className="size-4" /> : null}
          <button type="button" onClick={onClose} className="rounded-md p-1 text-faint hover:bg-raised hover:text-ink" aria-label="Close search"><X className="size-4" /></button>
        </div>
        <div ref={listRef} id="search-results" role="listbox" className="max-h-[55vh] overflow-y-auto p-2">
          {term.length < 2 ? (
            <p className="px-3 py-8 text-center text-sm text-faint">Type at least two letters to search.</p>
          ) : results.isError ? (
            <p className="px-3 py-8 text-center text-sm text-bad">{results.error.message}</p>
          ) : results.isSuccess && flat.length === 0 ? (
            <p className="px-3 py-8 text-center text-sm text-faint">Nothing found for “{term}”.</p>
          ) : (
            (results.data?.groups ?? []).map((group) => {
              const Icon = ICONS[group.type] ?? FileText;
              return (
                <div key={group.type} className="mb-1">
                  <p className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-faint">{group.label}</p>
                  {group.items.map((item) => {
                    index += 1;
                    const i = index;
                    return (
                      <button key={`${group.type}-${item.id}`} type="button" role="option" aria-selected={i === active} data-active={i === active} onMouseEnter={() => setActive(i)} onClick={() => go(item)} className={cn('flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left', i === active ? 'bg-brand-soft' : 'hover:bg-raised')}>
                        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-raised text-soft"><Icon className="size-4" aria-hidden="true" /></span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-ink">{item.title}</span>
                          {item.subtitle && <span className="block truncate text-xs text-faint">{item.subtitle}</span>}
                        </span>
                        {i === active && <CornerDownLeft className="size-4 shrink-0 text-faint" aria-hidden="true" />}
                      </button>
                    );
                  })}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
