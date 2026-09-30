import { createHash } from 'crypto';
import type { BrainEngine } from '../engine.ts';
import type { Page } from '../types.ts';
import { readConversationBodyForParsing } from './body.ts';

export interface ConversationPageSnapshot {
  page: Page;
  body: string;
  versionToken: string;
}

export function hasRawTranscriptSidecar(page: Page): boolean {
  const raw = page.frontmatter?.raw_transcript;
  return typeof raw === 'string' && raw.trim().length > 0;
}

export function regularPageVersionToken(page: Page): string {
  const hash = page.content_hash ?? createHash('sha256').update(JSON.stringify({
    title: page.title, type: page.type, compiled_truth: page.compiled_truth,
    timeline: page.timeline || '', frontmatter: page.frontmatter || {},
  })).digest('hex');
  const effectiveDate = page.effective_date ? new Date(page.effective_date).toISOString().slice(0, 10) : 'none';
  return `page-${hash}-${effectiveDate}`;
}

function snapshotVersionToken(page: Page, body: string): string {
  if (!hasRawTranscriptSidecar(page)) return regularPageVersionToken(page);
  return `sidecar-${createHash('sha256').update(JSON.stringify({
    body, title: page.title, type: page.type, frontmatter: page.frontmatter,
    effective_date: page.effective_date ?? null,
  })).digest('hex')}`;
}

export async function preparePageSnapshot(engine: BrainEngine, page: Page): Promise<ConversationPageSnapshot> {
  const body = await readConversationBodyForParsing(engine, page);
  return { page, body, versionToken: snapshotVersionToken(page, body) };
}

export async function snapshotIsCurrent(engine: BrainEngine, sourceId: string, snapshot: ConversationPageSnapshot): Promise<boolean> {
  const current = await engine.getPage(snapshot.page.slug, { sourceId });
  return !!current && (await preparePageSnapshot(engine, current)).versionToken === snapshot.versionToken;
}
