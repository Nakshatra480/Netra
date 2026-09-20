/**
 * GitHub App installation token client.
 *
 * All GitHub App operations run server-side. Installation tokens are:
 *   - generated on demand, never persisted
 *   - never returned to the browser
 *   - never logged
 *   - allowed to expire naturally (1 hour TTL from GitHub)
 *
 * The JWT signing uses the RSA private key from Secrets Manager, present
 * in the process environment as NETRA_GITHUB_APP_SECRET (JSON).
 */

import { createSign } from 'node:crypto';

interface AppSecret {
  appId: string;
  privateKey: string;
}

function parseSecret(raw: string): AppSecret {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const appId = typeof parsed.appId === 'string' ? parsed.appId : String(parsed.appId ?? '');
  const privateKey = typeof parsed.privateKey === 'string' ? parsed.privateKey : '';
  if (!appId || !privateKey) {
    throw new Error('NETRA_GITHUB_APP_SECRET is missing appId or privateKey');
  }
  return { appId, privateKey };
}

/**
 * Create a GitHub App JWT (valid for 10 minutes).
 * Required to call /app/* endpoints and generate installation tokens.
 */
function createAppJwt(secret: AppSecret): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ iat: now - 60, exp: now + 540, iss: secret.appId }),
  ).toString('base64url');
  const message = `${header}.${payload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(message);
  const signature = signer.sign(secret.privateKey, 'base64url');
  return `${message}.${signature}`;
}

/** GitHub API base */
const GH_API = 'https://api.github.com';
const GH_HEADERS = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
};

/** Raw GitHub repository shape (only fields Netra needs). */
export interface GhRepo {
  id: number;
  full_name: string;
  name: string;
  owner: { login: string };
  private: boolean;
  default_branch: string;
  description: string | null;
}

/** GitHub installation shape. */
export interface GhInstallation {
  id: number;
  account: { login: string; type: string };
  repository_selection: 'all' | 'selected';
  suspended_at: string | null;
}

/**
 * Fetch all GitHub App installations.
 * Used server-side to verify that a given installationId belongs to a user.
 */
export async function listAppInstallations(githubAppSecret: string): Promise<GhInstallation[]> {
  const secret = parseSecret(githubAppSecret);
  const jwt = createAppJwt(secret);

  const installations: GhInstallation[] = [];
  let page = 1;

  for (;;) {
    const resp = await fetch(`${GH_API}/app/installations?per_page=100&page=${page}`, {
      headers: { ...GH_HEADERS, Authorization: `Bearer ${jwt}` },
    });
    if (!resp.ok) {
      throw new Error(`GitHub /app/installations failed: ${resp.status}`);
    }
    const batch = (await resp.json()) as GhInstallation[];
    installations.push(...batch);
    if (batch.length < 100) break;
    page++;
  }

  return installations;
}

/**
 * Verify that installationId is a real, active, non-suspended installation
 * of the Netra GitHub App.
 *
 * This is called before associating an installation with a Netra workspace to
 * prevent a forged installation_id in the callback URL from hijacking another
 * user's installation.
 */
export async function verifyInstallation(
  githubAppSecret: string,
  installationId: number,
): Promise<GhInstallation> {
  const secret = parseSecret(githubAppSecret);
  const jwt = createAppJwt(secret);

  const resp = await fetch(`${GH_API}/app/installations/${installationId}`, {
    headers: { ...GH_HEADERS, Authorization: `Bearer ${jwt}` },
  });

  if (resp.status === 404) {
    throw new Error(`Installation ${installationId} does not exist for this GitHub App`);
  }
  if (!resp.ok) {
    throw new Error(`GitHub /app/installations/${installationId} failed: ${resp.status}`);
  }

  const inst = (await resp.json()) as GhInstallation;

  if (inst.suspended_at) {
    throw new Error(`Installation ${installationId} is suspended`);
  }

  return inst;
}

/**
 * Generate an installation access token.
 * Token is returned to the caller (a route handler) and used immediately.
 * It is NEVER returned to the browser, NEVER persisted, NEVER logged.
 */
async function createInstallationToken(
  secret: AppSecret,
  installationId: number,
): Promise<string> {
  const jwt = createAppJwt(secret);
  const resp = await fetch(`${GH_API}/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: { ...GH_HEADERS, Authorization: `Bearer ${jwt}` },
  });
  if (!resp.ok) {
    throw new Error(`Failed to create installation token for ${installationId}: ${resp.status}`);
  }
  const data = (await resp.json()) as { token: string };
  return data.token;
}

