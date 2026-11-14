import { Component, lazy, Suspense } from 'react';
import { Skeleton } from './ui.jsx';

const load = () => import('./CodeEditor.jsx');
const Editor = lazy(load);

/** Download the editor before it is needed: a quiz with a programming question does this at the start. */
export const preloadCodeEditor = () => { load().catch(() => {}); };

/**
 * The editor could not be downloaded: the connection dropped at that moment, or a newer version
 * of the app was installed in the meantime. Reloading the page would fix it — but in the middle
 * of a quiz a reload can cost the student the attempt, and nobody should have to choose between
 * that and not answering. The program is written in a plain text box instead.
 */
class PlainWhenUnavailable extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error) {
    console.warn('The code editor could not be loaded; a plain text box is shown instead.', error);
  }
  render() {
    if (!this.state.failed) return this.props.children;
    const { value, onChange, readOnly = false, minHeight = 280, ariaLabel = 'Code editor' } = this.props.editor;
    return (
      <div>
        <textarea
          value={value ?? ''} onChange={(e) => onChange?.(e.target.value)} readOnly={readOnly} aria-label={ariaLabel}
          spellCheck={false} autoCapitalize="off" autoCorrect="off" autoComplete="off" wrap="off" data-plain-code-editor
          className="block w-full resize-y rounded-xl border border-line bg-[#151826] p-3.5 font-mono text-[13px] leading-relaxed text-[#e6e8f2] outline-none focus:border-brand focus:ring-2 focus:ring-brand/30"
          style={{ minHeight, tabSize: 4 }}
        />
        <p className="mt-1.5 text-xs text-faint">The code editor could not be downloaded, so this is a plain text box. Your program is saved and checked all the same.</p>
      </div>
    );
  }
}

/** The code editor, downloaded the first time it is needed. Same props as CodeEditor. */
export default function LazyCodeEditor(props) {
  return (
    <PlainWhenUnavailable editor={props}>
      <Suspense fallback={<Skeleton className="w-full rounded-xl" style={{ height: props.minHeight ?? 280 }} />}>
        <Editor {...props} />
      </Suspense>
    </PlainWhenUnavailable>
  );
}
