import fs from "fs";
import path from "path";
import Papa from "papaparse";
import { pipeline } from '@huggingface/transformers';
import { queryArobidMCP } from "./mcp-client";

// Load embedding model once
const embedder = await pipeline("feature-extraction");

type CsvRow = {
  ["CÂU HỎI GỐC"]?: string;
  ["TRẢ LỜI CHUẨN"]?: string;
  ["SHORT QUESTION"]?: string;
};

const faqCsvPath = path.join(process.cwd(), "data", "chatbot-faq.csv");

// Neutral/general questions that are always available
const neutralQuestions: { q: string; a: string }[] = [
  { q: "Hi", a: "Hello! How can I help you today?" },
  { q: "Hello", a: "Hi there! What can I do for you?" },
  { q: "How are you?", a: "I'm doing well, thank you for asking! How can I assist you?" },
  { q: "Ping", a: "Pong! I'm here and ready to help." },
  { q: "What can you do?", a: "I can help you with FAQ questions, provide information about Arobid features, and navigate you to different pages. Try asking me a question or say 'go to [page name]' to navigate!" },
  { q: "What questions can you answer?", a: "I can answer questions from the FAQ database, help with Arobid-related queries, and assist with navigation. Feel free to ask me anything!" },
  { q: "Help", a: "I'm here to help! You can ask me questions from the FAQ, get information about Arobid features, or navigate to different pages by saying 'go to [page name]'." },
];

function loadFaq(): { q: string; a: string }[] {
  const allFaqs: { q: string; a: string }[] = [];
  
  // Always include neutral questions first
  allFaqs.push(...neutralQuestions);
  
  try {
    const csv = fs.readFileSync(faqCsvPath, "utf-8");
    const result = Papa.parse<CsvRow>(csv, {
      header: true,
      delimiter: ";",
      skipEmptyLines: false, // Don't skip empty lines to preserve multi-line fields
      newline: "\n",
      quoteChar: '"',
      escapeChar: '"',
    });

    const fromCsv = (result.data as CsvRow[])
      .map((row: CsvRow, index) => {
        const question =
          row["SHORT QUESTION"]?.trim() || row["CÂU HỎI GỐC"]?.trim();
        let answer = row["TRẢ LỜI CHUẨN"]?.trim() || "";
        
        // Normalize line endings but preserve newlines for formatting
        answer = answer.replace(/\r\n/g, "\n"); // Normalize Windows line endings
        answer = answer.replace(/\r/g, "\n"); // Normalize Mac line endings
        // Normalize multiple consecutive newlines to double newline (paragraph break)
        answer = answer.replace(/\n{3,}/g, "\n\n");
        // Normalize multiple spaces/tabs to single space (but preserve single spaces and newlines)
        answer = answer.replace(/[ \t]+/g, " ");
        // Ensure there's a space after newline if the next line doesn't start with space
        answer = answer.replace(/\n([^\s\n])/g, "\n$1");
        
        // Debug: Log if answer seems to have spacing issues
        if (answer.includes("Hoàn") && !answer.includes("Hoàn toàn")) {
          console.warn(`[helper.ts] Potential spacing issue in row ${index + 1}: "${answer.substring(0, 100)}"`);
        }
        
        if (!question || !answer) return null;
        return { q: question, a: answer };
      })
      .filter((item): item is { q: string; a: string } => Boolean(item));

    // Add CSV FAQs to the list
    if (fromCsv.length > 0) {
      allFaqs.push(...fromCsv);
    }
  } catch (error) {
    console.error("[helper.ts] Failed to load FAQ CSV:", error);
    // If CSV fails, we still have neutral questions, so we can return them
  }

  // Return all FAQs (neutral + CSV), or at least neutral questions if CSV failed
  return allFaqs.length > 0 ? allFaqs : neutralQuestions;
}

const faq = loadFaq();

// Helper function to extract a single embedding vector from a tensor.
// The transformers pipeline returns tensors with shape [tokens, hidden_dim]
// (or [batch, tokens, hidden_dim]). We average over the token dimension so
// every embedding has the same hidden_dim length (e.g. 384 for MiniLM).
function extractEmbedding(tensor: { data: unknown; dims?: number[] }): number[] {
  const rawData =
    tensor.data instanceof Array ? tensor.data : Array.from(tensor.data as ArrayLike<number>);

  const dims = tensor.dims ?? [rawData.length];

  if (dims.length === 1) {
    // Already a flat vector
    return rawData;
  }

  // Determine hidden size (last dimension) and total number of vectors
  const hiddenSize = dims[dims.length - 1];
  const totalVectors = rawData.length / hiddenSize;

  if (!Number.isFinite(hiddenSize) || hiddenSize <= 0) {
    return rawData;
  }

  // Average over all vectors (tokens) to get a single embedding
  const averaged = new Array(hiddenSize).fill(0);

  for (let vecIndex = 0; vecIndex < totalVectors; vecIndex++) {
    const offset = vecIndex * hiddenSize;
    for (let i = 0; i < hiddenSize; i++) {
      averaged[i] += rawData[offset + i];
    }
  }

  if (totalVectors > 0) {
    for (let i = 0; i < hiddenSize; i++) {
      averaged[i] /= totalVectors;
    }
  }

  return averaged;
}

