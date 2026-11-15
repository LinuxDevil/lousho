import { describe, it, expect } from 'vitest';
import {
  injectVariables,
  createDynamicZodSchemaForInputs,
} from './inputs';

describe('Flow Inputs', () => {

  describe('injectVariables', () => {
    it('should inject variables into simple flow', () => {
      const flowDef = {
        agent: 'testAgent',
        input: 'Process @email',
      };

      const result = injectVariables(flowDef, { email: 'test@example.com' });

      expect(result.input).toBe('Process test@example.com');
    });

    it('should inject variables into conditions', () => {
      const flowDef = {
        agent: 'oneOfAgent',
        input: [],
        conditions: ['@value > 10', '@value < 5'],
      };

      const result = injectVariables(flowDef, { value: 'x' });

      expect(result.conditions).toEqual(['x > 10', 'x < 5']);
    });

    it('should inject variables into criteria', () => {
      const flowDef = {
        agent: 'optimizeAgent',
        criteria: 'quality of @product > 0.8',
        input: {},
      };

      const result = injectVariables(flowDef, { product: 'widget' });

      expect(result.criteria).toBe('quality of widget > 0.8');
    });

    it('should inject variables recursively', () => {
      const flowDef = {
        agent: 'sequenceAgent',
        input: [
          { agent: 'agent1', input: 'Process @item1' },
          { agent: 'agent2', input: 'Process @item2' },
        ],
      };

      const result = injectVariables(flowDef, { item1: 'A', item2: 'B' });

      expect(result.input[0].input).toBe('Process A');
      expect(result.input[1].input).toBe('Process B');
    });
  });

  describe('createDynamicZodSchemaForInputs', () => {
    it('should create schema for text inputs', () => {
      const schema = createDynamicZodSchemaForInputs({
        availableInputs: [
          { name: 'email', type: 'shortText', required: true },
          { name: 'message', type: 'longText', required: false },
        ],
      });

      const valid = schema.safeParse({ email: 'test@example.com', message: 'Hello' });
      expect(valid.success).toBe(true);
    });
  });
});
