import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Config } from '../config.js';
import { hasCognitoConfiguration } from '../config.js';

/**
 * Who is making a request.
 *
 * An identity is only ever produced by verifying a token server-side. No route
 * reads a user id from a request body, a header or a query parameter, so a
 * client cannot claim to be someone else.
 */
export interface Identity {
  readonly userId: string;
  readonly email: string | null;
  /** Demo identities may only act on their own demo workspace. */
  readonly kind: 'COGNITO' | 'DEMO';
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

export interface TokenVerifier {
  verify(token: string): Promise<Identity>;
}

/**
 * Verifies Amazon Cognito access tokens.
 *
 * `aws-jwt-verify` checks the signature against the user pool's JWKS, the
 * issuer, the audience/client id, the token use and the expiry. The JWKS is
 * cached in the verifier, so steady-state verification costs no network call.
 *
 * In production API Gateway also enforces a JWT authorizer in front of these
 * routes; verifying again here means the API is not dependent on a single
 * control, and keeps local development identical to deployed behaviour.
 */
export class CognitoTokenVerifier implements TokenVerifier {
  #verifier: ReturnType<typeof import('aws-jwt-verify').CognitoJwtVerifier.create> | null = null;

  constructor(private readonly config: Config) {}

  async #getVerifier() {
    if (this.#verifier) return this.#verifier;
    const { CognitoJwtVerifier } = await import('aws-jwt-verify');
    this.#verifier = CognitoJwtVerifier.create({
      userPoolId: this.config.cognitoUserPoolId!,
      clientId: this.config.cognitoClientId!,
      // Access tokens carry the scopes and are what API Gateway validates.
      tokenUse: 'access',
    });
    return this.#verifier;
  }

  async verify(token: string): Promise<Identity> {
    try {
      const verifier = await this.#getVerifier();
      const payload = await verifier.verify(token);
      const userId = String(payload.sub);
      if (!userId) throw new AuthError('The token has no subject claim');
      return {
        userId,
        email: typeof payload.email === 'string' ? payload.email : null,
        kind: 'COGNITO',
      };
    } catch (error) {
      // The reason is useful to the caller; the token itself never is, and is
      // never echoed back or logged.
      throw new AuthError(`Could not verify the identity token: ${(error as Error).message}`);
    }
  }
}

/**
 * Issues and verifies short-lived demo sessions.
 *
 * Demo mode must not become an authentication bypass, so a demo session is a
 * server-signed token bound to a server-generated workspace id. The client
 * cannot mint one, and cannot alter which workspace it refers to.
 */
export class DemoSessionVerifier implements TokenVerifier {
  readonly #secret: Buffer;
  static readonly TTL_MS = 6 * 60 * 60 * 1000;

  constructor(secret?: string) {
    this.#secret = secret ? Buffer.from(secret, 'utf8') : randomBytes(32);
  }

  issue(): { token: string; identity: Identity } {
    const userId = `demo_${randomBytes(9).toString('hex')}`;
    const expiresAt = Date.now() + DemoSessionVerifier.TTL_MS;
    const payload = `${userId}.${expiresAt}`;
    const token = `${payload}.${this.#sign(payload)}`;
    return { token, identity: { userId, email: null, kind: 'DEMO' } };
  }

  async verify(token: string): Promise<Identity> {
    const parts = token.split('.');
    if (parts.length !== 3) throw new AuthError('Malformed demo session');
    const [userId, expiresAt, signature] = parts as [string, string, string];

    const expected = this.#sign(`${userId}.${expiresAt}`);
    const provided = Buffer.from(signature, 'hex');
    const computed = Buffer.from(expected, 'hex');
    if (provided.length !== computed.length || !timingSafeEqual(provided, computed)) {
      throw new AuthError('Invalid demo session');
    }
    if (!Number.isFinite(Number(expiresAt)) || Number(expiresAt) < Date.now()) {
      throw new AuthError('Demo session has expired');
    }
    if (!userId.startsWith('demo_')) throw new AuthError('Invalid demo session');

    return { userId, email: null, kind: 'DEMO' };
  }

  #sign(payload: string): string {
    return createHmac('sha256', this.#secret).update(payload).digest('hex');
  }
}

/**
 * Routes a token to the verifier that can check it.
 *
 * Demo tokens carry an explicit scheme so a demo session can never be mistaken
 * for a real identity, or the reverse.
 */
export class CompositeVerifier {
  constructor(
    private readonly demo: DemoSessionVerifier,
    private readonly cognito: TokenVerifier | null,
  ) {}

  static create(config: Config): CompositeVerifier {
    return new CompositeVerifier(
      new DemoSessionVerifier(config.demoSessionSecret),
      hasCognitoConfiguration(config) ? new CognitoTokenVerifier(config) : null,
    );
  }

  get demoSessions(): DemoSessionVerifier {
    return this.demo;
  }

  get cognitoConfigured(): boolean {
    return this.cognito !== null;
  }

  async verifyAuthorizationHeader(header: string | undefined): Promise<Identity> {
    if (!header) throw new AuthError('Missing Authorization header');

    const [scheme, token] = header.split(' ');
    if (!token) throw new AuthError('Malformed Authorization header');

    if (scheme === 'Demo') return this.demo.verify(token);
    if (scheme !== 'Bearer') throw new AuthError(`Unsupported authorization scheme: ${scheme}`);
    if (!this.cognito) {
      throw new AuthError(
        'Cognito authentication is not configured on this deployment. Use the demo experience, or set NETRA_COGNITO_USER_POOL_ID and NETRA_COGNITO_CLIENT_ID.',
      );
    }
    return this.cognito.verify(token);
  }
}
