"use client";

import Papa from "papaparse";
import { pipeline, env } from "@huggingface/transformers";
import { queryArobidMCP } from "./mcp-client";

// Disable local model files for client-side (use CDN)
env.allowLocalModels = false;
env.allowRemoteModels = true;

type CsvRow = {
  ["CÂU HỎI GỐC"]?: string;
  ["TRẢ LỜI CHUẨN"]?: string;
  ["SHORT QUESTION"]?: string;
};

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

// Global state for FAQ data and embeddings
let faqData: { q: string; a: string }[] | null = null;
let faqEmbeddings: number[][] | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let embedder: any = null;
let loadingPromise: Promise<void> | null = null;

/**
 * Load FAQ data from CSV file
 */
async function loadFaq(): Promise<{ q: string; a: string }[]> {
  if (faqData) {
    return faqData;
  }

  const allFaqs: { q: string; a: string }[] = [];
  
  // Always include neutral questions first
  allFaqs.push(...neutralQuestions);
  
  try {
    // Fetch CSV from public folder
    const response = await fetch("/data/chatbot-faq.csv");
    if (!response.ok) {
      throw new Error(`Failed to fetch FAQ CSV: ${response.statusText}`);
    }
    const csv = await response.text();
    
    const result = Papa.parse<CsvRow>(csv, {
      header: true,
      delimiter: ";",
      skipEmptyLines: false,
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
        answer = answer.replace(/\r\n/g, "\n");
        answer = answer.replace(/\r/g, "\n");
        answer = answer.replace(/\n{3,}/g, "\n\n");
        answer = answer.replace(/[ \t]+/g, " ");
        answer = answer.replace(/\n([^\s\n])/g, "\n$1");
        
        if (answer.includes("Hoàn") && !answer.includes("Hoàn toàn")) {
          console.warn(`[helper-client.ts] Potential spacing issue in row ${index + 1}: "${answer.substring(0, 100)}"`);
        }
        
        if (!question || !answer) return null;
        return { q: question, a: answer };
      })
      .filter((item): item is { q: string; a: string } => Boolean(item));

    if (fromCsv.length > 0) {
      allFaqs.push(...fromCsv);
    }
  } catch (error) {
    console.error("[helper-client.ts] Failed to load FAQ CSV:", error);
  }

  faqData = allFaqs.length > 0 ? allFaqs : neutralQuestions;
  return faqData;
}

/**
 * Initialize the embedding model and precompute embeddings
 */
async function initializeEmbeddings(): Promise<void> {
  if (embedder && faqEmbeddings) {
    return;
  }

  if (loadingPromise) {
    return loadingPromise;
  }

  loadingPromise = (async () => {
    try {
      console.log("[helper-client.ts] Loading embedding model...");
      embedder = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
      console.log("[helper-client.ts] Embedding model loaded");

      const faq = await loadFaq();
      console.log("[helper-client.ts] Computing embeddings for", faq.length, "FAQ items...");
      
      const faqEmbeddingsRaw = await Promise.all(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        faq.map(item => (embedder as (text: string) => Promise<any>)(item.q))
      );
      
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      faqEmbeddings = faqEmbeddingsRaw.map((tensor: any) => {
        return extractEmbedding(tensor);
      });
      
      console.log("[helper-client.ts] Embeddings computed");
    } catch (error) {
      console.error("[helper-client.ts] Failed to initialize embeddings:", error);
      throw error;
    }
  })();

  return loadingPromise;
}

