// A code editor (CodeMirror 6) with syntax colouring for the languages the code runner supports.
// Loaded on demand through LazyCodeEditor.
import { cpp } from '@codemirror/lang-cpp';
import { java } from '@codemirror/lang-java';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { Compartment, EditorState } from '@codemirror/state';
import { oneDark } from '@codemirror/theme-one-dark';
import { EditorView, keymap } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { basicSetup } from 'codemirror';
import { useEffect, useRef } from 'react';
import { useTheme } from '../lib/theme.js';

const LANGUAGE = { PYTHON: python, JAVA: java, C: cpp, CPP: cpp, JAVASCRIPT: javascript };

const lightTheme = EditorView.theme({
  '&': { backgroundColor: 'var(--surface)', color: 'var(--ink)' },
  '.cm-gutters': { backgroundColor: 'var(--raised)', color: 'var(--faint)', border: 'none' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--brand) 6%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'color-mix(in srgb, var(--brand) 10%, transparent)' },
});
const baseTheme = EditorView.theme({
  '&': { fontSize: '13.5px', height: '100%' },
  '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace', lineHeight: '1.6' },
  '&.cm-focused': { outline: 'none' },
  '.cm-content': { padding: '10px 0' },
});

export default function CodeEditor({ value, onChange, language = 'PYTHON', readOnly = false, minHeight = 280, ariaLabel = 'Code editor' }) {
  const node = useRef(null);
  const view = useRef(null);
  const changed = useRef(onChange);
  changed.current = onChange;
  const { dark } = useTheme();
  const compartments = useRef({ language: new Compartment(), theme: new Compartment(), readOnly: new Compartment() });

  useEffect(() => {
    const c = compartments.current;
    view.current = new EditorView({
      parent: node.current,
      state: EditorState.create({
        doc: value ?? '',
        extensions: [
          basicSetup,
          keymap.of([indentWithTab]),
          baseTheme,
          c.language.of((LANGUAGE[language] ?? python)()),
          c.theme.of(dark ? oneDark : lightTheme),
          c.readOnly.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
          EditorView.contentAttributes.of({ 'aria-label': ariaLabel }),
          EditorView.updateListener.of((u) => { if (u.docChanged) changed.current?.(u.state.doc.toString()); }),
        ],
      }),
    });
    return () => view.current?.destroy();
    // The editor is created once; later changes are applied through the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { view.current?.dispatch({ effects: compartments.current.language.reconfigure((LANGUAGE[language] ?? python)()) }); }, [language]);
  useEffect(() => { view.current?.dispatch({ effects: compartments.current.theme.reconfigure(dark ? oneDark : lightTheme) }); }, [dark]);
  useEffect(() => { view.current?.dispatch({ effects: compartments.current.readOnly.reconfigure([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]) }); }, [readOnly]);
  // Replace the text when it changes from outside (starter code, another language, a past submission).
  useEffect(() => {
    const v = view.current;
    if (v && (value ?? '') !== v.state.doc.toString()) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value ?? '' } });
  }, [value]);

  return <div ref={node} className="overflow-hidden rounded-xl border border-line-strong focus-within:border-brand focus-within:ring-2 focus-within:ring-brand/25" style={{ minHeight, height: minHeight }} />;
}
