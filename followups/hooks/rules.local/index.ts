// Tracked fallback: `import ... from './rules.local'` resolves to hooks/rules.local.ts
// when it exists (the user's own rules, gitignored) and to this directory index
// when it does not, so the mod always loads. It runs the EXAMPLE rules, and
// LOCAL_MISSING makes followups say so loudly (a toast at session start and the
// first line of /followups). Fix: cp hooks/rules.example.ts hooks/rules.local.ts

export { RULES, TOOL_EXAMPLES } from '../rules.example'

/** This is the fallback: hooks/rules.local.ts was not there when the mod loaded. */
export const LOCAL_MISSING = true