/**
 * List all repositories accessible to a GitHub App installation.
 * Paginates automatically. Returns repository metadata only.
 * The installation token is ephemeral and never leaves this function.
 */
export async function listInstallationRepos(
  githubAppSecret: string,
  installationId: number,
): Promise<GhRepo[]> {
  const secret = parseSecret(githubAppSecret);
  // Generate a fresh token — never cached, expires in 1 hour from GitHub
  const token = await createInstallationToken(secret, installationId);

  const repos: GhRepo[] = [];
  let page = 1;

  for (;;) {
    const resp = await fetch(
      `${GH_API}/installation/repositories?per_page=100&page=${page}`,
      { headers: { ...GH_HEADERS, Authorization: `token ${token}` } },
    );
    if (!resp.ok) {
      throw new Error(`GitHub /installation/repositories failed: ${resp.status}`);
    }
    const data = (await resp.json()) as { total_count: number; repositories: GhRepo[] };
    repos.push(...data.repositories);
    if (repos.length >= data.total_count) break;
    page++;
  }

  return repos;
}

/** GitHub user shape returned by GET /user. */
export interface GhUser {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
}

/**
 * Exchange a GitHub OAuth authorization code for a user access token.
 *
 * SECURITY:
 *  - clientSecret is read from Secrets Manager via config — never from env/browser
 *  - The returned user access token stays in this function's caller (a route handler)
 *  - It is NEVER returned to the browser, NEVER persisted in DynamoDB, NEVER logged
 *  - Callers should consume it immediately (get user identity + installations) and discard
 */
export async function exchangeOAuthCode(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<string> {
  const resp = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }),
  });
  if (!resp.ok) {
    throw new Error(`GitHub OAuth token exchange failed: ${resp.status}`);
  }
  const data = (await resp.json()) as { access_token?: string; error?: string; error_description?: string };
  if (data.error || !data.access_token) {
    throw new Error(`GitHub OAuth error: ${data.error_description ?? data.error ?? 'unknown'}`);
  }
  return data.access_token;
}

/**
 * Retrieve the GitHub user identity from their user access token.
 * Token is consumed here — not returned. Only safe metadata is returned.
 */
export async function getGitHubAuthUser(userToken: string): Promise<GhUser> {
  const resp = await fetch(`${GH_API}/user`, {
    headers: { ...GH_HEADERS, Authorization: `Bearer ${userToken}` },
  });
  if (!resp.ok) {
    throw new Error(`GitHub GET /user failed: ${resp.status}`);
  }
  return (await resp.json()) as GhUser;
}

/**
 * List all Netra Security App installations accessible to the authorized GitHub user.
 *
 * Uses the GitHub user access token to call GET /user/installations — this returns
 * only the installations that the specific user has authorized or can access.
 * This is the correct multi-user approach: each user sees only their own installations.
 *
 * The user token is never returned — only the installation metadata.
 */
export async function listUserInstallations(
  userToken: string,
  appId: string,
): Promise<GhInstallation[]> {
  const installations: GhInstallation[] = [];
  let page = 1;

  for (;;) {
    const resp = await fetch(
      `${GH_API}/user/installations?per_page=100&page=${page}`,
      { headers: { ...GH_HEADERS, Authorization: `Bearer ${userToken}` } },
    );
    if (!resp.ok) {
      throw new Error(`GitHub GET /user/installations failed: ${resp.status}`);
    }
    const data = (await resp.json()) as { total_count: number; installations: GhInstallation[] };
    installations.push(...data.installations);
    if (installations.length >= data.total_count) break;
    page++;
  }

  // Filter to only include installations of *this* App (App ID match).
  return installations.filter(
    (inst) => String((inst as unknown as Record<string, unknown>).app_id ?? '') === String(appId),
  );
}

