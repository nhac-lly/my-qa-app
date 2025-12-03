"use client";

import Papa from "papaparse";
import { WebAI, type WebAIPriorities } from "@axols/webai-js";
import { queryArobidMCP, isArobidRelatedQuery, hasMCPTools } from "./mcp-client";

type CsvRow = {
  ["CÂU HỎI GỐC"]?: string;
  ["TRẢ LỜI CHUẨN"]?: string;
  ["SHORT QUESTION"]?: string;
};

const MODEL_ID = "gemma-embedding-300m";
const PRIORITIES: WebAIPriorities = [
  { mode: "webai", precision: "q4", device: "webgpu" },
  { mode: "webai", precision: "q4", device: "wasm" },
];
const EMBEDDING_BATCH_SIZE = 16;

const neutralQuestions: { q: string; a: string }[] = [
  { q: "Hi", a: "Hello! How can I help you today?" },
  { q: "Hello", a: "Hi there! What can I do for you?" },
  { q: "How are you?", a: "I'm doing well, thank you for asking! How can I assist you?" },
  { q: "Ping", a: "Pong! I'm here and ready to help." },
  { q: "What can you do?", a: "I can help you with FAQ questions, provide information about Arobid features, and navigate you to different pages. Try asking me a question or say 'go to [page name]' to navigate!" },
  { q: "What questions can you answer?", a: "I can answer questions from the FAQ database, help with Arobid-related queries, and assist with navigation. Feel free to ask me anything!" },
  { q: "Help", a: "I'm here to help! You can ask me questions from the FAQ, get information about Arobid features, or navigate to different pages by saying 'go to [page name]'." },
];

let webaiInstance: WebAI | null = null;
let webaiInitPromise: Promise<void> | null = null;
let faqData: { q: string; a: string }[] | null = null;
let faqEmbeddings: number[][] | null = null;
let embeddingInitPromise: Promise<void> | null = null;

async function ensureWebAIReady(): Promise<void> {
  if (typeof window === "undefined") {
    throw new Error("WebAI models can only run in the browser.");
  }

  if (webaiInstance) {
    return;
  }

  if (!webaiInitPromise) {
    webaiInitPromise = (async () => {
      console.log("[helper-client2] Initializing WebAI", MODEL_ID);
      const instance = await WebAI.create({
        modelId: MODEL_ID,
        dev: process.env.NODE_ENV !== "production",
      });

      const runInit = async (options: Parameters<WebAI["init"]>[0]) => {
        await instance.init({
          ...options,
          onDownloadProgress: (progress) => {
            console.debug("[helper-client2] Download progress", progress);
          },
          callbackThrottle: 1000,
        });
      };

      try {
        // Required preload configuration: run on WebGPU with q4 precision
        await runInit({
          mode: "webai",
          precision: "q4",
          device: "webgpu",
        });
      } catch (gpuError) {
        console.warn("[helper-client2] WebGPU init failed, falling back to priorities list:", gpuError);
        await runInit({
          mode: "auto",
          priorities: PRIORITIES,
        });
      }

      webaiInstance = instance;
      console.log("[helper-client2] WebAI ready");
    })().catch((error) => {
      webaiInstance = null;
      webaiInitPromise = null;
      throw error;
    });
  }

  await webaiInitPromise;
}

async function embedWithGemma(texts: string[]): Promise<number[][]> {
  if (!texts.length) {
    return [];
  }

  await ensureWebAIReady();
  if (!webaiInstance) {
    throw new Error("WebAI failed to initialize.");
  }

  const response = await webaiInstance.generate({
    userInput: { texts },
    modelConfig: {
      normalize: true,
      pooling: "mean",
    },
    generateConfig: {},
  });

  const embeddings = extractEmbeddings(response);
  if (!embeddings.length) {
    console.warn("[helper-client2] No embeddings returned for provided texts.");
  }
  return embeddings.slice(0, texts.length);
}

export async function warmupGemma(): Promise<void> {
  await ensureWebAIReady();
}

