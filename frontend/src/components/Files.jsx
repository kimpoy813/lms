// Attachments: choosing files to upload, and listing files that can be opened or downloaded.
import { Download, File as FileIcon, FileArchive, FileImage, FileSpreadsheet, FileText, FileVideo, Paperclip, Presentation, UploadCloud, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { api, fileUrl } from '../lib/api.js';
import { formatBytes } from '../lib/format.js';
import { toast } from './toast.jsx';
import { cn, Spinner } from './ui.jsx';

const iconFor = (file) => {
  const ext = (file.extension ?? file.name?.split('.').pop() ?? '').toLowerCase().replace('.', '');
  if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) return FileImage;
  if (['pdf', 'doc', 'docx', 'txt', 'md', 'rtf', 'odt'].includes(ext)) return FileText;
  if (['xls', 'xlsx', 'csv', 'ods'].includes(ext)) return FileSpreadsheet;
  if (['ppt', 'pptx', 'odp'].includes(ext)) return Presentation;
  if (['zip'].includes(ext)) return FileArchive;
  if (['mp4', 'webm', 'mp3', 'wav', 'm4a'].includes(ext)) return FileVideo;
  return FileIcon;
};
const previewable = (file) => /^(image\/|application\/pdf|video\/|audio\/|text\/plain)/.test(file.mimeType ?? '');

/** Files that were already uploaded: open in a new tab (when the browser can show them) or download. */
export function FileList({ files, onRemove, className, compact = false }) {
  if (!files?.length) return null;
  return (
    <ul className={cn('grid gap-2', !compact && 'sm:grid-cols-2', className)}>
      {files.map((f) => {
        const Icon = iconFor(f);
        return (
          <li key={f.id} className="flex items-center gap-2.5 rounded-xl border border-line bg-surface px-3 py-2">
            <Icon className="size-5 shrink-0 text-brand" aria-hidden="true" />
            <span className="min-w-0 flex-1">
              {previewable(f)
                ? <a href={fileUrl(f.id)} target="_blank" rel="noopener noreferrer" className="block truncate text-sm font-medium text-ink hover:text-brand hover:underline">{f.name}</a>
                : <span className="block truncate text-sm font-medium text-ink">{f.name}</span>}
              <span className="block text-xs text-faint">{formatBytes(f.sizeBytes)}</span>
            </span>
            <a href={fileUrl(f.id, { inline: false })} download={f.name} className="grid size-8 shrink-0 place-items-center rounded-md text-faint hover:bg-raised hover:text-ink" aria-label={`Download ${f.name}`} title="Download"><Download className="size-4" /></a>
            {onRemove && <button type="button" onClick={() => onRemove(f)} className="grid size-8 shrink-0 place-items-center rounded-md text-faint hover:bg-bad-soft hover:text-bad" aria-label={`Remove ${f.name}`} title="Remove"><X className="size-4" /></button>}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Upload control. `value` is the list of uploaded files ([{ id, name, sizeBytes, … }]);
 * `onChange` receives the new list. Files are uploaded immediately and attached when the form is saved.
 */
export function FileUpload({ value = [], onChange, max = 10, accept, label = 'Add files', hint, compact = false, disabled = false }) {
  const input = useRef(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const room = max - value.length;

  const add = async (list) => {
    const files = [...list].slice(0, room);
    if (files.length === 0) return;
    if (list.length > room) toast.warning(`Only ${max} file${max === 1 ? '' : 's'} can be attached.`);
    setBusy(true);
    try {
      const saved = await api.upload(files);
      onChange([...value, ...saved]);
    } catch (err) {
      // Files are sent one at a time; keep the ones that were stored before the failure.
      if (err.saved?.length) onChange([...value, ...err.saved]);
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <FileList files={value} onRemove={disabled ? undefined : (f) => onChange(value.filter((x) => x.id !== f.id))} className="mb-2" compact={compact} />
      {room > 0 && !disabled && (
        <button type="button" onClick={() => input.current?.click()} disabled={busy}
          onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); add(e.dataTransfer.files); }}
          className={cn('flex w-full items-center justify-center gap-2.5 rounded-xl border border-dashed text-sm font-medium transition-colors', compact ? 'px-3 py-2.5' : 'flex-col px-4 py-6', over ? 'border-brand bg-brand-soft text-brand' : 'border-line-strong text-soft hover:border-brand hover:text-brand')}>
          {busy ? <Spinner className="size-5" label="Uploading" /> : compact ? <Paperclip className="size-4" aria-hidden="true" /> : <UploadCloud className="size-6" aria-hidden="true" />}
          <span>{busy ? 'Uploading…' : label}</span>
          {!compact && <span className="text-xs font-normal text-faint">{hint ?? 'Drop files here or click to browse · PDF, Office documents, images, ZIP'}</span>}
        </button>
      )}
      <input ref={input} type="file" hidden multiple={max > 1} accept={accept} onChange={(e) => { add(e.target.files); e.target.value = ''; }} />
    </div>
  );
}
