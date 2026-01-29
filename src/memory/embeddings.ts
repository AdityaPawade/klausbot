import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import OpenAI from 'openai';
import { getHomePath } from './home.js';

/** Embedding entry stored in JSON file */
export interface EmbeddingEntry {
  id: string;
  text: string;
  embedding: number[];
  timestamp: string;
  source: string;
}

/** Embeddings storage format */
interface EmbeddingsFile {
  entries: EmbeddingEntry[];
}

/** Lazy-initialized OpenAI client */
let openaiClient: OpenAI | null = null;

/** Model for embeddings (1536 dimensions, $0.00002/1K tokens) */
const EMBEDDING_MODEL = 'text-embedding-3-small';

/** Max chunk size for text splitting (~500 chars for better retrieval) */
const CHUNK_SIZE = 500;

/** Path to embeddings storage file */
function getEmbeddingsPath(): string {
  return getHomePath('embeddings.json');
}

/**
 * Get or create OpenAI client
 * Lazy initialization - only creates client when API key exists
 *
 * @returns OpenAI client or null if no API key
 */
function getOpenAIClient(): OpenAI | null {
  if (openaiClient !== null) {
    return openaiClient;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return null;
  }

  openaiClient = new OpenAI({ apiKey });
  return openaiClient;
}

/**
 * Generate embedding for text using OpenAI API
 *
 * @param text - Text to embed
 * @returns Embedding vector (1536 dimensions) or null on error
 */
export async function generateEmbedding(text: string): Promise<number[] | null> {
  const client = getOpenAIClient();
  if (!client) {
    console.warn('[embeddings] OPENAI_API_KEY not set, skipping embedding generation');
    return null;
  }

  try {
    const response = await client.embeddings.create({
      model: EMBEDDING_MODEL,
      input: text,
    });

    return response.data[0].embedding;
  } catch (error) {
    // Log and skip on any error (rate limit, API error, etc.)
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`[embeddings] Failed to generate embedding: ${msg}`);
    return null;
  }
}

/**
 * Split text into chunks for better retrieval
 * Splits at sentence boundaries first, then word boundaries
 *
 * @param text - Text to split
 * @returns Array of text chunks
 */
function chunkText(text: string): string[] {
  if (text.length <= CHUNK_SIZE) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= CHUNK_SIZE) {
      chunks.push(remaining.trim());
      break;
    }

    // Try to split at sentence boundary
    let splitPoint = remaining.lastIndexOf('. ', CHUNK_SIZE);
    if (splitPoint === -1 || splitPoint < CHUNK_SIZE * 0.3) {
      // Try word boundary
      splitPoint = remaining.lastIndexOf(' ', CHUNK_SIZE);
    }
    if (splitPoint === -1 || splitPoint < CHUNK_SIZE * 0.3) {
      // Hard split
      splitPoint = CHUNK_SIZE;
    }

    const chunk = remaining.slice(0, splitPoint + 1).trim();
    if (chunk.length > 0) {
      chunks.push(chunk);
    }
    remaining = remaining.slice(splitPoint + 1);
  }

  return chunks;
}

/**
 * Load embeddings from storage file
 *
 * @returns Embeddings file content or empty structure
 */
function loadEmbeddings(): EmbeddingsFile {
  const path = getEmbeddingsPath();
  if (!existsSync(path)) {
    return { entries: [] };
  }

  try {
    const content = readFileSync(path, 'utf-8');
    return JSON.parse(content) as EmbeddingsFile;
  } catch {
    // Corrupt file - return empty
    return { entries: [] };
  }
}

/**
 * Save embeddings to storage file
 *
 * @param data - Embeddings to save
 */
function saveEmbeddings(data: EmbeddingsFile): void {
  const path = getEmbeddingsPath();
  const dir = dirname(path);

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(path, JSON.stringify(data, null, 2));
}

/**
 * Store embedding for text
 * Splits long text into chunks and embeds each chunk separately
 * Fire-and-forget: errors are logged but don't propagate
 *
 * @param text - Text to embed and store
 * @param source - Source identifier (e.g., 'assistant-2026-01-29')
 */
export async function storeEmbedding(text: string, source: string): Promise<void> {
  const client = getOpenAIClient();
  if (!client) {
    console.warn('[embeddings] OPENAI_API_KEY not set, skipping embedding storage');
    return;
  }

  const chunks = chunkText(text);
  const data = loadEmbeddings();
  const timestamp = new Date().toISOString();

  for (const chunk of chunks) {
    const embedding = await generateEmbedding(chunk);
    if (!embedding) {
      continue; // Skip failed embeddings
    }

    const entry: EmbeddingEntry = {
      id: `${source}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      text: chunk,
      embedding,
      timestamp,
      source,
    };

    data.entries.push(entry);
  }

  // Only save if we added any entries
  if (data.entries.length > 0) {
    saveEmbeddings(data);
  }
}

/**
 * Initialize embeddings storage
 * Creates empty embeddings.json if it doesn't exist
 */
export function initializeEmbeddings(): void {
  const path = getEmbeddingsPath();
  if (!existsSync(path)) {
    saveEmbeddings({ entries: [] });
  }
}
