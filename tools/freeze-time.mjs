/**
 * Preload helper for `npm run test:frozen`.
 *
 * Freezes `Date.now()` / `new Date()` so the suite runs against a fixed instant
 * instead of the machine clock:
 *
 *   FROZEN_NOW=2030-06-15T12:00:00Z npm run test:frozen
 *
 * Why this exists: two tests in this repo silently rotted for weeks. They built
 * a Steam prelaunch fixture with a hardcoded release date and then let the code
 * read the real clock, so once wall-clock time passed that date the fixture
 * flipped from "pre-release opportunity" to "already released" and the expected
 * verdict changed. Running the suite under a frozen clock catches that class of
 * bug immediately instead of months later.
 */
const FROZEN = Date.parse(process.env.FROZEN_NOW || '2030-01-01T00:00:00Z');
if (!Number.isFinite(FROZEN)) throw new Error(`FROZEN_NOW is not a valid date: ${process.env.FROZEN_NOW}`);

const RealDate = Date;
const realNow = Date.now();

class FrozenDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(FROZEN);
    else super(...args);
  }
  static now() { return FROZEN; }
}

globalThis.Date = FrozenDate;

console.log(`[freeze-time] clock frozen at ${new RealDate(FROZEN).toISOString()} (real now ${new RealDate(realNow).toISOString()})`);
