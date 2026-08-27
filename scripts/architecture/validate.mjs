/** Minimal draft-07-subset validator for the architecture metadata (required + enum + type + array items). */

/** Validate a parsed value against one of our schema objects; returns an array of error strings. */
export function validate(schema, value, path = '') {
    const errors = [];
    check(schema, value, path, errors);
    return errors;
}

/** Recursively check a value against a schema node, pushing human-readable errors. */
function check(schema, value, path, errors) {
    if (schema.type && !typeOk(schema.type, value)) {
        errors.push(`${path || '<root>'}: expected ${schema.type}, got ${jsType(value)}`);
        return;
    }
    if (schema.enum && !schema.enum.includes(value)) {
        errors.push(`${path}: '${value}' not in [${schema.enum.join(', ')}]`);
    }
    if (schema.pattern && typeof value === 'string' && !new RegExp(schema.pattern).test(value)) {
        errors.push(`${path}: '${value}' does not match /${schema.pattern}/`);
    }
    if (schema.type === 'object' && value && typeof value === 'object') {
        for (const key of schema.required ?? []) {
            if (!(key in value)) errors.push(`${path || '<root>'}: missing required '${key}'`);
        }
        if (schema.additionalProperties === false) {
            for (const key of Object.keys(value)) {
                if (!schema.properties?.[key]) errors.push(`${path || '<root>'}: unknown property '${key}'`);
            }
        }
        for (const [key, sub] of Object.entries(schema.properties ?? {})) {
            if (key in value) check(sub, value[key], path ? `${path}.${key}` : key, errors);
        }
    }
    if (schema.type === 'array' && Array.isArray(value)) {
        if (schema.minItems && value.length < schema.minItems) {
            errors.push(`${path}: needs at least ${schema.minItems} item(s)`);
        }
        if (schema.items) value.forEach((item, i) => check(schema.items, item, `${path}[${i}]`, errors));
    }
}

/** True when the runtime value matches the JSON-schema type name. */
function typeOk(type, value) {
    if (type === 'array') return Array.isArray(value);
    if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
    return typeof value === type;
}

/** Human-readable type name for error messages. */
function jsType(value) {
    if (Array.isArray(value)) return 'array';
    if (value === null) return 'null';
    return typeof value;
}
