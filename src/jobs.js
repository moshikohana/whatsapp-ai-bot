'use strict';
/**
 * ⏳ פעולות ארוכות — כדי שהאפליקציה תראה מה קורה.
 *
 * תמלול סרטון לוקח עשרות שניות, ובינתיים המסך לא אמר כלום: לא אם זה התחיל,
 * לא כמה נשאר, ולא אם זה נגמר. כל פעולה כזו מקבלת כאן מזהה, שלב, אחוז
 * והערכת זמן, והאפליקציה שואלת עליה כל שנייה.
 */
const _jobs = new Map();

function create(kind, label, etaSec = null) {
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  _jobs.set(id, { id, kind, label, stage: 'מתחיל…', pct: 0, etaSec, started: Date.now(), done: false, error: null, result: null });
  if (_jobs.size > 100) _jobs.delete([..._jobs.keys()][0]);
  return id;
}

/** stage — מה קורה עכשיו; pct 0–100; etaSec — כמה שניות נותרו בערך. */
function update(id, { stage, pct, etaSec } = {}) {
  const j = _jobs.get(id);
  if (!j) return;
  if (stage) j.stage = stage;
  if (pct != null) j.pct = Math.max(j.pct, Math.min(99, Math.round(pct)));
  if (etaSec != null) j.etaSec = Math.max(0, Math.round(etaSec));
  j.updated = Date.now();
}

function done(id, result = 'הושלם') { const j = _jobs.get(id); if (j) Object.assign(j, { done: true, pct: 100, etaSec: 0, stage: result, result }); }
function fail(id, err) { const j = _jobs.get(id); if (j) Object.assign(j, { done: true, error: String(err || 'נכשל').substring(0, 200), stage: 'נכשל' }); }
function get(id) { return _jobs.get(id) || null; }

module.exports = { create, update, done, fail, get };
