// The rich-text editor used for lessons, instructions, announcements and the syllabus.
// It is loaded on demand (see LazyEditor) because the editing library is large.
import { Image } from '@tiptap/extension-image';
import { Placeholder } from '@tiptap/extension-placeholder';
import { TableKit } from '@tiptap/extension-table';
import { Youtube } from '@tiptap/extension-youtube';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import { StarterKit } from '@tiptap/starter-kit';
import {
  Bold, Code2, Heading2, Heading3, ImagePlus, Italic, Link2, List, ListOrdered, Minus, Quote, Redo2, Strikethrough, Table as TableIcon, Underline, Undo2, Unlink, Video,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api, fileUrl } from '../lib/api.js';
import { toast } from './toast.jsx';
import { Button, cn, Field, Input, Modal } from './ui.jsx';

function Tool({ icon: Icon, label, active, onClick, disabled }) {
  return (
    <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={onClick} disabled={disabled} aria-label={label} title={label} aria-pressed={active}
      className={cn('grid size-8 shrink-0 place-items-center rounded-md transition-colors disabled:opacity-40', active ? 'bg-brand-soft text-brand' : 'text-soft hover:bg-raised hover:text-ink')}>
      <Icon className="size-4" aria-hidden="true" />
    </button>
  );
}
const Divider = () => <span className="mx-1 h-5 w-px shrink-0 bg-line" aria-hidden="true" />;