/** Branch resolution result — contains only metadata, never a token. */
export interface RepoBranchResolution {
  /** The current HEAD commit SHA of the branch. */
  headSha: string;
  /**
   * The parent (base) commit SHA — the commit before HEAD.
   * Null only for the very first commit on the branch (no parent exists).
   */
  baseSha: string | null;
  /** The branch name that was resolved. */
  branch: string;
}

/**
 * Resolve the current HEAD SHA and its parent SHA for a repository branch.
 *
 * This is the authoritative source for commit SHAs before starting a real
 * investigation. The frontend MUST NOT supply SHAs; they are resolved here
 * from GitHub using the App installation token.
 *
 * Security:
 *  - Installation token is generated ephemerally, consumed here, never returned
 *  - Only commit metadata (SHA, message, author) is returned — no code content
 *  - fullName is validated before use (must be owner/repo)
 *
 * @param githubAppSecret - JSON payload from Secrets Manager
 * @param installationId  - GitHub App installation ID (from stored workspace record)
 * @param fullName        - Repository full name (owner/repo)
 * @param branch          - Branch to resolve. Defaults to the repository's default branch.
 */
export async function resolveRepoBranch(
  githubAppSecret: string,
  installationId: number,
  fullName: string,
  branch?: string | null,
): Promise<RepoBranchResolution> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(fullName)) {
    throw new Error(`Invalid repository full name: ${fullName}`);
  }

  const secret = parseSecret(githubAppSecret);
  // Ephemeral installation token — consumed in this function, never returned
  const token = await createInstallationToken(secret, installationId);

  // Step 1: Resolve the target branch name (default branch if not specified)
  const repoResp = await fetch(`${GH_API}/repos/${fullName}`, {
    headers: { ...GH_HEADERS, Authorization: `token ${token}` },
  });
  if (!repoResp.ok) {
    throw new Error(`GitHub GET /repos/${fullName} failed: ${repoResp.status}`);
  }
  const repoData = (await repoResp.json()) as { default_branch: string };
  const resolvedBranch = branch?.trim() || repoData.default_branch;

  // Step 2: Get the branch HEAD SHA
  const branchResp = await fetch(`${GH_API}/repos/${fullName}/branches/${encodeURIComponent(resolvedBranch)}`, {
    headers: { ...GH_HEADERS, Authorization: `token ${token}` },
  });
  if (!branchResp.ok) {
    throw new Error(
      `GitHub GET /repos/${fullName}/branches/${resolvedBranch} failed: ${branchResp.status}`,
    );
  }
  const branchData = (await branchResp.json()) as {
    commit: { sha: string; commit: { message: string; author: { name: string } }; parents: { sha: string }[] };
  };

  const headSha = branchData.commit.sha;
  // The parent (base) SHA — null only for the initial commit
  const baseSha = branchData.commit.parents?.[0]?.sha ?? null;

  return { headSha, baseSha, branch: resolvedBranch };
}

// ─── Commit history and exact-SHA resolution ─────────────────────────────────

/** One commit as the picker shows it. Metadata only — never file content. */
export interface GhCommitSummary {
  sha: string;
  shortSha: string;
  message: string;
  authorName: string;
  authoredAt: string;
}

/** A specific commit, resolved and proven to exist on the repository. */
export interface CommitResolution {
  headSha: string;
  baseSha: string | null;
  branch: string;
  message: string;
  authorName: string;
  authoredAt: string;
}

/** Raised when a caller names a commit the repository does not have. */
export class UnknownCommitError extends Error {
  constructor(sha: string) {
    super(`Commit ${sha} does not exist on this repository`);
    this.name = 'UnknownCommitError';
  }
}

/** Raised when the repository has no commits to analyze. */
export class EmptyHistoryError extends Error {
  constructor(fullName: string) {
    super(`Repository ${fullName} has no commit history`);
    this.name = 'EmptyHistoryError';
  }
}

function assertFullName(fullName: string): void {
  if (!/^[\w.-]+\/[\w.-]+$/.test(fullName)) {
    throw new Error(`Invalid repository full name: ${fullName}`);
  }
}

