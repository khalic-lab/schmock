import { describe, expect, it } from 'vitest';
import { generateFromSchema, schemaPlugin } from './index';

describe('generateFromSchema', () => {
  it('should generate object data from JSON schema', () => {
    const schema = {
      type: 'object' as const,
      properties: {
        id: { type: 'integer' as const },
        name: { type: 'string' as const },
        email: { type: 'string' as const, format: 'email' as const }
      }
    };

    const result = generateFromSchema({ schema });

    expect(result).toHaveProperty('id');
    expect(result).toHaveProperty('name');
    expect(result).toHaveProperty('email');
    expect(typeof result.id).toBe('number');
    expect(typeof result.name).toBe('string');
    expect(typeof result.email).toBe('string');
  });

  it('should generate array data with count', () => {
    const schema = {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          id: { type: 'integer' as const },
          name: { type: 'string' as const }
        }
      }
    };

    const result = generateFromSchema({ schema, count: 3 });

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(3);
    
    for (const item of result) {
      expect(item).toHaveProperty('id');
      expect(item).toHaveProperty('name');
      expect(typeof item.id).toBe('number');
      expect(typeof item.name).toBe('string');
    }
  });

  it('should apply smart field mapping', () => {
    const schema = {
      type: 'object' as const,
      properties: {
        firstName: { type: 'string' as const },
        email: { type: 'string' as const },
        uuid: { type: 'string' as const, format: 'uuid' as const }
      }
    };

    const result = generateFromSchema({ schema });

    expect(typeof result.firstName).toBe('string');
    expect(typeof result.email).toBe('string');
    expect(typeof result.uuid).toBe('string');
    
    // Check email format
    expect(result.email).toMatch(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);
    
    // Check UUID format
    expect(result.uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it('should apply template overrides', () => {
    const schema = {
      type: 'object' as const,
      properties: {
        id: { type: 'integer' as const },
        userId: { type: 'integer' as const }
      }
    };

    const result = generateFromSchema({
      schema,
      overrides: {
        userId: '{{ params.id }}'
      },
      params: { id: '123' }
    });

    expect(result.userId).toBe(123); // Should be converted to number
    expect(typeof result.id).toBe('number');
  });
});

describe('schemaPlugin', () => {
  it('should create a valid plugin', () => {
    const plugin = schemaPlugin();

    expect(plugin.name).toBe('schema');
    expect(plugin.version).toBe('0.1.0');
    expect(typeof plugin.generate).toBe('function');
    expect(typeof plugin.transform).toBe('function');
  });
});