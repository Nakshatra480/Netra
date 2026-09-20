import { describe, expect, it } from 'vitest';

describe('GitHub OAuth redirect_uri resolution', () => {
  it('resolves to /index.html on S3 REST endpoint', () => {
    const origin = 'https://netra-prod-web-421946397122.s3.eu-north-1.amazonaws.com';
    const hostname = new URL(origin).hostname;
    const isS3Rest = /\.s3\.[^.]+\.amazonaws\.com$/.test(hostname);

    const redirectUri = isS3Rest
      ? `${origin}/index.html`
      : `${origin}/auth/github-callback`;

    expect(isS3Rest).toBe(true);
    expect(redirectUri).toBe('https://netra-prod-web-421946397122.s3.eu-north-1.amazonaws.com/index.html');
  });

  it('resolves to /auth/github-callback on non-S3 hosts (e.g. localhost or custom domain)', () => {
    const origin = 'http://localhost:5173';
    const hostname = new URL(origin).hostname;
    const isS3Rest = /\.s3\.[^.]+\.amazonaws\.com$/.test(hostname);

    const redirectUri = isS3Rest
      ? `${origin}/index.html`
      : `${origin}/auth/github-callback`;

    expect(isS3Rest).toBe(false);
    expect(redirectUri).toBe('http://localhost:5173/auth/github-callback');
  });
});

describe('S3 REST callback routing logic (main.tsx behavior)', () => {
  function getTargetPath(search: string, sessionStorageData: Record<string, string>): string | null {
    const sp = new URLSearchParams(search);
    const redirect = sp.get('__redirect');
    const code = sp.get('code');
    const error = sp.get('error');
    const installationId = sp.get('installation_id');

    if (redirect) {
      return decodeURIComponent(redirect);
    } else if (installationId ?? sp.get('setup_action')) {
      return `/auth/github-callback?${sp.toString()}`;
    } else if (code ?? error) {
      const isCognito = Boolean(sessionStorageData['netra.pkce.state']);
      const targetPath = isCognito ? '/auth/callback' : '/auth/github-callback';
      return `${targetPath}?${sp.toString()}`;
    }
    return null;
  }

  it('routes GitHub OAuth callback (code + state without netra.pkce.state) to /auth/github-callback', () => {
    const search = '?code=gh_code_123&state=gh_state_456';
    const sessionStorageData: Record<string, string> = {}; // No PKCE state

    const target = getTargetPath(search, sessionStorageData);
    expect(target).toBe('/auth/github-callback?code=gh_code_123&state=gh_state_456');
  });

  it('routes Cognito OAuth callback (code + state with netra.pkce.state present) to /auth/callback', () => {
    const search = '?code=cog_code_123&state=cog_state_456';
    const sessionStorageData = { 'netra.pkce.state': 'cog_state_456' };

    const target = getTargetPath(search, sessionStorageData);
    expect(target).toBe('/auth/callback?code=cog_code_123&state=cog_state_456');
  });

  it('routes GitHub App installation callback (installation_id) to /auth/github-callback', () => {
    const search = '?installation_id=987654&setup_action=install';
    const sessionStorageData: Record<string, string> = {};

    const target = getTargetPath(search, sessionStorageData);
    expect(target).toBe('/auth/github-callback?installation_id=987654&setup_action=install');
  });
});
