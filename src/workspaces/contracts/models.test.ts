import { describe, it, expect } from 'vitest';
import { resolvePageModel } from './models';

describe('resolvePageModel', () => {

  it('page provider null opts the page out of the workspace wrapper', () => {
    expect(resolvePageModel({ pageDefault: 'anthropic/p', pageProvider: null, workspaceProvider: 'pi' }).model).toBe('anthropic/p');
  });

  it('wraps every precedence level the same way', () => {
    expect(resolvePageModel({ agentDefault: 'anthropic/g', workspaceProvider: 'pi' })).toEqual({ model: 'pi/anthropic/g', source: 'agent' });
    expect(resolvePageModel({ workspaceDefault: 'anthropic/w', workspaceProvider: 'pi' })).toEqual({ model: 'pi/anthropic/w', source: 'workspace' });
  });
});
