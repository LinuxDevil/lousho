import { describe, it, expect } from 'vitest';
import { skillRefSchema } from './skills';

describe('skillRefSchema', () => {
  it('parses each of the three ref forms', () => {
    expect(skillRefSchema.safeParse({ dir: 'skills' }).success).toBe(true);
    expect(skillRefSchema.safeParse({ registry: 'changelog' }).success).toBe(true);
    const inline = { inline: { name: 'tone', description: 'House tone', content: 'Write plainly.' } };
    expect(skillRefSchema.safeParse(inline)).toMatchObject({ success: true, data: inline });
  });
});
