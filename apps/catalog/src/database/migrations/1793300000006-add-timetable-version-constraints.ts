import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The invariant that makes republishing a timetable safe (TA-20).
 *
 * A publish inserts a *new* timetable row -- version N+1 with its own
 * effective range -- and bounds its predecessor, so a dated trip generated
 * before the new effective date keeps pointing at the version it was generated
 * from. That only holds if two live versions of one train can never claim the
 * same civil day, and this constraint is what makes that a database fact
 * rather than a rule the publish service has to remember.
 *
 * No unique index on (train_id, version) is added here: `timetable` has
 * carried `uq_timetable_train_version UNIQUE ("train_id", "version")` since
 * 1793300000001, and a second one would just be a duplicate index.
 *
 * Three decisions worth stating:
 *
 *   * `'[]'` -- `effective_until` is the *last* day the version applies, which
 *     is why `TimetableVersionService.supersede` bounds a predecessor at the
 *     day *before* its successor takes effect. With `'[)'` that would leave a
 *     one-day hole with no live version.
 *   * a NULL upper bound still means "still live": Postgres ignores the
 *     inclusivity flag for an infinite bound, so
 *     `daterange('2026-01-01', NULL, '[]')` is `[2026-01-01,)` -- unbounded,
 *     and `&&` overlaps every later range, which is exactly the publish this
 *     has to refuse.
 *   * partial on `status = 'published'`: draft and withdrawn rows are left
 *     unconstrained on purpose. Superseded history is withdrawn, not deleted,
 *     and a train's history is allowed to overlap whatever is live.
 *
 * `EXCLUDE` needs a GiST opclass for the `=` on a uuid, which core GiST does
 * not have, so `btree_gist` is created here too. It is a trusted extension, so
 * the `catalog` role can create it in its own database without superuser.
 */
export class AddTimetableVersionConstraints1793300000006
  implements MigrationInterface
{
  name = 'AddTimetableVersionConstraints1793300000006';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('CREATE EXTENSION IF NOT EXISTS btree_gist');

    await queryRunner.query(`
      ALTER TABLE "timetable"
        ADD CONSTRAINT "excl_timetable_published_overlap"
        EXCLUDE USING gist (
          "train_id" WITH =,
          daterange("effective_from", "effective_until", '[]') WITH &&
        )
        WHERE ("status" = 'published')
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "timetable"
        DROP CONSTRAINT "excl_timetable_published_overlap"
    `);

    // Nothing else in this database uses btree_gist, and leaving an extension
    // behind that `up` created makes the migration non-reversible in practice.
    await queryRunner.query('DROP EXTENSION IF EXISTS btree_gist');
  }
}
