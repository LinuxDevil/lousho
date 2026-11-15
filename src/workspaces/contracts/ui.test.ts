import { describe, expect, it } from 'vitest';
import type { Harness } from './harness';
import { pageUiSchema, UI_COMPONENTS, validateUiBindings, type PageUi, type UiBindingTarget, type UiComponent } from './ui';

const composedInstagram: UiBindingTarget = {
  inputs: {
    schema: {
      allOf: [
        {
          type: 'object',
          properties: {
            topic: { type: 'string', minLength: 3 },
            duration: { type: 'integer', minimum: 15, maximum: 90 },
            tone: { type: 'string', enum: ['playful', 'informative', 'bold'] },
          },
          required: ['topic', 'duration'],
        },
        {
          type: 'object',
          properties: {
            audience: { type: 'object', properties: { segment: { type: 'string' }, region: { type: 'string', default: 'global' } }, required: ['segment', 'region'] },
            draft: { type: 'boolean', default: false },
          },
          required: ['tone', 'audience', 'draft'],
        },
      ],
    },
  },
  outputs: {
    schema: { type: 'object', properties: { script: { type: 'string' }, caption: { type: 'string' }, hashtags: { type: 'array', items: { type: 'string' } } } },
    artifacts: [
      { name: 'video', mediaType: 'video/mp4', required: true },
      { name: 'cover', mediaType: 'image/png' },
    ],
  },
};

const instagramUi: PageUi = {
  schema: 'lousho.ui/1',
  title: 'Instagram reel',
  layout: {
    type: 'stack',
    children: [
      {
        type: 'section',
        label: 'Brief',
        children: [
          { type: 'text', bind: 'inputs.topic', label: 'Topic', placeholder: 'What is the reel about?' },
          { type: 'slider', bind: 'inputs.duration', label: 'Duration (seconds)', min: 15, max: 90, step: 5 },
          { type: 'select', bind: 'inputs.tone', label: 'Tone', options: [{ value: 'playful', label: 'Playful' }, { value: 'bold' }] },
          { type: 'text', bind: 'inputs.audience.segment', label: 'Audience' },
          { type: 'toggle', bind: 'inputs.draft', label: 'Draft only' },
        ],
      },
      { type: 'row', children: [{ type: 'runButton', label: 'Generate' }, { type: 'cancelButton' }, { type: 'runStatus' }, { type: 'progress' }] },
      {
        type: 'tabs',
        visibleWhen: "status == 'ok'",
        tabs: [
          { label: 'Script', children: [{ type: 'markdown', source: 'outputs.script' }, { type: 'text', source: 'outputs.caption' }, { type: 'table', source: 'outputs.hashtags' }] },
          { label: 'Video', children: [{ type: 'artifact', artifact: 'video' }, { type: 'artifactGallery' }] },
        ],
      },
      { type: 'card', label: 'Run', children: [{ type: 'traceLink' }, { type: 'versionList' }, { type: 'compare' }, { type: 'reviseBox' }, { type: 'json', source: 'outputs' }] },
    ],
  },
};

function issuesOf(value: unknown): { path: (string | number)[]; message: string }[] {
  const result = pageUiSchema.safeParse(value);
  if (result.success) return [];
  return result.error.issues.map((issue) => ({ path: issue.path.map((segment) => (typeof segment === 'number' ? segment : String(segment))), message: issue.message }));
}

function withLayout(layout: unknown): unknown {
  return { schema: 'lousho.ui/1', layout };
}

function inStack(...children: unknown[]): unknown {
  return withLayout({ type: 'stack', children });
}

function codes(ui: PageUi, harness: UiBindingTarget = composedInstagram): string[] {
  return validateUiBindings(ui, harness).map((problem) => problem.code);
}

function uiOf(...children: UiComponent[]): PageUi {
  return { schema: 'lousho.ui/1', layout: { type: 'stack', children: [{ type: 'schemaForm', bind: 'inputs' }, ...children] } };
}