export default function RichEditor({ value, onChange, placeholder = 'Write something…', minHeight = 160, allowMedia = true, autoFocus = false, ariaLabel = 'Rich text editor' }) {
  const [dialog, setDialog] = useState(null); // 'link' | 'video' | 'image'
  const fileInput = useRef(null);
  const lastEmitted = useRef(value ?? '');

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [2, 3, 4] }, link: { openOnClick: false, autolink: true, HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: '_blank' } } }),
      Placeholder.configure({ placeholder }),
      ...(allowMedia ? [Image.configure({ inline: false }), Youtube.configure({ nocookie: true, width: 640, height: 360, modestBranding: true }), TableKit.configure({ table: { resizable: false } })] : []),
    ],
    content: value ?? '',
    autofocus: autoFocus ? 'end' : false,
    editorProps: { attributes: { class: 'rich focus:outline-none', role: 'textbox', 'aria-multiline': 'true', 'aria-label': ariaLabel } },
    onUpdate: ({ editor: e }) => {
      const html = e.isEmpty ? '' : e.getHTML();
      lastEmitted.current = html;
      onChange?.(html);
    },
  });

  // Replace the content when the value changes from outside (loading another record, an AI draft).
  useEffect(() => {
    if (!editor || (value ?? '') === lastEmitted.current) return;
    lastEmitted.current = value ?? '';
    editor.commands.setContent(value ?? '', { emitUpdate: false });
  }, [value, editor]);

  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => e ? ({
      bold: e.isActive('bold'), italic: e.isActive('italic'), underline: e.isActive('underline'), strike: e.isActive('strike'),
      h2: e.isActive('heading', { level: 2 }), h3: e.isActive('heading', { level: 3 }),
      bullet: e.isActive('bulletList'), ordered: e.isActive('orderedList'), quote: e.isActive('blockquote'), code: e.isActive('codeBlock'),
      link: e.isActive('link'), table: e.isActive('table'), canUndo: e.can().undo(), canRedo: e.can().redo(),
    }) : {},
  }) ?? {};

  if (!editor) return <div className="rounded-lg border border-line-strong bg-surface" style={{ minHeight: minHeight + 44 }} />;
  const chain = () => editor.chain().focus();

  const uploadImage = async (file) => {
    if (!file) return;
    try {
      const [saved] = await api.upload([file], '/files?kind=image');
      chain().setImage({ src: fileUrl(saved.id), alt: file.name.replace(/\.[^.]+$/, '') }).run();
    } catch (err) {
      toast.error(err.message);
    }
  };

  return (
    <div className="overflow-hidden rounded-lg border border-line-strong bg-surface focus-within:border-brand focus-within:ring-2 focus-within:ring-brand/25">
      <div className="flex items-center gap-0.5 overflow-x-auto border-b border-line bg-raised/50 px-1.5 py-1" role="toolbar" aria-label="Formatting">
        <Tool icon={Bold} label="Bold (Ctrl+B)" active={state.bold} onClick={() => chain().toggleBold().run()} />
        <Tool icon={Italic} label="Italic (Ctrl+I)" active={state.italic} onClick={() => chain().toggleItalic().run()} />
        <Tool icon={Underline} label="Underline (Ctrl+U)" active={state.underline} onClick={() => chain().toggleUnderline().run()} />
        <Tool icon={Strikethrough} label="Strikethrough" active={state.strike} onClick={() => chain().toggleStrike().run()} />
        <Divider />
        <Tool icon={Heading2} label="Heading" active={state.h2} onClick={() => chain().toggleHeading({ level: 2 }).run()} />
        <Tool icon={Heading3} label="Subheading" active={state.h3} onClick={() => chain().toggleHeading({ level: 3 }).run()} />
        <Tool icon={List} label="Bulleted list" active={state.bullet} onClick={() => chain().toggleBulletList().run()} />
        <Tool icon={ListOrdered} label="Numbered list" active={state.ordered} onClick={() => chain().toggleOrderedList().run()} />
        <Tool icon={Quote} label="Quote" active={state.quote} onClick={() => chain().toggleBlockquote().run()} />
        <Tool icon={Code2} label="Code block" active={state.code} onClick={() => chain().toggleCodeBlock().run()} />
        <Tool icon={Minus} label="Divider line" onClick={() => chain().setHorizontalRule().run()} />
        <Divider />
        <Tool icon={Link2} label="Add link" active={state.link} onClick={() => setDialog('link')} />
        {state.link && <Tool icon={Unlink} label="Remove link" onClick={() => chain().unsetLink().run()} />}
        {allowMedia && (
          <>
            <Tool icon={ImagePlus} label="Insert picture" onClick={() => fileInput.current?.click()} />
            <Tool icon={Video} label="Embed a YouTube video" onClick={() => setDialog('video')} />
            <Tool icon={TableIcon} label={state.table ? 'Add a table row' : 'Insert table'} active={state.table} onClick={() => (state.table ? chain().addRowAfter().run() : chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run())} />
            <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange={(e) => { uploadImage(e.target.files?.[0]); e.target.value = ''; }} />
          </>
        )}
        <span className="ml-auto flex shrink-0">
          <Tool icon={Undo2} label="Undo (Ctrl+Z)" disabled={!state.canUndo} onClick={() => chain().undo().run()} />
          <Tool icon={Redo2} label="Redo (Ctrl+Y)" disabled={!state.canRedo} onClick={() => chain().redo().run()} />
        </span>
      </div>
      <EditorContent editor={editor} className="cursor-text px-3.5 py-3 text-[15px] [&_.ProseMirror]:outline-none" style={{ minHeight }} onClick={() => !editor.isFocused && editor.commands.focus()} />

      {dialog === 'link' && (
        <UrlDialog title="Link" label="Web address" initial={editor.getAttributes('link').href ?? ''} placeholder="https://example.com" onClose={() => setDialog(null)}
          onSubmit={(url) => (url ? chain().extendMarkRange('link').setLink({ href: /^(https?:|mailto:)/i.test(url) ? url : `https://${url}` }).run() : chain().unsetLink().run())} />
      )}
      {dialog === 'video' && (
        <UrlDialog title="Embed a video" label="YouTube link" placeholder="https://www.youtube.com/watch?v=…" onClose={() => setDialog(null)} hint="The video plays inside the lesson using YouTube’s privacy-enhanced mode."
          onSubmit={(url) => { if (url && !chain().setYoutubeVideo({ src: url }).run()) toast.error('That does not look like a YouTube link.'); }} />
      )}
    </div>
  );
}

function UrlDialog({ title, label, initial = '', placeholder, hint, onClose, onSubmit }) {
  const [url, setUrl] = useState(initial);
  return (
    <Modal open onClose={onClose} title={title} size="sm" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => { onSubmit(url.trim()); onClose(); }}>{initial ? 'Update' : 'Insert'}</Button></>}>
      <Field label={label} hint={hint}>
        <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder={placeholder} inputMode="url" autoCapitalize="none" onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onSubmit(url.trim()); onClose(); } }} />
      </Field>
    </Modal>
  );
}
