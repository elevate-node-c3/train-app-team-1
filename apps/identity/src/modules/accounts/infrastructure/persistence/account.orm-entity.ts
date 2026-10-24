import { Column, Entity, PrimaryColumn } from 'typeorm';
import type { AccountStatus } from '../../domain/account.js';
import type { EventLanguage } from '@app/contracts';

/**
 * The table shape, deliberately separate from the aggregate. The domain owns
 * behaviour; this class exists so TypeORM has something to map, and the mapper
 * is the only place that knows both.
 */
@Entity('account')
export class AccountOrmEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'text' })
  email!: string;

  @Column({ type: 'text' })
  language!: EventLanguage;

  @Column({ type: 'text' })
  status!: AccountStatus;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