describe('pageUiSchema', () => {
  it('the Instagram UI validates against the composed Instagram harness', () => {
    const parsed = pageUiSchema.safeParse(instagramUi);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual(instagramUi);
    expect(validateUiBindings(instagramUi, composedInstagram)).toEqual([]);
  });

  it('any on* event handler prop is rejected with R15', () => {
    for (const prop of ['onClick', 'onload', 'onMouseOver', 'on_error', 'onChange', 'ON-CLICK']) {
      expect(issuesOf(inStack({ type: 'runButton', [prop]: 'alert(1)' })), prop).toEqual([
        { path: ['layout', 'children', 0, prop], message: `ui.layout.children[0]${/^\w+$/.test(prop) ? `.${prop}` : `[${JSON.stringify(prop)}]`}: event handlers are not allowed; page UIs are declarative (R15)` },
      ]);
    }
  });

  it('obfuscated schemes, markup and links in text props are rejected', () => {
    const attacks = [
      'java\tscript:alert(1)',
      'java\nscript:',
      '&#106;avascript:alert(1)',
      '&#x6a;avascript:alert(1)',
      'javascript&colon;alert(1)',
      'ｊａｖａｓｃｒｉｐｔ:x',
      'www.evil.com',
      'visit www.evil.com',
      '\\\\evil.com\\x',
      '![x](//e.com/a.png)',
      '[x](e)',
      'http\u200B://e.com',
      '＜script＞',
      '&lt;script&gt;',
      'mailto:a@b',
    ];
    for (const text of attacks) {
      expect(issuesOf(inStack({ type: 'runButton', label: text })).map((issue) => issue.path), JSON.stringify(text)).toEqual([['layout', 'children', 0, 'label']]);
    }
    for (const text of ['Tone & voice: pick one (or two) [optional]', 'Score < threshold', 'a < b', 'Choose 1 < n < 10', 'Step A: // optional', 'Source data: image/png files']) {
      expect(issuesOf(inStack({ type: 'runButton', label: text })), text).toEqual([]);
    }
  });

  it('prototype segments in bind, source and visibleWhen are rejected', () => {
    expect(issuesOf(inStack({ type: 'text', bind: 'inputs.__proto__.x' }))[0].path).toEqual(['layout', 'children', 0, 'bind']);
    expect(issuesOf(inStack({ type: 'json', source: 'outputs.constructor' }))[0].path).toEqual(['layout', 'children', 0, 'source']);
    expect(issuesOf(inStack({ type: 'runStatus', visibleWhen: 'inputs.constructor == 1' }))[0].path).toEqual(['layout', 'children', 0, 'visibleWhen']);
  });

  it('getters and Proxies are scanned, never trusted', () => {
    const getter = { type: 'runStatus' } as Record<string, unknown>;
    Object.defineProperty(getter, 'label', { enumerable: true, get: () => 'x' });
    expect(issuesOf(inStack(getter))[0].path).toEqual(['layout', 'children', 0, 'label']);
    const hostile = new Proxy({ type: 'runStatus' }, { getOwnPropertyDescriptor: () => { throw new TypeError('no'); }, ownKeys: () => { throw new TypeError('no'); } });
    expect(issuesOf(inStack(hostile))[0].path).toEqual(['layout', 'children', 0]);
    let reads = 0;
    const flipping = new Proxy({ type: 'runButton', label: 'Go' }, { get: (target, key) => { reads += 1; return reads > 1 && key === 'label' ? '<script>x</script>' : Reflect.get(target, key); } });
    const parsed = pageUiSchema.safeParse(inStack(flipping));
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.layout).toEqual({ type: 'stack', children: [{ type: 'runButton', label: 'Go' }] });
  });

  it('visibleWhen uses the safe expression subset over inputs, outputs and status', () => {
    expect(issuesOf(inStack({ type: 'runStatus', visibleWhen: "inputs.tone == 'bold' && outputs.hashtags.length > 0 && !inputs.topic.startsWith('x')" }))).toEqual([]);
    for (const expression of ['process.exit(1)', 'globalThis', 'inputs.topic.toString()', 'eval("1")', 'x = 1', 'inputs.topic ?']) {
      expect(issuesOf(inStack({ type: 'runStatus', visibleWhen: expression })).map((issue) => issue.path), expression).toEqual([['layout', 'children', 0, 'visibleWhen']]);
    }
  });

  it('UI_COMPONENTS is the closed catalog and every type parses', () => {
    expect(UI_COMPONENTS).toEqual({
      layout: ['stack', 'row', 'tabs', 'section', 'card'],
      inputs: ['text', 'textarea', 'number', 'select', 'radio', 'toggle', 'slider', 'file', 'schemaForm'],
      actions: ['runButton', 'cancelButton', 'reviseBox'],
      outputs: ['text', 'markdown', 'json', 'table', 'artifact', 'artifactGallery'],
      status: ['runStatus', 'progress', 'traceLink'],
      revisions: ['versionList', 'compare'],
    });
    const minimal: Record<string, unknown> = {
      stack: { children: [] },
      row: { children: [] },
      section: { children: [] },
      card: { children: [] },
      tabs: { tabs: [] },
      text: { source: 'outputs.a' },
      markdown: { source: 'outputs.a' },
      json: { source: 'outputs' },
      table: { source: 'outputs.a' },
      artifact: { artifact: 'a' },
    };
    for (const type of new Set(Object.values(UI_COMPONENTS).flat())) {
      const props = (minimal[type] as object | undefined) ?? (['runButton', 'cancelButton', 'reviseBox', 'artifactGallery', 'runStatus', 'progress', 'traceLink', 'versionList', 'compare'].includes(type) ? {} : { bind: 'inputs.a' });
      expect(issuesOf(withLayout({ type, ...props })), type).toEqual([]);
    }
  });
});

