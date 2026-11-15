import { describe, it, expect } from 'vitest';
import { ValidationError } from '../../execution/errors';
import { composeHarness } from './compose';
import { base, instagram, layer, page, profiles } from './__fixtures__/composeLayers';

describe('composeHarness', () => {

  it('a layer not reached from the base or the page is an error', () => {
    const a = layer('workspace:a', {});
    const orphan = layer('workspace:orphan', { runtime: { limits: { maxTurns: 1 } } });
    const top = layer('page', { extends: ['workspace:a'] });
    expect(() => composeHarness([a, orphan, top])).toThrow(ValidationError);
    expect(() => composeHarness([a, orphan, top])).toThrow('layers not reached from the workspace base or the page: workspace:orphan');
    expect(() => composeHarness([layer('workspace:a', { extends: ['workspace:b'] }), layer('workspace:b', { extends: ['workspace:a'] })])).toThrow('workspace:a, workspace:b');
  });

  it('extending the workspace base or the page is an error naming the layer', () => {
    const profile = layer('workspace:p', { extends: ['workspace base'] });
    expect(() => composeHarness([base, profile, layer('page', { extends: ['workspace:p'] })])).toThrow(ValidationError);
    expect(() => composeHarness([base, profile, layer('page', { extends: ['workspace:p'] })])).toThrow("workspace:p extends 'workspace base'; only profiles can be extended");
    expect(() => composeHarness([layer('page', { extends: ['page'] })])).toThrow("page extends 'page'; only profiles can be extended");
  });

  it('applies each field rule', () => {
    const effective = composeHarness([base, ...profiles, page]);
    expect(effective.audience).toEqual({ description: 'A general audience.', traits: { tone: 'playful', persona: 'creator', level: 'beginner' } });
    expect(effective.platform).toEqual({ id: 'instagram', requirements: { aspectRatio: '4:5', captionMaxChars: 1000, hashtags: { max: 10, banned: ['#ad'] } } });
    expect(effective.provenance['platform.requirements["hashtags"]["max"]']).toEqual(['workspace:formats/educational']);
    expect(effective.provenance['audience.traits["tone"]']).toEqual(['workspace:platforms/instagram']);
    expect(effective.outputs?.schema).toEqual({ allOf: [{ type: 'object', properties: { caption: { type: 'string' } } }, { type: 'object', required: ['caption'] }] });
    expect(effective.provenance['outputs.schema']).toEqual(['workspace:platforms/instagram', 'page']);
    expect(effective.outputs?.artifacts).toEqual([{ name: 'image', mediaType: 'image/jpeg', required: true }, { name: 'caption', mediaType: 'text/plain' }]);
    expect(effective.capabilities?.require).toEqual(['image.generate', 'web.search']);
    expect(effective.runtime?.modelHints).toEqual({ temperature: 0.5, reasoning: 'medium' });
    expect(effective.evaluation?.threshold).toBe(0.7);
    expect(effective.context?.resources).toEqual(['shared/brand-palette.md', 'resources/instagram-specs.md', 'resources/glossary.md']);
  });

  it('a later deep-merge scalar clears the provenance under the object it replaces', () => {
    const flatten = layer('page', { extends: ['workspace:platforms/instagram'], platform: { id: 'instagram', requirements: { hashtags: 'none' } } });
    const effective = composeHarness([instagram, flatten]);
    expect(effective.platform?.requirements?.hashtags).toBe('none');
    expect(effective.provenance['platform.requirements["hashtags"]']).toEqual(['page']);
    expect(effective.provenance['platform.requirements["hashtags"]["max"]']).toBeUndefined();
  });
});
