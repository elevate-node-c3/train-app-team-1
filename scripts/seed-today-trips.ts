/**
 * Seeds catalog with trips a traveller can actually search for today.
 *
 * `catalog:seed:search` loads the shared fixture verbatim, and that fixture
 * dates its trips in June 2026 -- which the integration specs can search
 * because they pass a frozen `now`, and which nothing else can: the real
 * booking window is thirty days from today, so those trips are either in the
 * past or beyond the window on every other day of the year. The Postman
 * collection has needed this since TA-17 and the README claimed it was
 * happening; it was not.
 *
 * This runs the e2e tier's seed, which places the same network's trips relative
 * to today: the main line, a second train type on Tanta -> Ramsis for the
 * filters, and the reverse route for a round trip. Reused rather than copied --
 * two seeds claiming to produce "today's trips" would drift, and then a Postman
 * run and an e2e run would be testing different data.
 *
 * Idempotent, like the fixture seed: every row is keyed by a fixed uuid and
 * conflicts are ignored. Run it again after `compose down -v`.
 */
import {
  clearRecentSearches,
  seedSearchE2e,
} from '../test/e2e/support/seed-search-e2e.js';

async function main(): Promise<void> {
  const fixture = await seedSearchE2e();

  // A fresh run should start from an empty list, or "the last five" is five of
  // somebody else's searches.
  if (process.argv.includes('--clear-recent')) {
    await clearRecentSearches();
  }

  const lines = [
    'Seeded catalog with trips relative to today.',
    '',
    'Postman variables to set (or leave blank and let the folder fill them):',
    `  searchDepartureDate  ${fixture.searchDate}`,
    `  searchReturnDate     ${fixture.returnDate}`,
    `  searchToday          ${fixture.today}`,
    '',
    'The pairs these dates have trips on:',
    `  one way / round trip  Alexandria -> Ramsis  (${fixture.stations.alexandria} -> ${fixture.stations.ramsis})`,
    `  filters and sorting   Tanta -> Ramsis       (${fixture.stations.tanta} -> ${fixture.stations.ramsis})`,
    `  the return leg        Ramsis -> Alexandria  on ${fixture.returnDate}`,
    '',
    `  travelClassId         ${fixture.travelClasses.first}`,
    `  sleeper train type    ${fixture.trainTypes.sleeper}`,
  ];

  process.stdout.write(`${lines.join('\n')}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Failed to seed today's trips: ${
      error instanceof Error ? error.message : String(error)
    }\n`,
  );
  process.exitCode = 1;
});
