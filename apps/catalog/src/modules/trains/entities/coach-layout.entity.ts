import { Column, Entity, PrimaryColumn } from 'typeorm';

export interface CoachLayoutRow {
  rowNumber: number;
  leftSeats: string[];
  rightSeats: string[];
}

@Entity('coach_layout')
export class CoachLayoutEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({
    name: 'layout_name',
    type: 'varchar',
    length: 80,
    unique: true,
  })
  layoutName!: string;

  @Column({ type: 'jsonb' })
  rows!: CoachLayoutRow[];
}