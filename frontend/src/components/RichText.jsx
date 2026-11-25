// Displays rich text written by teachers (and AI drafts). The server already sanitises what it
// stores; sanitising again in the browser means a mistake in either place is not enough for a
// script to run.
import DOMPurify from 'dompurify';
import { useMemo } from 'react';
import { cn } from './ui.jsx';

const EMBEDS = /^https:\/\/(www\.youtube-nocookie\.com|www\.youtube\.com|player\.vimeo\.com)\//;

DOMPurify.addHook('uponSanitizeElement', (node, data) => {
  if (data.tagName === 'iframe' && !EMBEDS.test(node.getAttribute?.('src') ?? '')) node.remove();
});
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer nofollow');
  }
  if (node.tagName === 'IMG') node.setAttribute('loading', 'lazy');
  if (node.tagName === 'IFRAME') {
    node.setAttribute('loading', 'lazy');
    node.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
    node.setAttribute('title', 'Embedded video');
  }
});

export const sanitizeHtml = (html) =>
  DOMPurify.sanitize(html ?? '', {
    ADD_TAGS: ['iframe'],
    ADD_ATTR: ['allowfullscreen', 'frameborder', 'target'],
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'object', 'embed'],
    FORBID_ATTR: ['style', 'id', 'name'],
  });

function makeTablesScrollable(html) {
  if (!/<table\b/i.test(html ?? '') || typeof document === 'undefined') return html;
  const template = document.createElement('template');
  template.innerHTML = html;
  for (const table of template.content.querySelectorAll('table')) {
    let wrapper = table.parentElement;
    if (!wrapper?.classList.contains('tableWrapper') && !wrapper?.classList.contains('rich-table-scroll')) {
      wrapper = document.createElement('div');
      wrapper.className = 'rich-table-scroll';
      table.before(wrapper);
      wrapper.append(table);
    } else {
      wrapper.classList.add('rich-table-scroll');
    }
    wrapper.setAttribute('role', 'region');
    wrapper.setAttribute('tabindex', '0');
    const caption = table.querySelector('caption')?.textContent?.trim();
    wrapper.setAttribute('aria-label', caption
      ? `Scrollable table: ${caption}`
      : 'Scrollable table. Scroll horizontally to view all columns.');
  }
  return template.innerHTML;
}

/** True when the HTML has no visible content ("<p></p>"). */
export const isEmptyHtml = (html) => !html || html.replace(/<(?!img|iframe)[^>]*>/gi, '').replace(/&nbsp;/g, ' ').trim() === '';

export default function RichText({ html, className, empty = null }) {
  const clean = useMemo(() => makeTablesScrollable(sanitizeHtml(html)), [html]);
  if (isEmptyHtml(clean)) return empty;
  return <div className={cn('rich', className)} dangerouslySetInnerHTML={{ __html: clean }} />;
}