function extractEmbeddings(payload: unknown): number[][] {
  const visited = new Set<unknown>();

  const asNumberArray = (value: unknown): number[] | null => {
    if (Array.isArray(value)) {
      const vector: number[] = [];
      for (const entry of value) {
        const num = typeof entry === "number" ? entry : Number(entry);
        if (!Number.isFinite(num)) {
          return null;
        }
        vector.push(num);
      }
      return vector;
    }

    if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView(value)) {
      const iterable = value as ArrayBufferView & Iterable<number>;
      const vector = Array.from(iterable).map((num) =>
        typeof num === "number" ? num : Number(num),
      );
      return vector.every((num) => Number.isFinite(num)) ? vector : null;
    }

    return null;
  };

  const asMatrix = (value: unknown): number[][] | null => {
    if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView(value)) {
      const vector = asNumberArray(value);
      return vector ? [vector] : null;
    }

    if (!Array.isArray(value)) {
      return null;
    }

    const vectors: number[][] = [];
    for (const entry of value) {
      if (entry && typeof entry === "object" && "embedding" in (entry as Record<string, unknown>)) {
        const vector = asNumberArray((entry as Record<string, unknown>).embedding);
        if (vector) {
          vectors.push(vector);
          continue;
        }
      }

      const vector = asNumberArray(entry);
      if (vector) {
        vectors.push(vector);
      }
    }

    return vectors.length ? vectors : null;
  };

  const traverse = (value: unknown): number[][] | null => {
    if (value === null || value === undefined) {
      return null;
    }
    if (typeof value === "object" || Array.isArray(value)) {
      if (visited.has(value)) {
        return null;
      }
      visited.add(value);
    }

    const direct = asMatrix(value);
    if (direct?.length) {
      return direct;
    }

    if (Array.isArray(value)) {
      for (const entry of value) {
        const nested = traverse(entry);
        if (nested?.length) {
          return nested;
        }
      }
    } else if (typeof value === "object") {
      for (const key of Object.keys(value as Record<string, unknown>)) {
        const nested = traverse((value as Record<string, unknown>)[key]);
        if (nested?.length) {
          return nested;
        }
      }
    }
    return null;
  };

  return traverse(payload) ?? [];
}

async function loadFaq(): Promise<{ q: string; a: string }[]> {
  if (faqData) {
    return faqData;
  }

  const allFaqs: { q: string; a: string }[] = [];
  allFaqs.push(...neutralQuestions);

  try {
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

        answer = answer.replace(/\r\n/g, "\n");
        answer = answer.replace(/\r/g, "\n");
        answer = answer.replace(/\n{3,}/g, "\n\n");
        answer = answer.replace(/[ \t]+/g, " ");
        answer = answer.replace(/\n([^\s\n])/g, "\n$1");

        if (answer.includes("Hoàn") && !answer.includes("Hoàn toàn")) {
          console.warn(`[helper-client2] Potential spacing issue in row ${index + 1}: "${answer.substring(0, 100)}"`);
        }

        if (!question || !answer) return null;
        return { q: question, a: answer };
      })
      .filter((item): item is { q: string; a: string } => Boolean(item));

    if (fromCsv.length > 0) {
      allFaqs.push(...fromCsv);
    }
  } catch (error) {
    console.error("[helper-client2] Failed to load FAQ CSV:", error);
  }

  faqData = allFaqs.length > 0 ? allFaqs : neutralQuestions;
  return faqData;
}

async function initializeEmbeddings(): Promise<void> {
  if (faqEmbeddings) {
    return;
  }

  if (embeddingInitPromise) {
    return embeddingInitPromise;
  }

  embeddingInitPromise = (async () => {
    const faq = await loadFaq();
    console.log("[helper-client2] Computing embeddings for", faq.length, "FAQ items (Gemma)...");

    const allEmbeddings: number[][] = [];
    for (let i = 0; i < faq.length; i += EMBEDDING_BATCH_SIZE) {
      const batchQuestions = faq.slice(i, i + EMBEDDING_BATCH_SIZE).map((item) => item.q);
      const batchEmbeddings = await embedWithGemma(batchQuestions);
      if (!batchEmbeddings.length) {
        console.warn("[helper-client2] Failed to compute embeddings for batch starting at index", i);
        continue;
      }
      allEmbeddings.push(...batchEmbeddings);
    }

    if (allEmbeddings.length !== faq.length) {
      console.warn(
        `[helper-client2] Embedding count mismatch. Expected ${faq.length}, got ${allEmbeddings.length}. Some answers may fallback to MCP.`,
      );
    }

    faqEmbeddings = allEmbeddings;
    console.log("[helper-client2] FAQ embeddings computed.");
  })().catch((error) => {
    faqEmbeddings = null;
    embeddingInitPromise = null;
    throw error;
  });

  return embeddingInitPromise;
}

function cosineSimilarity(vecA: number[], vecB: number[]) {
  const dot = vecA.reduce((sum, a, i) => sum + a * vecB[i], 0);
  const normA = Math.sqrt(vecA.reduce((sum, a) => sum + a * a, 0));
  const normB = Math.sqrt(vecB.reduce((sum, b) => sum + b * b, 0));
  return dot / (normA * normB);
}

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
          dp[i - 1][j - 1] + 1,
        );
      }
    }
  }

  return dp[m][n];
}

