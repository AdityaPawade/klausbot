import { desc, gte } from 'drizzle-orm';
import { getDb, getDrizzle } from './db.js';
import { generateEmbedding } from './embeddings.js';
import { conversations } from './schema.js';

/** Search result with relevance score */
export interface SearchResult {
  text: string;
  score: number;
  source: string;
  timestamp: string;
}

/** Search options */
export interface SearchOptions {
  topK?: number;
  daysBack?: number;  // Filter to last N days
}

/**
 * Semantic search over stored embeddings using sqlite-vec KNN
 * Finds the most relevant entries for a query
 *
 * @param query - Natural language query
 * @param options - Search options (topK, daysBack)
 * @returns Array of search results sorted by relevance
 */
export async function semanticSearch(
  query: string,
  options: SearchOptions = {}
): Promise<SearchResult[]> {
  const { topK = 5, daysBack } = options;

  // Check for API key first
  if (!process.env.OPENAI_API_KEY) {
    console.warn('[search] OPENAI_API_KEY not set, semantic search unavailable');
    return [];
  }

  // Generate query embedding
  const queryEmbedding = await generateEmbedding(query);
  if (!queryEmbedding) {
    return [];
  }

  const db = getDb();

  // Build query with optional date filter
  // sqlite-vec uses k = ? constraint for KNN, not LIMIT
  // Join vec_embeddings.rowid to embeddings.id for text data
  let sql: string;
  const params: (Float32Array | number | string)[] = [new Float32Array(queryEmbedding), topK];

  if (daysBack !== undefined && daysBack > 0) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - daysBack);

    sql = `
      SELECT
        e.text,
        e.source,
        e.timestamp,
        v.distance
      FROM vec_embeddings v
      INNER JOIN embeddings e ON e.id = v.rowid
      WHERE v.embedding MATCH ?
        AND v.k = ?
        AND e.timestamp >= ?
      ORDER BY v.distance
    `;
    params.push(cutoff.toISOString());
  } else {
    sql = `
      SELECT
        e.text,
        e.source,
        e.timestamp,
        v.distance
      FROM vec_embeddings v
      INNER JOIN embeddings e ON e.id = v.rowid
      WHERE v.embedding MATCH ?
        AND v.k = ?
      ORDER BY v.distance
    `;
  }

  // Execute KNN search
  const rows = db.prepare(sql).all(...params) as Array<{
    text: string;
    source: string;
    timestamp: string;
    distance: number;
  }>;

  // Convert distance to similarity score (sqlite-vec returns L2 distance)
  // Lower distance = more similar, convert to 0-1 score where 1 = identical
  return rows.map(row => ({
    text: row.text,
    source: row.source,
    timestamp: row.timestamp,
    score: 1 / (1 + row.distance),
  }));
}

/** Conversation search result */
export interface ConversationSearchResult {
  sessionId: string;
  summary: string;
  endedAt: string;
  messageCount: number;
  score: number;  // Relevance score (0-1)
}

/**
 * Search conversations by summary content
 * Uses SQL LIKE for keyword matching (semantic search for conversations in future)
 *
 * @param query - Search query
 * @param options - Search options
 * @returns Matching conversations with relevance scores
 */
export function searchConversations(
  query: string,
  options: { topK?: number; daysBack?: number } = {}
): ConversationSearchResult[] {
  const { topK = 5, daysBack } = options;
  const db = getDrizzle();

  // Build base query
  let results;
  const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);

  if (daysBack) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - daysBack);

    results = db
      .select()
      .from(conversations)
      .where(gte(conversations.endedAt, cutoff.toISOString()))
      .orderBy(desc(conversations.endedAt))
      .limit(50)  // Get more for filtering
      .all();
  } else {
    results = db
      .select()
      .from(conversations)
      .orderBy(desc(conversations.endedAt))
      .limit(50)
      .all();
  }

  // Score results by keyword match in summary
  const scored = results.map(conv => {
    const summaryLower = conv.summary.toLowerCase();
    const matchedWords = queryWords.filter(w => summaryLower.includes(w));
    const score = queryWords.length > 0
      ? matchedWords.length / queryWords.length
      : 0;

    return {
      sessionId: conv.sessionId,
      summary: conv.summary,
      endedAt: conv.endedAt,
      messageCount: conv.messageCount,
      score,
    };
  });

  // Filter and sort by score
  return scored
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}
