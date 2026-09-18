import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Provisions the demo repository for an investigation.
 *
 * The demo is not a recording: it builds a real git repository with a real
 * risky commit, which the same pipeline then investigates in a real sandbox.
 * Each demo run gets its own copy so concurrent judges never collide, and the
 * copy is deleted when the investigation finishes.
 */
export interface DemoCheckout {
  readonly path: string;
  readonly baseSha: string;
  readonly headSha: string;
  cleanup(): Promise<void>;
}

export async function createDemoCheckout(builderScript: string): Promise<DemoCheckout> {
  const root = await mkdtemp(join(tmpdir(), 'netra-demo-'));
  const repoPath = join(root, 'orbital-payments');

  const { stdout } = await run(builderScript, [repoPath], { timeout: 60_000 });
  const [baseSha, headSha] = stdout.trim().split(/\s+/);
  if (!baseSha || !headSha) {
    await rm(root, { recursive: true, force: true });
    throw new Error('The demo repository builder did not report two commits');
  }

  return {
    path: repoPath,
    baseSha,
    headSha,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