// Precompute embeddings
const faqEmbeddingsRaw = await Promise.all(faq.map(item => embedder(item.q)));
// Extract embedding vectors using consistent extraction
const faqEmbeddings = faqEmbeddingsRaw.map(tensor => extractEmbedding(tensor));

function cosineSimilarity(vecA: number[], vecB: number[]) {
  const dot = vecA.reduce((sum, a, i) => sum + a * vecB[i], 0);
  const normA = Math.sqrt(vecA.reduce((sum, a) => sum + a*a, 0));
  const normB = Math.sqrt(vecB.reduce((sum, b) => sum + b*b, 0));
  return dot / (normA * normB);
}

// Calculate Levenshtein distance between two strings
function levenshteinDistance(str1: string, str2: string): number {
  const m = str1.length;
  const n = str2.length;
  const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (str1[i - 1] === str2[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = Math.min(
          dp[i - 1][j] + 1,     // deletion
          dp[i][j - 1] + 1,     // insertion
          dp[i - 1][j - 1] + 1  // substitution
        );
      }
    }
  }

  return dp[m][n];
}

// Calculate string similarity (0-1, where 1 is identical)
function stringSimilarity(str1: string, str2: string): number {
  const maxLen = Math.max(str1.length, str2.length);
  if (maxLen === 0) return 1;
  const distance = levenshteinDistance(str1, str2);
  return 1 - (distance / maxLen);
}

// Navigation route mapping
const NAVIGATION_ROUTES: Record<string, string> = {
  "home": "/",
  "main": "/",
  "index": "/",
  "settings": "/settings",
  "setting": "/settings",
  "profile": "/profile",
  "about": "/about",
  "contact": "/contact",
  "help": "/help",
  "faq": "/faq",
  "login": "/login",
  "signin": "/login",
  "sign in": "/login",
  "register": "/register",
  "signup": "/signup",
  "sign up": "/register",
  "dashboard": "/dashboard",
};

/**
 * Detect navigation intent from query
 * Returns the route path if navigation is detected, null otherwise
 */
function detectNavigation(query: string): string | null {
  const normalized = query.trim().toLowerCase();
  console.log("[detectNavigation] Checking query:", normalized);
  
  // Navigation keywords - order matters! Check longer phrases first
  const navKeywords = [
    "navigate to",
    "take me to",
    "go to",
    "show me",
    "switch to",
    "open",
    "visit",
    "go",
    "navigate",
  ];
  
  // Check if query contains navigation keywords
  for (const keyword of navKeywords) {
    if (normalized.includes(keyword)) {
      // Extract the route name after the keyword
      const parts = normalized.split(keyword);
      if (parts.length > 1) {
        const afterKeyword = parts[1]?.trim();
        console.log("[detectNavigation] Found keyword:", keyword, "afterKeyword:", afterKeyword);
        if (afterKeyword) {
          // Try to find matching route
          for (const [routeName, routePath] of Object.entries(NAVIGATION_ROUTES)) {
            // Check if the route name matches or is contained in afterKeyword
            if (afterKeyword === routeName || afterKeyword.startsWith(routeName + " ") || afterKeyword === routeName) {
              console.log("[detectNavigation] Matched route:", routeName, "->", routePath);
              return routePath;
            }
          }
        }
      }
    }
  }
  
  // Direct route name check (e.g., "home", "settings")
  for (const [routeName, routePath] of Object.entries(NAVIGATION_ROUTES)) {
    if (normalized === routeName || normalized === `go ${routeName}` || normalized === `open ${routeName}`) {
      console.log("[detectNavigation] Direct match:", routeName, "->", routePath);
      return routePath;
    }
  }
  
  console.log("[detectNavigation] No navigation detected");
  return null;
}

