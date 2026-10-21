// Tracked fallback for a missing hooks/rules.local.ts. `import ... from './rules.local'`
// resolves to rules.local.ts when that file exists (the user's own rules) and to this
// index when it does not, so rails always loads: with the EXAMPLE rules, and loudly
// (register.ts toasts at session start and leads /rails with the warning while
// LOCAL_MISSING is true). Fix: cp hooks/rules.example.ts hooks/rules.local.ts

export { PIN_TEXT, RULES } from '../rules.example'

/** True only here: the user's hooks/rules.local.ts did not load. */
export const LOCAL_MISSING = true
