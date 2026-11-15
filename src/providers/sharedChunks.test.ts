/**
 * Shared-chunk test: the built entries import shared chunks, so one class or singleton
 * is one object across entries (ESM and CJS), and `instanceof SDKError` / `HookRegistry` also
 * holds across the ESM and CJS copies a mixed-format process loads (the dual-package hazard).
 *
 * Needs `dist/` (`npm run build`), like importGraph.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { SDKError, ValidationError } from '../execution/errors';
import { HookRegistry } from '../execution/hooks';
import { isPropagatingToolError, PropagatingToolError } from '../execution/propagatingToolError';
import { SubagentApprovalPause } from '../execution/subagentRuntime';
import { McpToolError } from '../tools/mcp/result';
import { WorkspaceError } from '../tools/workspace/paths';

describe('shared chunks across package entries', () => {

  it('brands answer instanceof for foreign-copy objects but not for unrelated ones', () => {
    expect(Object.create({ [Symbol.for('lousho.SDKError')]: true })).toBeInstanceOf(SDKError);
    expect(Object.create({ [Symbol.for('lousho.HookRegistry')]: true })).toBeInstanceOf(HookRegistry);
    expect(new Error('x')).not.toBeInstanceOf(SDKError);
    expect({}).not.toBeInstanceOf(HookRegistry);
    expect((null as unknown as object) instanceof SDKError).toBe(false);
    expect(Object.create({ [Symbol.for('lousho.ValidationError')]: true })).toBeInstanceOf(ValidationError);
    expect(new SDKError('x')).not.toBeInstanceOf(ValidationError);
    // A user's own subclass is not branded: the default check, so its parent's instances are not its own.
    class MyValidationError extends ValidationError {}
    expect(new ValidationError('x')).not.toBeInstanceOf(MyValidationError);
    expect(new MyValidationError('x')).toBeInstanceOf(ValidationError);
    expect(Object.create({ [Symbol.for('lousho.PropagatingToolError')]: true })).toBeInstanceOf(PropagatingToolError);
    expect(isPropagatingToolError(Object.create({ [Symbol.for('lousho.PropagatingToolError')]: true }))).toBe(true);
    expect(Object.create({ [Symbol.for('lousho.McpToolError')]: true })).toBeInstanceOf(McpToolError);
    expect(Object.create({ [Symbol.for('lousho.WorkspaceError')]: true })).toBeInstanceOf(WorkspaceError);
    expect(new Error('x')).not.toBeInstanceOf(PropagatingToolError);
    expect(new PropagatingToolError('x')).not.toBeInstanceOf(SubagentApprovalPause);
  });
});