// Answer function
export async function answerQuestion(query: string): Promise<string | { type: "navigation"; route: string; message: string }> {
  // Normalize query for exact matching - trim and lowercase
  const normalizedQuery = (query || "").trim().toLowerCase();
  
  // Debug: Log the query being processed
  console.log("answerQuestion called with query:", JSON.stringify(query));
  console.log("normalizedQuery:", JSON.stringify(normalizedQuery));
  
  // Return default answer for empty queries
  if (!normalizedQuery) {
    console.log("Empty query, returning default");
    return "Sorry, I don't have an answer for that yet.";
  }
  
  // Check for navigation intent first (before FAQ and MCP check)
  const navigationRoute = detectNavigation(query);
  if (navigationRoute) {
    const routeName = navigationRoute === "/" ? "home" : navigationRoute.slice(1);
    console.log(`Navigation detected: "${query}" -> ${navigationRoute} (route name: ${routeName})`);
    return {
      type: "navigation",
      route: navigationRoute,
      message: `Navigating to ${routeName}...`,
    };
  }
  
  // If query contains "MCP" keyword, skip FAQ and go directly to MCP
  const hasMCPKeyword = normalizedQuery.includes("mcp");
  if (hasMCPKeyword) {
    console.log("MCP keyword detected, skipping FAQ and querying MCP directly");
    try {
      const mcpAnswer = await queryArobidMCP(query);
      if (mcpAnswer) {
        console.log("MCP provided an answer");
        return mcpAnswer;
      }
      console.log("MCP did not provide an answer, falling back to FAQ");
      // Continue with FAQ matching if MCP doesn't provide an answer
    } catch (error) {
      console.error("[helper.ts] Error querying MCP:", error);
      // Continue with FAQ matching if MCP fails
    }
  }
  
  // Always check FAQ first - MCP will only be used as fallback if FAQ doesn't have an answer
  // Debug: Log FAQ items for comparison
  console.log("FAQ items:", faq.map(item => ({ q: item.q, normalized: item.q.trim().toLowerCase() })));
  
  // Fast path: Check for exact string match first (case-insensitive)
  const exactMatch = faq.find(item => {
    const normalizedFAQ = item.q.trim().toLowerCase();
    const matches = normalizedFAQ === normalizedQuery;
    if (matches) {
      console.log(`Exact match found: "${item.q}" -> "${item.a}"`);
    } else {
      console.log(`Comparing: "${normalizedFAQ}" === "${normalizedQuery}" = ${matches}`);
    }
    return matches;
  });
  
  if (exactMatch) {
    return exactMatch.a;
  }
  
  // Fuzzy matching: Check for similar strings (handles typos like "Hii" -> "Hi")
  // Only do fuzzy matching for short queries (<= 10 chars) to avoid false positives
  if (normalizedQuery.length <= 10) {
    const FUZZY_THRESHOLD = 0.8; // 80% similarity required for fuzzy match
    let bestFuzzyScore = 0;
    let bestFuzzyMatch: typeof faq[0] | null = null;
    
    for (const item of faq) {
      const normalizedFAQ = item.q.trim().toLowerCase();
      // Only check fuzzy match if FAQ item is also short
      if (normalizedFAQ.length <= 10) {
        const similarity = stringSimilarity(normalizedQuery, normalizedFAQ);
        if (similarity > bestFuzzyScore && similarity >= FUZZY_THRESHOLD) {
          bestFuzzyScore = similarity;
          bestFuzzyMatch = item;
        }
      }
    }
    
    if (bestFuzzyMatch) {
      console.log(`Fuzzy match found: "${bestFuzzyMatch.q}" (similarity: ${bestFuzzyScore.toFixed(2)}) -> "${bestFuzzyMatch.a}"`);
      return bestFuzzyMatch.a;
    }
  }
  
  console.log("No exact or fuzzy match found, trying embeddings...");
  
  // Use embedding-based similarity for approximate matches
  // Use original query (not normalized) for embedding generation
  const queryEmbeddingTensor = await embedder(query.trim());
  // Extract embedding vector using the same method as precomputed embeddings
  const queryEmbedding = extractEmbedding(queryEmbeddingTensor);
  
  // Debug: Log embedding dimensions
  console.log(`Query embedding dimension: ${queryEmbedding.length}`);
  console.log(`FAQ embeddings dimensions: ${faqEmbeddings.map((emb, i) => `${i}:${emb.length}`).join(", ")}`);
  
  // Minimum similarity threshold - lower for short queries
  // For very short queries (1-5 chars), use a lower threshold since embeddings
  // for short text can vary more
  const isShortQuery = normalizedQuery.length <= 5;
  const SIMILARITY_THRESHOLD = isShortQuery ? 0.4 : 0.5;
  
  let bestScore = -1;
  let bestAnswer = "Sorry, I don't have an answer for that yet.";
  let bestIndex = -1;

  // Log dimensions for debugging
  console.log(`Query embedding dimension: ${queryEmbedding.length}`);
  
  for (let i = 0; i < faqEmbeddings.length; i++) {
    const embArray = faqEmbeddings[i];
    
    // Ensure vectors have the same length (dimension)
    // Dimension = number of values in the embedding vector
    // For all-MiniLM-L6-v2 model, this should be 384
    // if (queryEmbedding.length !== embArray.length) {
    //   console.warn(
    //     `Dimension mismatch: query has ${queryEmbedding.length} dimensions, ` +
    //     `FAQ[${i}] ("${faq[i].q}") has ${embArray.length} dimensions. ` +
    //     `Skipping this comparison.`
    //   );
    //   continue; // Skip this FAQ item - can't compare different sized vectors
    // }
    
    const score = cosineSimilarity(queryEmbedding, embArray);
    console.log(`Score for "${faq[i].q}": ${score.toFixed(4)} (dimension: ${embArray.length})`);
    
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }
  
  console.log(`Best match: index ${bestIndex}, score ${bestScore.toFixed(4)}`);

  // Only use the FAQ answer if it meets the threshold
  if (bestScore >= SIMILARITY_THRESHOLD && bestIndex >= 0) {
    bestAnswer = faq[bestIndex].a;
    console.log(`Using FAQ answer: "${faq[bestIndex].q}" (similarity: ${bestScore.toFixed(4)})`);
  } else {
    console.log("No FAQ match found, using default answer");
  }

  return bestAnswer;
}
