import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Config } from '../config.js';
import { hasFirebaseCredentials } from '../config.js';

/**
 * Who is making a request.
 *
 * An identity is only ever produced by verifying a token server-side. No route
 * reads a user id from a request body or header, so a client cannot claim to be
 * someone else.
 */
export interface Identity {
  readonly userId: string;
  readonly email: string | null;
  /** Demo identities may only act on their own demo workspace. */
  readonly kind: 'FIREBASE' | 'DEMO';
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

/** Verifies Firebase ID tokens using the Admin SDK. */
export class FirebaseTokenVerifier implements TokenVerifier {
  #auth: import('firebase-admin/auth').Auth | null = null;

  constructor(private readonly config: Config) {}

  async #getAuth() {
    if (this.#auth) return this.#auth;
    const { initializeApp, cert, getApps } = await import('firebase-admin/app');
    const { getAuth } = await import('firebase-admin/auth');
    const app =
      getApps()[0] ??
      initializeApp({
        credential: cert({
          projectId: this.config.firebaseProjectId!,
          clientEmail: this.config.firebaseClientEmail!,
          // Private keys are stored with escaped newlines in environment values.
          privateKey: this.config.firebasePrivateKey!.replace(/\\n/g, '\n'),
        }),
      });
    this.#auth = getAuth(app);
    return this.#auth;
  }

  async verify(token: string): Promise<Identity> {
    try {
      const auth = await this.#getAuth();
      // checkRevoked: a signed-out or disabled user must stop being able to act.
      const decoded = await auth.verifyIdToken(token, true);
      return { userId: decoded.uid, email: decoded.email ?? null, kind: 'FIREBASE' };
    } catch (error) {
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
 * Routes tokens to the verifier that can check them.
 *
 * Demo tokens carry an explicit scheme so a demo session can never be mistaken
 * for a Firebase identity, or the reverse.
 */
export class CompositeVerifier {
  constructor(
    private readonly demo: DemoSessionVerifier,
    private readonly firebase: TokenVerifier | null,
  ) {}

  static create(config: Config): CompositeVerifier {
    return new CompositeVerifier(
      new DemoSessionVerifier(config.demoSessionSecret),
      hasFirebaseCredentials(config) ? new FirebaseTokenVerifier(config) : null,
    );
  }

  get demoSessions(): DemoSessionVerifier {
    return this.demo;
  }

  get firebaseConfigured(): boolean {
    return this.firebase !== null;
  }

  async verifyAuthorizationHeader(header: string | undefined): Promise<Identity> {
    if (!header) throw new AuthError('Missing Authorization header');

    const [scheme, token] = header.split(' ');
    if (!token) throw new AuthError('Malformed Authorization header');

    if (scheme === 'Demo') return this.demo.verify(token);
    if (scheme !== 'Bearer') throw new AuthError(`Unsupported authorization scheme: ${scheme}`);
    if (!this.firebase) {
      throw new AuthError(
        'Firebase authentication is not configured on this deployment. Use the demo experience, or configure FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY.',
      );
    }
    return this.firebase.verify(token);
  }
}
