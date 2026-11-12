import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateStationCatalog1793292475941 implements MigrationInterface {
    name = 'CreateStationCatalog1793292475941'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "station" ("id" uuid NOT NULL, "city_id" uuid NOT NULL, "name_ar" text NOT NULL, "name_en" text NOT NULL, "alt_spellings" text array NOT NULL DEFAULT ARRAY[]::text[], "is_active" boolean NOT NULL DEFAULT true, CONSTRAINT "station_name_en_not_empty" CHECK (name_en <> ''), CONSTRAINT "station_name_ar_not_empty" CHECK (name_ar <> ''), CONSTRAINT "PK_cad1b3e7182ef8df1057b82f6aa" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_station_city" ON "station"  ("city_id") `);
        await queryRunner.query(`CREATE TABLE "city" ("id" uuid NOT NULL, "governorate_id" uuid NOT NULL, "name_ar" text NOT NULL, "name_en" text NOT NULL, CONSTRAINT "city_name_en_not_empty" CHECK (name_en <> ''), CONSTRAINT "city_name_ar_not_empty" CHECK (name_ar <> ''), CONSTRAINT "PK_b222f51ce26f7e5ca86944a6739" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_city_governorate" ON "city"  ("governorate_id") `);
        await queryRunner.query(`CREATE TABLE "governorate" ("id" uuid NOT NULL, "name_ar" text NOT NULL, "name_en" text NOT NULL, "sort_order" integer NOT NULL, CONSTRAINT "UQ_bae6bb8a913923f1548a36acbe7" UNIQUE ("sort_order"), CONSTRAINT "governorate_name_en_not_empty" CHECK (name_en <> ''), CONSTRAINT "governorate_name_ar_not_empty" CHECK (name_ar <> ''), CONSTRAINT "PK_852f1fafdf2b5facb11aedbdf4b" PRIMARY KEY ("id"))`);
        await queryRunner.query(`ALTER TABLE "station" ADD CONSTRAINT "FK_ab6075a2cfc2dfc4444cff67275" FOREIGN KEY ("city_id") REFERENCES "city"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "city" ADD CONSTRAINT "FK_10ff4cb35955d1bed60b59aa341" FOREIGN KEY ("governorate_id") REFERENCES "governorate"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "city" DROP CONSTRAINT "FK_10ff4cb35955d1bed60b59aa341"`);
        await queryRunner.query(`ALTER TABLE "station" DROP CONSTRAINT "FK_ab6075a2cfc2dfc4444cff67275"`);
        await queryRunner.query(`DROP TABLE "governorate"`);
        await queryRunner.query(`DROP INDEX "public"."idx_city_governorate"`);
        await queryRunner.query(`DROP TABLE "city"`);
        await queryRunner.query(`DROP INDEX "public"."idx_station_city"`);
        await queryRunner.query(`DROP TABLE "station"`);
    }

}
