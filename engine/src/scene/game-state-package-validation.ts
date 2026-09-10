import type { VariableDefinition, VariableSchema, VariableValue } from "../variables";

/** Returns whether two variable contracts are semantically interchangeable. */
export function hasMatchingVariableDefinitions(actual: readonly VariableDefinition[], expected: readonly VariableDefinition[]): boolean {
  if (actual.length !== expected.length) return false;
  const expectedByKey = new Map(expected.map((definition) => [definition.key, definition]));
  if (expectedByKey.size !== expected.length) return false;
  for (const definition of actual) {
    const packageDefinition = expectedByKey.get(definition.key);
    if (packageDefinition === undefined || !hasMatchingDefinition(definition, packageDefinition)) return false;
  }
  return true;
}
function hasMatchingDefinition(left: VariableDefinition, right: VariableDefinition): boolean {
  return left.key === right.key && (left.readonly === true) === (right.readonly === true) && hasMatchingSchema(left.schema, right.schema) && hasMatchingValue(left.defaultValue, right.defaultValue);
}
function hasMatchingSchema(left: VariableSchema, right: VariableSchema): boolean {
  if (left.type !== right.type) return false;
  switch (left.type) {
    case "null": case "boolean": return true;
    case "number": if (right.type !== "number") return false; return left.integer === right.integer && left.min === right.min && left.max === right.max;
    case "string": if (right.type !== "string") return false; return left.minLength === right.minLength && left.maxLength === right.maxLength && hasMatchingPattern(left.pattern, right.pattern) && hasMatchingStringSet(left.enum, right.enum);
    case "array": if (right.type !== "array") return false; return left.minLength === right.minLength && left.maxLength === right.maxLength && hasMatchingSchema(left.items, right.items);
    case "object": if (right.type !== "object") return false; return hasMatchingProperties(left.properties, right.properties);
  }
}
function hasMatchingPattern(left: string | RegExp | undefined, right: string | RegExp | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  const a = typeof left === "string" ? { source: left, flags: "" } : { source: left.source, flags: left.flags };
  const b = typeof right === "string" ? { source: right, flags: "" } : { source: right.source, flags: right.flags };
  return a.source === b.source && a.flags === b.flags;
}
function hasMatchingStringSet(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.length === right.length && left.every((value) => right.includes(value)) && right.every((value) => left.includes(value));
}
function hasMatchingProperties(left: Readonly<Record<string, VariableSchema>>, right: Readonly<Record<string, VariableSchema>>): boolean {
  const keys = Object.keys(left); const rightKeys = Object.keys(right);
  return keys.length === rightKeys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && hasMatchingSchema(left[key], right[key]));
}
function hasMatchingValue(left: VariableValue, right: VariableValue): boolean {
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return left === right;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => hasMatchingValue(value, right[index]));
  const keys = Object.keys(left); const rightKeys = Object.keys(right);
  return keys.length === rightKeys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && hasMatchingValue(left[key], right[key]));
}
