import './authorPanel.css';
import { Fragment, type ReactNode } from 'react';

type Block = { type: 'text' | 'code'; text: string };

/**
 * Splits model text on ``` fences. Odd segments are fenced code; the
 * fence's optional language tag (everything to the first newline) is
 * dropped. An unclosed trailing fence - normal mid-stream - still opens a
 * code block, so partial code renders as code instead of swallowing text.
 */
function blocks(text: string): Block[] {
  const segments = text.split('```');
  const out: Block[] = [];
  for (const [i, seg] of segments.entries()) {
    if (i % 2 === 0) {
      if (seg.trim() !== '') out.push({ type: 'text', text: seg });
      continue;
    }
    const nl = seg.indexOf('\n');
    out.push({ type: 'code', text: nl === -1 ? seg : seg.slice(nl + 1) });
  }
  return out;
}

/**
 * One paragraph of plain text with `backtick` spans as <code>. Every
 * segment is a React text child - model output is never treated as HTML.
 */
function inlineCode(text: string): ReactNode[] {
  return text.split('`').map((seg, i) => {
    if (i % 2 === 1) return <code key={i}>{seg}</code>;
    return seg === '' ? null : <Fragment key={i}>{bold(seg)}</Fragment>;
  });
}

function bold(text: string): ReactNode[] {
  const parts = text.split('**');
  if (parts.length % 2 === 0) return [text];
  return parts.map((seg, i) => (i % 2 === 1 ? <strong key={i}>{seg}</strong> : seg));
}

const HEADING = /^#{1,6}\s+/;
const BULLET = /^\s*(?:[-*]|\d+[.)])\s+/;

function paragraph(text: string, key: string): JSX.Element[] {
  const out: JSX.Element[] = [];
  let lines: string[] = [];
  let items: string[] = [];
  const flush = () => {
    if (lines.length > 0) out.push(<p key={`${key}-${out.length}`}>{inlineCode(lines.join('\n'))}</p>);
    if (items.length > 0)
      out.push(
        <ul key={`${key}-${out.length}`}>
          {items.map((item, n) => (
            <li key={n}>{inlineCode(item)}</li>
          ))}
        </ul>
      );
    lines = [];
    items = [];
  };
  for (const line of text.split('\n')) {
    if (HEADING.test(line)) {
      flush();
      out.push(
        <p key={`${key}-${out.length}`} className="author-heading">
          <strong>{inlineCode(line.replace(HEADING, ''))}</strong>
        </p>
      );
    } else if (BULLET.test(line)) {
      if (lines.length > 0) flush();
      items.push(line.replace(BULLET, ''));
    } else if (items.length > 0 && /^\s+\S/.test(line)) {
      items[items.length - 1] += ` ${line.trim()}`;
    } else {
      if (items.length > 0) flush();
      lines.push(line);
    }
  }
  flush();
  return out;
}

/**
 * Renders assistant text as plain markup: paragraphs on blank lines,
 * `#` headings, `-`/`1.` lists, fenced blocks as `pre.author-code`,
 * `inline code` as `code`. Deliberately not full markdown - no HTML
 * injection path, no new dependency. Single
 * newlines inside a paragraph render via `white-space: pre-wrap`.
 */
export function AuthorText({ text }: { text: string }): JSX.Element {
  return (
    <div className="author-text">
      {blocks(text).map((block, i) =>
        block.type === 'code' ? (
          <pre key={i} className="author-code">
            <code>{block.text}</code>
          </pre>
        ) : (
          block.text
            .split(/\n\s*\n/)
            .filter((p) => p.trim() !== '')
            .flatMap((p, j) => paragraph(p, `${i}-${j}`))
        )
      )}
    </div>
  );
}
