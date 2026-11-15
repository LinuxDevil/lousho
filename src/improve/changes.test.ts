import { describe, expect, it } from 'vitest';
import { changeItems } from './changes';
import type { Harness } from './types';

const BASE: Harness = { instructions: 'You answer questions.\n\nBe brief.', skills: {} };
const skill = (content: string, description = 'When citing.') => ({ description, content });

describe('changeItems', () => {

  it('itemises an added, a modified and a removed instructions line', () => {
    const base: Harness = { instructions: 'You answer questions.\nBe brief.\nUse plain words.', skills: {} };
    const after: Harness = { instructions: 'You answer questions.\nBe brief, one paragraph at most.\nStop when a document is forbidden.', skills: {} };
    expect(changeItems(base, after)).toEqual([
      { kind: 'modify', target: 'instructions', before: 'Be brief.', after: 'Be brief, one paragraph at most.' },
      { kind: 'modify', target: 'instructions', before: 'Use plain words.', after: 'Stop when a document is forbidden.' },
    ]);
    const added: Harness = { instructions: `${base.instructions}\nCite the document.`, skills: {} };
    expect(changeItems(base, added)).toEqual([{ kind: 'add', target: 'instructions', after: 'Cite the document.' }]);
    const removed: Harness = { instructions: 'You answer questions.\nUse plain words.', skills: {} };
    expect(changeItems(base, removed)).toEqual([{ kind: 'remove', target: 'instructions', before: 'Be brief.' }]);
  });

  it('keeps edits on either side of an unchanged line as separate items', () => {
    const base: Harness = { instructions: 'Start.\nKeep me.\nFinish.', skills: {} };
    const after: Harness = { instructions: 'Begin.\nKeep me.\nEnd.', skills: {} };
    expect(changeItems(base, after)).toEqual([
      { kind: 'modify', target: 'instructions', before: 'Start.', after: 'Begin.' },
      { kind: 'modify', target: 'instructions', before: 'Finish.', after: 'End.' },
    ]);
  });

  it('adds and removes whole skill files', () => {
    const base: Harness = { ...BASE, skills: { old: skill('Old way.') } };
    const after: Harness = { ...BASE, skills: { cite: skill('Quote the source.\nName the page.') } };
    expect(changeItems(base, after)).toEqual([
      { kind: 'add', target: 'skill:cite', after: 'description: When citing.\n\nQuote the source.\nName the page.' },
      { kind: 'remove', target: 'skill:old', before: 'description: When citing.\n\nOld way.' },
    ]);
  });
});

describe('reason matching', () => {
  const after: Harness = { instructions: 'You answer questions.\n\nBe brief.\nStop when a document is forbidden.', skills: {} };

  it('prefers the longest matching quote, wherever it appears', () => {
    const notes = 'reason: instructions: "Stop when": general.\nreason: instructions: "a document is forbidden": specific.';
    expect(changeItems(BASE, after, notes)[0].reason).toBe('specific.');
  });
});
