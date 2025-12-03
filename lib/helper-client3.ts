"use client";

import {
  AutoTokenizer,
  AutoModelForCausalLM,
  TextStreamer,
  InterruptableStoppingCriteria,
} from "@huggingface/transformers";

const MODEL_ID = "onnx-community/DeepSeek-R1-Distill-Qwen-1.5B-ONNX";

/**
 * Singleton pattern for lazy-loading the pipeline
 */
class TextGenerationPipeline {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private static tokenizer: Promise<any> | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private static model: Promise<any> | null = null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  static async getInstance(progressCallback?: (progress: any) => void) {
    if (!this.tokenizer) {
      this.tokenizer = AutoTokenizer.from_pretrained(MODEL_ID, {
        progress_callback: progressCallback,
      });
    }

    if (!this.model) {
      this.model = AutoModelForCausalLM.from_pretrained(MODEL_ID, {
        dtype: "q4f16",
        device: "webgpu",
        progress_callback: progressCallback,
      });
    }

    return Promise.all([this.tokenizer, this.model]);
  }
}

const stoppingCriteria = new InterruptableStoppingCriteria();
// TODO: Add back when fixed - past_key_values cache for faster inference
// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
let pastKeyValuesCache: any = null;
let loadPromise: Promise<void> | null = null;

/**
 * Check if WebGPU is supported
 */
async function checkWebGPU(): Promise<boolean> {
  try {
    if (typeof navigator === "undefined" || !navigator.gpu) {
      return false;
    }
    const adapter = await navigator.gpu.requestAdapter();
    return adapter !== null;
  } catch (e) {
    console.error("[helper-client3] WebGPU check failed:", e);
    return false;
  }
}

/**
 * Initialize and warm up the model
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function initializeModel(progressCallback?: (progress: any) => void): Promise<void> {
  if (loadPromise) {
    return loadPromise;
  }

  loadPromise = (async () => {
    try {
      console.log("[helper-client3] Loading model...");

      const webGPUSupported = await checkWebGPU();
      if (!webGPUSupported) {
        throw new Error("WebGPU is not supported in this browser");
      }

      const [tokenizer, model] = await TextGenerationPipeline.getInstance(progressCallback);

      console.log("[helper-client3] Compiling shaders and warming up model...");

      // Run model with dummy input to compile shaders
      const dummyInputs = tokenizer("a");
      await model.generate({ ...dummyInputs, max_new_tokens: 1 });

      console.log("[helper-client3] Model ready");
    } catch (error) {
      loadPromise = null;
      console.error("[helper-client3] Failed to initialize model:", error);
      throw error;
    }
  })();

  return loadPromise;
}

/**
 * Extract thinking text from response
 */
function extractThinkingText(text: string): { thinking: string; answer: string } {
  if (!text) return { thinking: "", answer: "" };
  
  let thinking = "";
  let answer = text;
  
  // Extract thinking from <think>...</think> blocks
  const thinkMatch = text.match(/<think>([\s\S]*?)<\/think>/i);
  if (thinkMatch && thinkMatch[1]) {
    thinking = thinkMatch[1].trim();
    // Remove the thinking block from answer
    answer = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  }
  
  // Extract thinking from <think>...</think> blocks (alternative format)
  if (!thinking) {
    const reasoningMatch = text.match(/<think>([\s\S]*?)<\/redacted_reasoning>/i);
    if (reasoningMatch && reasoningMatch[1]) {
      thinking = reasoningMatch[1].trim();
      // Remove the reasoning block from answer
      answer = text.replace(/<think>[\s\S]*?<\/redacted_reasoning>/gi, "").trim();
    }
  }
  
  return { thinking, answer };
}

/**
 * Clean raw token patterns and format text
 */
function cleanRawTokens(text: string): string {
  if (!text) return text;
  
  let cleaned = text;
  
  // Remove patterns like "text<｜User｜>go to settings<｜Assistant｜>" completely
  // This removes everything between and including the tokens
  cleaned = cleaned.replace(/<\|redacted_User\|>[^]*?<\|redacted_Assistant\|>/gi, "");
  cleaned = cleaned.replace(/<\|redacted_Assistant\|>[^]*?<\|redacted_User\|>/gi, "");
  
  // Remove text before the first raw token marker (like "MCP: ... " before the token)
  cleaned = cleaned.replace(/^[^<]*<\|redacted_User\|>/gi, "");
  cleaned = cleaned.replace(/^[^<]*<\|redacted_Assistant\|>/gi, "");
  
  // Remove raw token patterns anywhere (these are metadata tokens, not content)
  cleaned = cleaned.replace(/<\|redacted_User\|>/gi, "");
  cleaned = cleaned.replace(/<\|redacted_Assistant\|>/gi, "");
  cleaned = cleaned.replace(/<\|redacted_reasoning\|>/gi, "");
  cleaned = cleaned.replace(/<\|think\|>/gi, "");
  cleaned = cleaned.replace(/<\|reasoning\|>/gi, "");
  
  // Remove any remaining standalone thinking tags
  cleaned = cleaned.replace(/<think>/gi, "");
  cleaned = cleaned.replace(/<\/think>/gi, "");
  cleaned = cleaned.replace(/<think>/gi, "");
  cleaned = cleaned.replace(/<\/redacted_reasoning>/gi, "");
  cleaned = cleaned.replace(/<reasoning>/gi, "");
  cleaned = cleaned.replace(/<\/reasoning>/gi, "");
  
  // Clean up multiple newlines and spaces
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n");
  cleaned = cleaned.replace(/[ \t]+/g, " ");
  
  // Trim whitespace
  cleaned = cleaned.trim();
  
  return cleaned;
}