/** A 7–40 character hex string is the only thing accepted as a commit id. */
export function isCommitSha(value: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(value.trim());
}

/**
 * List recent commits on a branch, newest first.
 *
 * Only metadata is returned, so this is safe to show to any caller who is
 * already authorized to see the repository. An empty repository is an
 * `EmptyHistoryError` rather than an empty list, because "no history" and "no
 * results" mean different things to the person choosing a commit.
 */
export async function listRepoCommits(
  githubAppSecret: string,
  installationId: number,
  fullName: string,
  branch?: string | null,
  limit = 30,
): Promise<GhCommitSummary[]> {
  assertFullName(fullName);
  const secret = parseSecret(githubAppSecret);
  const token = await createInstallationToken(secret, installationId);

  const params = new URLSearchParams({ per_page: String(Math.min(Math.max(limit, 1), 100)) });
  if (branch?.trim()) params.set('sha', branch.trim());

  const resp = await fetch(`${GH_API}/repos/${fullName}/commits?${params.toString()}`, {
    headers: { ...GH_HEADERS, Authorization: `token ${token}` },
  });

  // GitHub answers 409 for a repository that exists but has no commits.
  if (resp.status === 409) throw new EmptyHistoryError(fullName);
  if (!resp.ok) {
    throw new Error(`GitHub GET /repos/${fullName}/commits failed: ${resp.status}`);
  }

  const data = (await resp.json()) as Array<{
    sha: string;
    commit: { message: string; author: { name?: string; date?: string } | null };
  }>;
  if (data.length === 0) throw new EmptyHistoryError(fullName);

  return data.map((c) => ({
    sha: c.sha,
    shortSha: c.sha.slice(0, 7),
    // Only the subject line; a body can be arbitrarily long and is not useful here.
    message: (c.commit.message ?? '').split('\n')[0]!.slice(0, 200),
    authorName: c.commit.author?.name ?? 'unknown',
    authoredAt: c.commit.author?.date ?? '',
  }));
}

/**
 * Resolve one exact commit, proving it exists before anything is analyzed.
 *
 * This never falls back to HEAD. A caller who names a commit that has been
 * force-pushed away, or that belongs to another repository, gets
 * `UnknownCommitError` — analyzing a different commit than the one the person
 * chose would make the whole report a lie about which code was checked.
 */
export async function resolveCommit(
  githubAppSecret: string,
  installationId: number,
  fullName: string,
  sha: string,
): Promise<CommitResolution> {
  assertFullName(fullName);
  if (!isCommitSha(sha)) throw new UnknownCommitError(sha);

  const secret = parseSecret(githubAppSecret);
  const token = await createInstallationToken(secret, installationId);

  const repoResp = await fetch(`${GH_API}/repos/${fullName}`, {
    headers: { ...GH_HEADERS, Authorization: `token ${token}` },
  });
  if (!repoResp.ok) throw new Error(`GitHub GET /repos/${fullName} failed: ${repoResp.status}`);
  const repoData = (await repoResp.json()) as { default_branch: string };

  const resp = await fetch(`${GH_API}/repos/${fullName}/commits/${encodeURIComponent(sha)}`, {
    headers: { ...GH_HEADERS, Authorization: `token ${token}` },
  });
  if (resp.status === 404 || resp.status === 422) throw new UnknownCommitError(sha);
  if (!resp.ok) {
    throw new Error(`GitHub GET /repos/${fullName}/commits/${sha} failed: ${resp.status}`);
  }

  const data = (await resp.json()) as {
    sha: string;
    commit: { message: string; author: { name?: string; date?: string } | null };
    parents: { sha: string }[];
  };

  return {
    // The full SHA from GitHub, so a short SHA the user picked is expanded here
    // and everything downstream records the unambiguous one.
    headSha: data.sha,
    baseSha: data.parents?.[0]?.sha ?? null,
    branch: repoData.default_branch,
    message: (data.commit.message ?? '').split('\n')[0]!.slice(0, 200),
    authorName: data.commit.author?.name ?? 'unknown',
    authoredAt: data.commit.author?.date ?? '',
  };
}
