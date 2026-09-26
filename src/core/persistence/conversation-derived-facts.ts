import type { BrainEngine, NewFact } from '../engine.ts';
import type { Page } from '../types.ts';
import { withDerivedFactsWrite } from './derived-facts.ts';

export type ManagedConversationFactRow = NewFact & { row_num: number; source_markdown_slug: string };

export function managedConversationTerminalFact(slug: string, token: string, rowNum: number): ManagedConversationFactRow {
  return { fact: 'EXTRACTION_COMPLETE', kind: 'fact', entity_slug: null, source: 'cli:extract-conversation-facts:terminal:v2',
    source_session: `cli:extract-conversation-facts:terminal:v2:${slug}:${token}`, confidence: 1, notability: 'low',
    row_num: rowNum, source_markdown_slug: slug };
}

export function managedConversationNonExtractableFact(slug: string, token: string, rowNum: number, reason: string): ManagedConversationFactRow {
  return { fact: 'EXTRACTION_NOT_APPLICABLE', kind: 'fact', entity_slug: null, source: 'cli:extract-conversation-facts:non-extractable:v2',
    source_session: `cli:extract-conversation-facts:non-extractable:v2:${slug}:${token}`, confidence: 1, notability: 'low',
    context: `scanned, not extractable: ${reason}`, row_num: rowNum, source_markdown_slug: slug };
}

export async function replaceManagedConversationFactRows(engine: BrainEngine, input: {
  sourceId: string;
  slug: string;
  pageId: number;
  revision?: string;
  token: string;
  rows: ManagedConversationFactRow[];
  currentToken: (tx: BrainEngine, page: Page) => Promise<string>;
}): Promise<{ deleted: number; inserted: number }> {
  return withDerivedFactsWrite(engine, input.sourceId, [input.slug], async tx => {
    const current = await tx.getPage(input.slug, { sourceId: input.sourceId });
    if (!current || current.id !== input.pageId || current.knowledge_revision !== input.revision ||
      await input.currentToken(tx, current) !== input.token) {
      throw new Error('Conversation page changed during extraction; prior facts were preserved.');
    }
    const deleted = await tx.executeRaw<{ count: string }>(
      `WITH del AS (DELETE FROM facts WHERE source_id=$1 AND source_markdown_slug=$2
        AND source LIKE 'cli:extract-conversation-facts%' RETURNING 1)
       SELECT COUNT(*)::text AS count FROM del`, [input.sourceId, input.slug]);
    const result = input.rows.length ? await tx.insertFacts(input.rows, { source_id: input.sourceId }) : { inserted: 0 };
    return { deleted: Number(deleted[0]?.count ?? 0), inserted: result.inserted };
  });
}
