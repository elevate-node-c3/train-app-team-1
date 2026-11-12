/**
 * Reuse the e2e seed so Postman and e2e share trips inside today's 30-day window.
 * The fixed June fixture requires a frozen clock; this seed uses relative dates.
 * Fixed IDs and ignored conflicts make reruns safe.
 */
import {
  clearRecentSearches,
  seedSearchE2e,
} from './today-trips.js';

async function main(): Promise<void> {
  const fixture = await seedSearchE2e();

  // Clear prior searches when the run needs a fresh recent-search list.
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
