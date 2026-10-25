import type { EventLanguage, StaffRole } from '@app/contracts';

export type AccountStatus = 'pending' | 'active' | 'disabled';

export interface RegisterAccountProps {
  id: string;
  email: string;
  language?: EventLanguage;
  createdAt?: Date;
  /** Optional only so domain tests can build an account without the hasher. */
  passwordHash?: string | null;
  passwordUpdatedAt?: Date | null;
  roles?: StaffRole[];
  bookable?: boolean;
  emailVerifiedAt?: Date | null;
}

export interface RestoreAccountProps extends RegisterAccountProps {
  status: AccountStatus;
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
    readonly passwordHash: string | null,
    readonly passwordUpdatedAt: Date | null,
    readonly emailVerifiedAt: Date | null,
    readonly bookable: boolean,
    readonly roles: StaffRole[],
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
      props.passwordHash ?? null,
      props.passwordUpdatedAt ?? null,
      props.emailVerifiedAt ?? null,
      props.bookable ?? false,
      props.roles ?? [],
    );
  }

  static restore(props: RestoreAccountProps): Account {
    return new Account(
      props.id,
      props.email,
      props.language ?? 'ar',
      props.status,
      props.createdAt ?? new Date(),
      props.passwordHash ?? null,
      props.passwordUpdatedAt ?? null,
      props.emailVerifiedAt ?? null,
      props.bookable ?? false,
      props.roles ?? [],
    );
  }

  isPending(): boolean {
    return this.status === 'pending';
  }

  isActive(): boolean {
    return this.status === 'active';
  }

  isDisabled(): boolean {
    return this.status === 'disabled';
  }

  isVerified(): boolean {
    return this.emailVerifiedAt !== null;
  }

  verifyEmail(at: Date = new Date()): Account {
    return new Account(
      this.id,
      this.email,
      this.language,
      'active',
      this.createdAt,
      this.passwordHash,
      this.passwordUpdatedAt,
      at,
      this.bookable,
      this.roles,
    );
  }

  /** A re-sign-up of an unverified address replaces credentials in place. */
  replacePendingCredentials(
    passwordHash: string,
    language: EventLanguage,
    at: Date = new Date(),
  ): Account {
    return new Account(
      this.id,
      this.email,
      language,
      this.status,
      this.createdAt,
      passwordHash,
      at,
      this.emailVerifiedAt,
      this.bookable,
      this.roles,
    );
  }

  changePassword(passwordHash: string, at: Date = new Date()): Account {
    return new Account(
      this.id,
      this.email,
      this.language,
      this.status,
      this.createdAt,
      passwordHash,
      at,
      this.emailVerifiedAt,
      this.bookable,
      this.roles,
    );
  }

  markBookable(bookable: boolean): Account {
    return new Account(
      this.id,
      this.email,
      this.language,
      this.status,
      this.createdAt,
      this.passwordHash,
      this.passwordUpdatedAt,
      this.emailVerifiedAt,
      bookable,
      this.roles,
    );
  }
}
