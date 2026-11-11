// Server-side sanitisation of rich text. Everything a user types into a rich-text editor (lessons,
// announcements, instructions, syllabus) and all AI-generated HTML passes through here before it
// is stored, so stored HTML is safe to render for every reader.
import sanitizeHtml from 'sanitize-html';

// Only these hosts may be embedded as video iframes.
const EMBED_HOSTS = ['www.youtube-nocookie.com', 'www.youtube.com', 'player.vimeo.com'];

const RICH_TEXT_OPTIONS = {
  allowedTags: [
    'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'strong', 'b', 'em', 'i', 'u', 's', 'sub', 'sup', 'mark',
    'blockquote', 'ul', 'ol', 'li', 'a', 'img', 'pre', 'code', 'span', 'div',
    'table', 'thead', 'tbody', 'tr', 'th', 'td', 'colgroup', 'col', 'iframe',
  ],
  allowedAttributes: {
    a: ['href', 'target', 'rel'],
    img: ['src', 'alt', 'title', 'width', 'height'],
    code: ['class'],
    pre: ['class'],
    span: ['class'],
    div: ['class', 'data-youtube-video'],
    th: ['colspan', 'rowspan'],
    td: ['colspan', 'rowspan'],
    col: ['span'],
    ol: ['start'],
    iframe: ['src', 'width', 'height', 'allowfullscreen', 'frameborder', 'allow'],
  },
  allowedClasses: {
    code: [/^language-[a-z0-9+#-]+$/i],
    pre: [/^language-[a-z0-9+#-]+$/i],
    span: ['ai-generated', 'from-reference'],
    div: ['ai-generated', 'from-reference', 'tableWrapper'],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: { img: ['http', 'https'], iframe: ['https'] },
  allowedSchemesAppliedToAttributes: ['href', 'src'],
  allowProtocolRelative: false,
  allowedIframeHostnames: EMBED_HOSTS,
  allowIframeRelativeUrls: false,
  disallowedTagsMode: 'discard',
  transformTags: {
    a: (tagName, attribs) => ({
      tagName,
      attribs: { ...attribs, target: '_blank', rel: 'noopener noreferrer nofollow' },
    }),
    iframe: (tagName, attribs) => ({
      tagName,
      attribs: { src: attribs.src, width: attribs.width ?? '640', height: attribs.height ?? '360', allowfullscreen: 'true', frameborder: '0' },
    }),
  },
  exclusiveFilter: (frame) => frame.tag === 'iframe' && !frame.attribs.src,
};

/** Sanitise rich HTML for storage. */
export function sanitizeRichText(html) {
  if (typeof html !== 'string' || html.trim() === '') return '';
  return sanitizeHtml(html, RICH_TEXT_OPTIONS).trim();
}

/** Strip all markup — for titles, names and other single-line plain-text fields. */
export function plainText(value, maxLength) {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const text = sanitizeHtml(value, { allowedTags: [], allowedAttributes: {} }).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  const decoded = text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  const trimmed = decoded.trim();
  return maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

/**
 * Text that is stored exactly as typed (chat messages, code-like remarks) and is only ever
 * rendered as text by the client, never as HTML. Control characters are removed; "<" and "&"
 * are kept so that "if a<b && c" survives.
 */
export function cleanText(value, maxLength) {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').replace(/\n{4,}/g, '\n\n\n').trim();
  return maxLength ? text.slice(0, maxLength) : text;
}

/** Plain-text excerpt of rich HTML, for notifications and search results. */
export function excerpt(html, length = 160) {
  const text = sanitizeHtml(String(html ?? ''), { allowedTags: [], allowedAttributes: {} })
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > length ? `${text.slice(0, length - 1).trimEnd()}…` : text;
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
