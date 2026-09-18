import { randomBytes } from 'node:crypto';

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString('hex')}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Human-facing investigation reference, e.g. INV-2026-0042. */
export function investigationReference(sequence: number, at = new Date()): string {
  return `INV-${at.getUTCFullYear()}-${String(sequence).padStart(4, '0')}`;
}