/**
 * Generate response from messages using DeepSeek R1
 */
async function generateResponse(
  messages: Array<{ role: string; content: string }>,
  onUpdate?: (text: string, state?: "thinking" | "answering") => void
): Promise<string> {
  await initializeModel();

  const [tokenizer, model] = await TextGenerationPipeline.getInstance();

  const inputs = tokenizer.apply_chat_template(messages, {
    add_generation_prompt: true,
    return_dict: true,
  });

  // Token IDs for thinking markers
  // 151648: <think>
  // 151649: </think>
  const thinkingTokens = tokenizer.encode(
    "<think></think>",
    { add_special_tokens: false }
  );
  // The end thinking token is the last token in the encoded sequence
  const END_THINKING_TOKEN_ID = thinkingTokens.length > 0 ? thinkingTokens[thinkingTokens.length - 1] : null;

  let state: "thinking" | "answering" = "thinking";
  let generatedText = "";
  let thinkingText = "";

  const tokenCallbackFunction = (tokens: bigint[] | number[]) => {
    const firstToken = tokens && tokens.length > 0 ? Number(tokens[0]) : null;
    if (END_THINKING_TOKEN_ID !== null && firstToken !== null && firstToken === END_THINKING_TOKEN_ID) {
      state = "answering";
      // Extract thinking text before switching state
      const extracted = extractThinkingText(generatedText);
      thinkingText = extracted.thinking;
    }
  };

  const callbackFunction = (output: string) => {
    generatedText = output;
    
    if (state === "answering") {
      // Extract thinking and answer parts
      const extracted = extractThinkingText(output);
      
      // Clean raw tokens from answer
      let answer = cleanRawTokens(extracted.answer);
      
      // If we have thinking text, prepend it (show thinking text as-is)
      if (extracted.thinking || thinkingText) {
        const thinking = extracted.thinking || thinkingText;
        const cleanedThinking = cleanRawTokens(thinking);
        if (cleanedThinking) {
          answer = `${cleanedThinking}\n\n${answer}`;
        }
      }
      
      if (onUpdate) {
        onUpdate(answer, state);
      }
    } else {
      // Still thinking - extract thinking text if available
      const extracted = extractThinkingText(output);
      if (extracted.thinking) {
        const cleanedThinking = cleanRawTokens(extracted.thinking);
        if (onUpdate && cleanedThinking) {
          onUpdate(cleanedThinking, state);
        }
      } else if (onUpdate) {
        onUpdate("", state);
      }
    }
  };

  const streamer = new TextStreamer(tokenizer, {
    skip_prompt: true,
    skip_special_tokens: true,
    callback_function: callbackFunction,
    token_callback_function: tokenCallbackFunction,
  });

  const { past_key_values, sequences } = await model.generate({
    ...inputs,
    // TODO: Add back when fixed
    // past_key_values: past_key_values_cache,

    // Sampling
    do_sample: false,
    max_new_tokens: 2048,
    streamer,
    stopping_criteria: stoppingCriteria,
    return_dict_in_generate: true,
  });

  pastKeyValuesCache = past_key_values;

  const decoded = tokenizer.batch_decode(sequences, {
    skip_special_tokens: true,
  });

  // Get the final decoded text
  let finalText = decoded[0] || generatedText || "";
  
  // First, clean raw tokens from the entire text
  finalText = cleanRawTokens(finalText);
  
  // Extract thinking and answer parts from cleaned text
  const extracted = extractThinkingText(finalText);
  
  // Clean raw tokens from both parts again (in case extraction reintroduced issues)
  const thinking = cleanRawTokens(extracted.thinking);
  const answer = cleanRawTokens(extracted.answer);
  
  // Combine: show thinking text if available, then answer
  if (thinking) {
    finalText = `${thinking}\n\n${answer}`;
  } else {
    finalText = answer;
  }
  
  // Final cleanup pass to ensure no raw tokens remain
  finalText = cleanRawTokens(finalText);
  
  return finalText;
}

/**
 * Reset the conversation cache
 */
export function resetConversation(): void {
  pastKeyValuesCache = null;
  stoppingCriteria.reset();
}

/**
 * Interrupt current generation
 */
export function interruptGeneration(): void {
  stoppingCriteria.interrupt();
}

/**
 * Answer a question using DeepSeek R1 AI inference only
 * @param query - The user's question
 * @returns Promise resolving to the AI's response
 */
export async function answerQuestion(query: string): Promise<string> {
  if (!query || !query.trim()) {
    return "Please provide a question or message.";
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
    console.error("[helper-client3] Error generating response:", error);
    if (error instanceof Error) {
      if (error.message.includes("WebGPU")) {
        return "WebGPU is not supported in your browser. Please use a browser that supports WebGPU (Chrome 113+, Edge 113+, or Opera 99+).";
      }
      return `Error: ${error.message}`;
    }
    return "An error occurred while generating the response. Please try again.";
  }
}

/**
 * Initialize the model (call this early to start loading)
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function initialize(progressCallback?: (progress: any) => void): Promise<void> {
  return initializeModel(progressCallback);
}

/**
 * Check if WebGPU is supported
 */
export async function checkSupport(): Promise<boolean> {
  return checkWebGPU();
}

