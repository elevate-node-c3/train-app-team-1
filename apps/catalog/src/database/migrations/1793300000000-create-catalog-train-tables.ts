import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateCatalogTrainTables1793300000000
  implements MigrationInterface
{
  name = 'CreateCatalogTrainTables1793300000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "train_type" (
        "id" uuid PRIMARY KEY,
        "name_en" varchar(80) NOT NULL,
        "name_ar" varchar(80) NOT NULL
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "train" (
        "id" uuid PRIMARY KEY,
        "train_number" integer NOT NULL UNIQUE,
        "train_type_id" uuid NOT NULL,
        CONSTRAINT "fk_train_train_type"
          FOREIGN KEY ("train_type_id")
          REFERENCES "train_type"("id")
          ON DELETE RESTRICT
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "travel_class" (
        "id" uuid PRIMARY KEY,
        "name_en" varchar(80) NOT NULL,
        "name_ar" varchar(80) NOT NULL
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "coach_layout" (
        "id" uuid PRIMARY KEY,
        "layout_name" varchar(80) NOT NULL UNIQUE,
        "rows" jsonb NOT NULL
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "train_coach" (
        "id" uuid PRIMARY KEY,
        "train_id" uuid NOT NULL,
        "position" integer NOT NULL CHECK ("position" > 0),
        "coach_number" integer NOT NULL CHECK ("coach_number" > 0),
        "travel_class_id" uuid NOT NULL,
        "coach_layout_id" uuid NOT NULL,

        CONSTRAINT "fk_train_coach_train"
          FOREIGN KEY ("train_id")
          REFERENCES "train"("id")
          ON DELETE CASCADE,

        CONSTRAINT "fk_train_coach_class"
          FOREIGN KEY ("travel_class_id")
          REFERENCES "travel_class"("id")
          ON DELETE RESTRICT,

        CONSTRAINT "fk_train_coach_layout"
          FOREIGN KEY ("coach_layout_id")
          REFERENCES "coach_layout"("id")
          ON DELETE RESTRICT,

        CONSTRAINT "uq_train_coach_position"
          UNIQUE ("train_id", "position"),

        CONSTRAINT "uq_train_coach_number"
          UNIQUE ("train_id", "coach_number")
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "train_coach"`);
    await queryRunner.query(`DROP TABLE "coach_layout"`);
    await queryRunner.query(`DROP TABLE "travel_class"`);
    await queryRunner.query(`DROP TABLE "train"`);
    await queryRunner.query(`DROP TABLE "train_type"`);
  }
}