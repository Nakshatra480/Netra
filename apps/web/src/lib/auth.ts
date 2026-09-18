import {
  AuthenticationDetails,
  CognitoUser,
  CognitoUserAttribute,
  CognitoUserPool,
  type CognitoUserSession,
} from 'amazon-cognito-identity-js';

/**
 * Amazon Cognito authentication.
 *
 * The browser only ever holds tokens Cognito issued; it never constructs an
 * identity. The API derives the user from the access token's verified claims,
 * so nothing the client sends about *who it is* is trusted.
 *
 * The user pool id and client id are public configuration by design: they
 * identify the pool, and they grant nothing on their own.
 */

const USER_POOL_ID = import.meta.env.VITE_COGNITO_USER_POOL_ID ?? '';
const CLIENT_ID = import.meta.env.VITE_COGNITO_CLIENT_ID ?? '';

export const cognitoConfigured = Boolean(USER_POOL_ID && CLIENT_ID);

const pool = cognitoConfigured
  ? new CognitoUserPool({ UserPoolId: USER_POOL_ID, ClientId: CLIENT_ID })
  : null;

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

function requirePool(): CognitoUserPool {
  if (!pool) {
    throw new AuthError(
      'Sign-in is not configured on this deployment. Use the demo experience instead.',
    );
  }
  return pool;
}

export interface AuthSession {
  readonly accessToken: string;
  readonly email: string | null;
  readonly expiresAt: number;
}

function toSession(session: CognitoUserSession): AuthSession {
  const accessToken = session.getAccessToken();
  const idPayload = session.getIdToken().decodePayload();
  return {
    accessToken: accessToken.getJwtToken(),
    email: typeof idPayload.email === 'string' ? idPayload.email : null,
    expiresAt: accessToken.getExpiration() * 1000,
  };
}

export async function signUp(email: string, password: string): Promise<void> {
  const userPool = requirePool();
  await new Promise<void>((resolve, reject) => {
    userPool.signUp(
      email,
      password,
      [new CognitoUserAttribute({ Name: 'email', Value: email })],
      [],
      (error) => (error ? reject(new AuthError(describe(error))) : resolve()),
    );
  });
}

export async function confirmSignUp(email: string, code: string): Promise<void> {
  const user = new CognitoUser({ Username: email, Pool: requirePool() });
  await new Promise<void>((resolve, reject) => {
    user.confirmRegistration(code, true, (error) =>
      error ? reject(new AuthError(describe(error))) : resolve(),
    );
  });
}

export async function signIn(email: string, password: string): Promise<AuthSession> {
  const user = new CognitoUser({ Username: email, Pool: requirePool() });
  const details = new AuthenticationDetails({ Username: email, Password: password });

  return new Promise<AuthSession>((resolve, reject) => {
    user.authenticateUser(details, {
      onSuccess: (session) => resolve(toSession(session)),
      onFailure: (error) => reject(new AuthError(describe(error))),
      newPasswordRequired: () =>
        reject(
          new AuthError('This account must set a new password before it can sign in.'),
        ),
    });
  });
}

export function signOut(): void {
  pool?.getCurrentUser()?.signOut();
}

/**
 * Restore a session from the browser, refreshing it if Cognito can.
 *
 * Returns null rather than throwing when there is no usable session, because
 * "not signed in" is an ordinary state, not an error.
 */
export async function restoreSession(): Promise<AuthSession | null> {
  const user = pool?.getCurrentUser();
  if (!user) return null;

  return new Promise<AuthSession | null>((resolve) => {
    user.getSession((error: Error | null, session: CognitoUserSession | null) => {
      if (error || !session?.isValid()) {
        resolve(null);
        return;
      }
      resolve(toSession(session));
    });
  });
}

/** Cognito errors carry a usable message; anything else gets a generic one. */
function describe(error: unknown): string {
  const message = (error as { message?: string } | undefined)?.message;
  return message && message.length < 300 ? message : 'Authentication failed.';
}