function stringSimilarity(str1: string, str2: string): number {
  const maxLen = Math.max(str1.length, str2.length);
  if (maxLen === 0) return 1;
  const distance = levenshteinDistance(str1, str2);
  return 1 - (distance / maxLen);
}

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

function detectNavigation(query: string): string | null {
  const normalized = query.trim().toLowerCase();
  console.log("[helper-client2][detectNavigation] Checking query:", normalized);

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
        console.log("[helper-client2][detectNavigation] Found keyword:", keyword, "afterKeyword:", afterKeyword);
        if (afterKeyword) {
          for (const [routeName, routePath] of Object.entries(NAVIGATION_ROUTES)) {
            if (afterKeyword === routeName || afterKeyword.startsWith(routeName + " ") || afterKeyword === routeName) {
              console.log("[helper-client2][detectNavigation] Matched route:", routeName, "->", routePath);
              return routePath;
            }
          }
        }
      }
    }
  }

  for (const [routeName, routePath] of Object.entries(NAVIGATION_ROUTES)) {
    if (normalized === routeName || normalized === `go ${routeName}` || normalized === `open ${routeName}`) {
      console.log("[helper-client2][detectNavigation] Direct match:", routeName, "->", routePath);
      return routePath;
    }
  }

  console.log("[helper-client2][detectNavigation] No navigation detected");
  return null;
}

export async function answerQuestion(query: string): Promise<string | { type: "navigation"; route: string; message: string }> {
  const normalizedQuery = (query || "").trim().toLowerCase();

  console.log("[helper-client2] answerQuestion called with query:", JSON.stringify(query));
  console.log("[helper-client2] normalizedQuery:", JSON.stringify(normalizedQuery));

  if (!normalizedQuery) {
    return "Sorry, I don't have an answer for that yet.";
  }

  const navigationRoute = detectNavigation(query);
  if (navigationRoute) {
    const routeName = navigationRoute === "/" ? "home" : navigationRoute.slice(1);
    return {
      type: "navigation",
      route: navigationRoute,
      message: `Navigating to ${routeName}...`,
    };
  }

  // Check if query is Arobid-related and should use MCP
  const hasMCPKeyword = normalizedQuery.includes("mcp");
  const isArobidQuery = isArobidRelatedQuery(query);
  
  if (hasMCPKeyword || isArobidQuery) {
    console.log("[helper-client2] Arobid-related query detected, checking MCP");
    try {
      // Check if MCP tools are available
      const mcpToolsAvailable = await hasMCPTools();
      
      if (mcpToolsAvailable) {
        console.log("[helper-client2] MCP tools are available");
        // MCP tools are available - try to get a response from MCP
        const mcpAnswer = await queryArobidMCP(query);
        if (mcpAnswer) {
          console.log("[helper-client2] MCP returned an answer");
          return mcpAnswer;
        }
        // If MCP tools are available but no answer, return info about available tools
        const tools = await import("./mcp-client").then(m => m.listMCPTools()).catch(() => []);
        if (tools.length > 0) {
          return `I have access to Arobid services through MCP. Available tools: ${tools.slice(0, 5).join(", ")}${tools.length > 5 ? ` and ${tools.length - 5} more` : ""}. How can I help you with Arobid?`;
        }
      }
      
      // If no tools available, try queryArobidMCP which will return null
      const mcpAnswer = await queryArobidMCP(query);
      if (mcpAnswer) {
        return mcpAnswer;
      }
    } catch (error) {
      console.error("[helper-client2] Error querying MCP:", error);
    }
  }

  await initializeEmbeddings();

  const faq = await loadFaq();

  const exactMatch = faq.find(item => {
    const normalizedFAQ = item.q.trim().toLowerCase();
    return normalizedFAQ === normalizedQuery;
  });

  if (exactMatch) {
    return exactMatch.a;
  }

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
      return bestFuzzyMatch.a;
    }
  }

  console.log("[helper-client2] No exact or fuzzy match found, trying embeddings...");

  if (!faqEmbeddings || faqEmbeddings.length === 0) {
    console.error("[helper-client2] FAQ embeddings not initialized");
    return "Sorry, I don't have an answer for that yet.";
  }

  const queryEmbeddings = await embedWithGemma([query.trim()]);
  const queryEmbedding = queryEmbeddings[0];
  if (!queryEmbedding || queryEmbedding.length === 0) {
    console.error("[helper-client2] Failed to compute embedding for query");
    return "Sorry, I don't have an answer for that yet.";
  }

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

  if (bestScore >= SIMILARITY_THRESHOLD && bestIndex >= 0) {
    bestAnswer = faq[bestIndex].a;
  }

  return bestAnswer;
}