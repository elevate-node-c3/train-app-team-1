/**
 * Contract between identity (caller) and session management (Member 2, owner).
 * Identity calls createSession only after credentials are verified and the
 * account is verified; it never persists tokens itself.
 */

/** DI token for the SessionService implementation. */
export const SESSION_SERVICE = Symbol('SESSION_SERVICE');

/** What identity knows about the client signing in, as forwarded by the gateway. */
export interface DeviceContext {
  deviceId?: string;
  userAgent?: string;
  ipAddress?: string;
}

export interface CreatedSession {
  sessionId: string;
  accessToken: string;
  /** ISO-8601 UTC. */
  accessTokenExpiresAt: string;
  refreshToken: string;
  /** ISO-8601 UTC. */
  refreshTokenExpiresAt: string;
}

export interface SessionService {
  /**
   * Creates a session for a verified account.
   * @returns the session id with its access and refresh tokens
   */
  createSession(
    accountId: string,
    deviceContext: DeviceContext,
  ): Promise<CreatedSession>;
}
