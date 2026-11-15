import { describe, it, expect, beforeEach } from 'vitest';
import { ToolRegistry } from './ToolRegistry';
import { currentDateTool, dayNameTool } from './built-in';

describe('ToolRegistry', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  it('should clear all tools', () => {
    registry.register('currentDate', currentDateTool);
    registry.register('dayName', dayNameTool);
    expect(registry.size()).toBe(2);

    registry.clear();
    expect(registry.size()).toBe(0);
    expect(registry.list()).toHaveLength(0);
  });
});