// Helper function to extract a single embedding vector from a tensor
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractEmbedding(tensor: any): number[] {
  const rawData =
    tensor.data instanceof Array ? tensor.data : Array.from(tensor.data as ArrayLike<number>);

  const dims = tensor.dims ?? [rawData.length];

  if (dims.length === 1) {
    return rawData;
  }

  const hiddenSize = dims[dims.length - 1];
  const totalVectors = rawData.length / hiddenSize;

  if (!Number.isFinite(hiddenSize) || hiddenSize <= 0) {
    return rawData;
  }

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

function cosineSimilarity(vecA: number[], vecB: number[]): number {
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
          dp[i - 1][j] + 1,
          dp[i][j - 1] + 1,
          dp[i - 1][j - 1] + 1
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
 */
function detectNavigation(query: string): string | null {
  const normalized = query.trim().toLowerCase();
  console.log("[detectNavigation] Checking query:", normalized);
  
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
  
  for (const keyword of navKeywords) {
    if (normalized.includes(keyword)) {
      const parts = normalized.split(keyword);
      if (parts.length > 1) {
        const afterKeyword = parts[1]?.trim();
        console.log("[detectNavigation] Found keyword:", keyword, "afterKeyword:", afterKeyword);
        if (afterKeyword) {
          for (const [routeName, routePath] of Object.entries(NAVIGATION_ROUTES)) {
            if (afterKeyword === routeName || afterKeyword.startsWith(routeName + " ") || afterKeyword === routeName) {
              console.log("[detectNavigation] Matched route:", routeName, "->", routePath);
              return routePath;
            }
          }
        }
      }
    }
  }
  
  for (const [routeName, routePath] of Object.entries(NAVIGATION_ROUTES)) {
    if (normalized === routeName || normalized === `go ${routeName}` || normalized === `open ${routeName}`) {
      console.log("[detectNavigation] Direct match:", routeName, "->", routePath);
      return routePath;
    }
  }
  
  console.log("[detectNavigation] No navigation detected");
  return null;
}

/**
 * Answer function - client-side version
 */
export async function answerQuestion(query: string): Promise<string | { type: "navigation"; route: string; message: string }> {
  const normalizedQuery = (query || "").trim().toLowerCase();
  
  console.log("answerQuestion called with query:", JSON.stringify(query));
  console.log("normalizedQuery:", JSON.stringify(normalizedQuery));
  
  if (!normalizedQuery) {
    console.log("Empty query, returning default");
    return "Sorry, I don't have an answer for that yet.";
  }
  
  // Check for navigation intent first
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
    } catch (error) {
      console.error("[helper-client.ts] Error querying MCP:", error);
    }
  }
  
  // Initialize embeddings if not already done
  await initializeEmbeddings();
  
  const faq = await loadFaq();
  
  // Fast path: Check for exact string match first
  const exactMatch = faq.find(item => {
    const normalizedFAQ = item.q.trim().toLowerCase();
    return normalizedFAQ === normalizedQuery;
  });
  
  if (exactMatch) {
    console.log(`Exact match found: "${exactMatch.q}" -> "${exactMatch.a}"`);
    return exactMatch.a;
  }
  
  // Fuzzy matching for short queries
  if (normalizedQuery.length <= 10) {
    const FUZZY_THRESHOLD = 0.8;
    let bestFuzzyScore = 0;
    let bestFuzzyMatch: typeof faq[0] | null = null;
    
    for (const item of faq) {
      const normalizedFAQ = item.q.trim().toLowerCase();
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
  
  // Use embedding-based similarity
  if (!embedder || !faqEmbeddings) {
    console.error("[helper-client.ts] Embeddings not initialized");
    return "Sorry, I don't have an answer for that yet.";
  }
  
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const queryEmbeddingTensor = await (embedder as (text: string) => Promise<any>)(query.trim());
  const queryEmbedding = extractEmbedding(queryEmbeddingTensor);
  
  console.log(`Query embedding dimension: ${queryEmbedding.length}`);
  
  const isShortQuery = normalizedQuery.length <= 5;
  const SIMILARITY_THRESHOLD = isShortQuery ? 0.4 : 0.5;
  
  let bestScore = -1;
  let bestAnswer = "Sorry, I don't have an answer for that yet.";
  let bestIndex = -1;
  
  for (let i = 0; i < faqEmbeddings.length; i++) {
    const embArray = faqEmbeddings[i];
    const score = cosineSimilarity(queryEmbedding, embArray);
    
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }
  
  console.log(`Best match: index ${bestIndex}, score ${bestScore.toFixed(4)}`);
  
  if (bestScore >= SIMILARITY_THRESHOLD && bestIndex >= 0) {
    bestAnswer = faq[bestIndex].a;
    console.log(`Using FAQ answer: "${faq[bestIndex].q}" (similarity: ${bestScore.toFixed(4)})`);
  } else {
    console.log("No FAQ match found, using default answer");
  }
  
  return bestAnswer;
}

