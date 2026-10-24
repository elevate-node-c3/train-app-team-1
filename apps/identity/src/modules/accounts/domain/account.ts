import type { EventLanguage } from '@app/contracts';

export type AccountStatus = 'pending' | 'active' | 'disabled';

export interface RegisterAccountProps {
  id: string;
  email: string;
  language?: EventLanguage;
  createdAt?: Date;
}

/**
 * The account aggregate. Plain TypeScript — no decorators, no ORM — so the
 * invariant can be tested with `new` and no container.
 */
export class Account {
  private constructor(
    readonly id: string,
    readonly email: string,
    readonly language: EventLanguage,
    readonly status: AccountStatus,
    readonly createdAt: Date,
  ) {}

  /**
   * Email is normalized on the way in. The database also has a unique index on
   * `lower(email)`, so a repository bug cannot create two accounts for one
   * mailbox.
   */
  static register(props: RegisterAccountProps): Account {
    const email = props.email.trim().toLowerCase();
    if (!email.includes('@')) {
      throw new Error('A valid email address is required');
    }
    return new Account(
      props.id,
      email,
      props.language ?? 'ar',
      'pending',
      props.createdAt ?? new Date(),
    );
  }

  isPending(): boolean {
    return this.status === 'pending';
  }
}