describe('validateUiBindings', () => {

  it('select options outside the enum are an error', () => {
    expect(validateUiBindings(uiOf({ type: 'select', bind: 'inputs.tone', options: [{ value: 'playful' }, { value: 'sarcastic' }] }), composedInstagram)).toEqual([
      { code: 'UI003', path: ['layout', 'children', 1, 'options', 1, 'value'], message: "inputs.tone: option 'sarcastic' is not in the schema's enum" },
    ]);
    expect(codes(uiOf({ type: 'radio', bind: 'inputs.topic' }))).toEqual(['UI003']);
    expect(codes(uiOf({ type: 'radio', bind: 'inputs.tone' }))).toEqual([]);
  });

  it('a schema given as a file path must be resolved first', () => {
    const unresolved: Pick<Harness, 'inputs' | 'outputs'> = { inputs: { schema: 'schemas/in.json' }, outputs: { schema: 'schemas/out.json' } };
    expect(validateUiBindings(uiOf({ type: 'text', source: 'outputs.a' }, { type: 'text', source: 'outputs.b' }), unresolved)).toEqual([
      { code: 'UI008', path: [], message: 'inputs.schema is a file path or has a $ref; resolve it before checking UI bindings' },
      { code: 'UI008', path: [], message: 'outputs.schema is a file path or has a $ref; resolve it before checking UI bindings' },
    ]);
  });

  it('a $ref in the P0.4 allOf shape is unresolved, not missing', () => {
    const composed: UiBindingTarget = {
      inputs: { schema: { allOf: [{ $ref: 'schemas/in.json' }, { type: 'object', properties: { extra: { type: 'string' } }, required: ['extra'] }] } },
    };
    const ui: PageUi = { schema: 'lousho.ui/1', layout: { type: 'stack', children: [{ type: 'text', bind: 'inputs.topic' }, { type: 'toggle', bind: 'inputs.extra' }] } };
    expect(validateUiBindings(ui, composed)).toEqual([
      { code: 'UI008', path: [], message: 'inputs.schema is a file path or has a $ref; resolve it before checking UI bindings' },
      { code: 'UI002', path: ['layout', 'children', 1, 'bind'], message: 'inputs.extra: toggle needs a boolean field, but the schema says string' },
    ]);
    const nested: UiBindingTarget = { outputs: { schema: { type: 'object', properties: { post: { $ref: '#/$defs/post' } } } } };
    expect(codes(uiOf({ type: 'markdown', source: 'outputs.post.body' }), { inputs: { schema: { type: 'object' } }, ...nested })).toEqual(['UI008']);
  });

  it('anyOf and oneOf branches: a field in any branch exists; required only if required in all', () => {
    const harness: UiBindingTarget = {
      inputs: {
        schema: {
          type: 'object',
          oneOf: [
            { properties: { url: { type: 'string' }, kind: { const: 'link' } }, required: ['kind', 'url'] },
            { properties: { file: { type: 'object' }, kind: { const: 'upload' } }, required: ['kind', 'file'] },
          ],
        },
      },
    };
    const ui = (...children: UiComponent[]): PageUi => ({ schema: 'lousho.ui/1', layout: { type: 'stack', children } });
    expect(codes(ui({ type: 'radio', bind: 'inputs.kind', options: [{ value: 'link' }, { value: 'upload' }] }, { type: 'text', bind: 'inputs.url' }, { type: 'file', bind: 'inputs.file' }), harness)).toEqual([]);
    expect(validateUiBindings(ui({ type: 'text', bind: 'inputs.url' }), harness)).toEqual([
      { code: 'UI007', path: ['layout'], message: 'inputs.kind is required and has no default, but no input binds it' },
    ]);
    expect(codes(ui({ type: 'radio', bind: 'inputs.kind', options: [{ value: 'paste' }] }, { type: 'text', bind: 'inputs.nope' }), harness)).toEqual(['UI003', 'UI001']);
  });
});
