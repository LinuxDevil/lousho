import { describe, it, expect } from 'vitest';
import { FlowBuilder } from './FlowBuilder';

describe('FlowBuilder', () => {
  describe('basic building', () => {

    it('should set custom ID', () => {
      const customId = 'custom-flow-id';
      const flow = new FlowBuilder()
        .setCode('test')
        .setName('Test')
        .setId(customId)
        .build();

      expect(flow.id).toBe(customId);
    });
  });

  describe('static methods', () => {
    it('should create from existing flow', () => {
      const existingFlow = {
        id: 'existing-id',
        code: 'existing-code',
        name: 'Existing Flow',
        description: 'Description',
        inputs: [{ name: 'test', type: 'shortText' as const, required: true }],
        flow: { type: 'step' as const, agent: 'test', input: 'test' },
        agents: [],
      };

      const flow = FlowBuilder.from(existingFlow).build();

      expect(flow.id).toBe('existing-id');
      expect(flow.code).toBe('existing-code');
      expect(flow.name).toBe('Existing Flow');
    });
  });

  describe('fluent API chaining', () => {
    it('should chain all methods', () => {
      const flow = FlowBuilder.create()
        .setCode('chained')
        .setName('Chained Flow')
        .setDescription('Testing method chaining')
        .addInput({ name: 'input1', type: 'shortText', required: true })
        .addInput({ name: 'input2', type: 'number', required: false })
        .setFlow({ type: 'step', agent: 'test', input: 'test' })
        .addAgent({ name: 'agent1', model: 'gpt-4', system: 'Test', tools: [] })
        .build();

      expect(flow.code).toBe('chained');
      expect(flow.name).toBe('Chained Flow');
      expect(flow.inputs).toHaveLength(2);
      expect(flow.agents).toHaveLength(1);
      expect(flow.flow).toBeDefined();
    });
  });
});
