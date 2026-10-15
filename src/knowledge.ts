import { normalizeText } from "./classifier";
import type { KnowledgeChunk, KnowledgeCitation } from "./types";

const STOP_WORDS = new Set(["va", "la", "cua", "co", "cho", "trong", "mot", "nhung", "cac", "duoc", "ve", "voi", "khi", "nao", "gi"]);

function tokens(value: string): string[] {
  return normalizeText(value).split(/[^a-z0-9]+/).filter((item) => item.length > 1 && !STOP_WORDS.has(item));
}

export function chunkText(text: string, maxLength = 3200): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const result: string[] = [];
  for (let start = 0; start < clean.length; start += Math.floor(maxLength * 0.82)) {
    const part = clean.slice(start, start + maxLength).trim();
    if (part.length >= 40) result.push(part);
    if (start + maxLength >= clean.length) break;
  }
  return result;
}

export function searchKnowledge(chunks: KnowledgeChunk[], query: string, limit = 8): KnowledgeChunk[] {
  const queryNormalized = normalizeText(query);
  const queryTokens = [...new Set(tokens(query))];
  if (!queryTokens.length) return [];
  return chunks
    .map((chunk) => {
      const haystack = normalizeText(`${chunk.week} ${chunk.materialName} ${chunk.text}`);
      let score = queryNormalized.length > 4 && haystack.includes(queryNormalized) ? 18 : 0;
      for (const token of queryTokens) {
        const occurrences = haystack.split(token).length - 1;
        score += Math.min(occurrences, 6) * (token.length >= 6 ? 3 : 1.5);
        if (normalizeText(chunk.materialName).includes(token)) score += 4;
        if (normalizeText(chunk.week).includes(token)) score += 2;
      }
      return { chunk, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => item.chunk);
}

export function searchSelectedKnowledge(chunks: KnowledgeChunk[], materialIds: string[], query: string, limit = 8): KnowledgeChunk[] {
  if (!materialIds.length) return [];
  const allowed = new Set(materialIds);
  return searchKnowledge(chunks.filter((chunk) => allowed.has(chunk.materialId)), query, limit);
}

export function citationFromChunk(chunk: KnowledgeChunk, sourceNumber?: number): KnowledgeCitation {
  return {
    chunkId: chunk.id,
    sourceNumber,
    materialName: chunk.materialName,
    materialUrl: chunk.materialUrl,
    week: chunk.week,
    page: chunk.page,
    excerpt: chunk.text.slice(0, 420)
  };
}
