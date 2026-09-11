import { setDegraded, withWriteBudget } from "./store.mjs";

// A denial has already been decided. Queue/activity records must neither undo
// it nor spend the hook deadline waiting for an optional writer transaction.
export function observeGuardDenial(db, fn) {
  try { return withWriteBudget(db, 50, fn); }
  catch (error) { setDegraded(error); }
}
