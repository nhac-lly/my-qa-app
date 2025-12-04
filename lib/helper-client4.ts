"use client";

/**
 * Helper client using Google Gemini API
 * Based on helper-client3 structure but uses Gemini API instead of DeepSeek R1
 */

// Gemini API configuration
// API key should be set via environment variable or passed directly
const GEMINI_API_KEY = process.env.NEXT_PUBLIC_GEMINI_API_KEY || "";

// Model priority list - will try in order if one fails
const GEMINI_MODELS = [
  "gemini-2.0-flash",
  "gemini-2.0-flash-lite",
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash",
  "gemini-2.5-pro",
];

// Default to first model
const GEMINI_MODEL = GEMINI_MODELS[0];

/**
 * Check if Gemini API key is available
 */
function checkApiKey(): boolean {
  if (!GEMINI_API_KEY || GEMINI_API_KEY.trim() === "") {
    console.warn("[helper-client4] Gemini API key not found. Set NEXT_PUBLIC_GEMINI_API_KEY environment variable.");
    return false;
  }
  return true;
}

/**
 * Convert messages format for Gemini API
 */
function formatMessagesForGemini(
  messages: Array<{ role: string; content: string }>
): Array<{ role: "user" | "model"; parts: Array<{ text: string }> }> {
  const geminiMessages: Array<{ role: "user" | "model"; parts: Array<{ text: string }> }> = [];
  
  for (const msg of messages) {
    const role = msg.role === "user" ? "user" : "model";
    geminiMessages.push({
      role,
      parts: [{ text: msg.content }],
    });
  }
  
  return geminiMessages;
}

/**
 * Check if error indicates resource exhaustion or model unavailability
 */
function isResourceExhausted(error: unknown): boolean {
  if (error instanceof Error) {
    const errorMessage = error.message.toLowerCase();
    return (
      errorMessage.includes("resource exhausted") ||
      errorMessage.includes("429") ||
      errorMessage.includes("quota") ||
      errorMessage.includes("rate limit") ||
      errorMessage.includes("not found") ||
      errorMessage.includes("does not exist") ||
      errorMessage.includes("model") && errorMessage.includes("unavailable")
    );
  }
  return false;
}

/**
 * Generate response from messages using Gemini API with automatic model fallback
 */
async function generateResponse(
  messages: Array<{ role: string; content: string }>,
  onUpdate?: (text: string, state?: "thinking" | "answering") => void
): Promise<string> {
  if (!checkApiKey()) {
    throw new Error("Gemini API key is not configured. Please set NEXT_PUBLIC_GEMINI_API_KEY environment variable.");
  }

  // Format messages for Gemini API
  const geminiMessages = formatMessagesForGemini(messages);

  // Try each model in order until one works
  let lastError: Error | null = null;
  
  for (const model of GEMINI_MODELS) {
    try {
      // Build the API URL (using non-streaming endpoint for simplicity, but we can add streaming later)
      const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
      
      const requestBody = {
        contents: geminiMessages,
        generationConfig: {
          temperature: 0.7,
          topK: 40,
          topP: 0.95,
          maxOutputTokens: 2048,
        },
      };

      const response = await fetch(apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorText = await response.text();
        let errorMessage = `Gemini API error: ${response.status} ${response.statusText}`;
        try {
          const errorJson = JSON.parse(errorText);
          errorMessage = errorJson.error?.message || errorMessage;
          
          // Check if it's a resource exhaustion error
          if (isResourceExhausted(new Error(errorMessage))) {
            console.warn(`[helper-client4] Model ${model} exhausted/unavailable, trying next model...`);
            lastError = new Error(errorMessage);
            continue; // Try next model
          }
        } catch {
          errorMessage = `${errorMessage} - ${errorText}`;
        }
        
        // If not a resource exhaustion error, throw immediately
        throw new Error(errorMessage);
      }

      const data = await response.json();
      
      // Extract text from response
      let fullText = "";
      if (data.candidates && data.candidates.length > 0) {
        const candidate = data.candidates[0];
        if (candidate.content && candidate.content.parts) {
          for (const part of candidate.content.parts) {
            if (part.text) {
              fullText += part.text;
            }
          }
        }
      }

      // Success! Log which model was used
      if (model !== GEMINI_MODELS[0]) {
        console.log(`[helper-client4] Successfully used fallback model: ${model}`);
      }

      // Update callback with final text
      if (onUpdate && fullText) {
        onUpdate(fullText, "answering");
      }

      return fullText || "I apologize, but I couldn't generate a response.";
    } catch (error) {
      // If it's a resource exhaustion error, try next model
      if (isResourceExhausted(error)) {
        console.warn(`[helper-client4] Model ${model} failed, trying next model...`);
        lastError = error instanceof Error ? error : new Error(String(error));
        continue;
      }
      
      // For other errors, throw immediately
      console.error(`[helper-client4] Error with model ${model}:`, error);
      if (error instanceof Error) {
        throw error;
      }
      throw new Error("An unknown error occurred while generating the response.");
    }
  }

  // All models failed
  const errorMessage = lastError 
    ? `All models exhausted. Last error: ${lastError.message}`
    : "All available models failed. Please try again later.";
  throw new Error(errorMessage);
}

/**
 * Answer a question using Gemini API
 * @param query - The user's question
 * @returns Promise resolving to the AI's response
 */
export async function answerQuestion(query: string): Promise<string> {
  if (!query || !query.trim()) {
    return "Please provide a question or message.";
  }

  if (!checkApiKey()) {
    return "Gemini API key is not configured. Please set NEXT_PUBLIC_GEMINI_API_KEY environment variable.";
  }

  try {
    // Convert single query to chat format
    const messages = [
      {
        role: "user" as const,
        content: query.trim(),
      },
    ];

    let fullResponse = "";
    const response = await generateResponse(messages, (text) => {
      fullResponse = text;
    });

    return response || fullResponse || "I apologize, but I couldn't generate a response.";
  } catch (error) {
    console.error("[helper-client4] Error generating response:", error);
    if (error instanceof Error) {
      return `Error: ${error.message}`;
    }
    return "An error occurred while generating the response. Please try again.";
  }
}

/**
 * Initialize the Gemini client (no-op for API-based client, but kept for consistency)
 */
export async function initialize(): Promise<void> {
  if (!checkApiKey()) {
    console.warn("[helper-client4] Gemini API key not found. Set NEXT_PUBLIC_GEMINI_API_KEY environment variable.");
  }
  console.log("[helper-client4] Gemini client ready (API-based, no initialization needed)");
}

/**
 * Check if Gemini API is supported (just checks for API key)
 */
export async function checkSupport(): Promise<boolean> {
  return checkApiKey();
}

/**
 * Reset the conversation (no-op for API-based client, but kept for consistency)
 */
export function resetConversation(): void {
  // No state to reset for API-based client
  console.log("[helper-client4] Conversation reset (no-op for API-based client)");
}

/**
 * Interrupt current generation (no-op for API-based client, but kept for consistency)
 */
export function interruptGeneration(): void {
  // Cannot interrupt API calls easily, but kept for API consistency
  console.warn("[helper-client4] Interrupt not supported for API-based client");
}

