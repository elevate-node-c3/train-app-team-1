export const ACCESS_TOKEN_SIGNER = Symbol('ACCESS_TOKEN_SIGNER');

export interface SignedAccessToken {
  token: string;
  expiresAt: Date;
}

/**
 * The application layer's view of token minting. The private key, `jose` and
 * the claim layout stay in infrastructure; a use-case only knows that signing
 * has a cost and an expiry.
 */
export interface AccessTokenSignerPort {
  sign(input: {
    accountId: string;
    level: import('@app/contracts').AccessLevel;
    roles: import('@app/contracts').StaffRole[];
    sessionId: string;
    bookable: boolean;
    now: Date;
  }): Promise<SignedAccessToken>;

  get accessTtlSeconds(): number;
}
