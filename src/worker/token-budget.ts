export interface TokenCategories {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

// Pi normalizes provider input to uncached tokens (including OpenAI's inclusive input count).
// Subtracting cache reads here would subtract them twice.
export function freshTokens(tokens: TokenCategories): number {
  for (const [category, count] of Object.entries(tokens)) {
    if (!Number.isSafeInteger(count) || count < 0) throw new Error(`Invalid ${category} token count: ${count}`);
  }
  return tokens.input + tokens.cacheWrite + tokens.output;
}
