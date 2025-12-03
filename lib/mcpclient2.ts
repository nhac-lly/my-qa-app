"use client";

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * MCP Client 2 for Arobid MCP Server
 * Uses the MCP server configuration from mcp.json
 * Designed to work with assistant-ui and make tools available
 */

// MCP Server configuration from mcp.json
const AROBID_MCP_URL = "https://hao-mcp.vercel.app/mcp";
const AROBID_BACKEND_URL = "https://gw-prod.arobid.com";

// Cache configuration
const CACHE_TTL = 60 * 60 * 1000; // 1 hour in milliseconds
const CACHE_KEYS = {
  TOOLS_LIST: "mcp_tools_list",
  TOOL_RESULT: "mcp_tool_result_",
};

interface CachedData<T> {
  data: T;
  timestamp: number;
}

/**
 * Get cached data from localStorage
 */
function getCachedData<T>(key: string): T | null {
  if (typeof window === "undefined") return null;
  
  try {
    const cached = localStorage.getItem(key);
    if (!cached) return null;
    
    const parsed: CachedData<T> = JSON.parse(cached);
    const now = Date.now();
    
    // Check if cache is expired
    if (now - parsed.timestamp > CACHE_TTL) {
      localStorage.removeItem(key);
      return null;
    }
    
    return parsed.data;
  } catch (error) {
    console.warn(`[mcpclient2] Failed to get cached data for ${key}:`, error);
    return null;
  }
}

/**
 * Set cached data in localStorage
 */
function setCachedData<T>(key: string, data: T): void {
  if (typeof window === "undefined") return;
  
  try {
    const cached: CachedData<T> = {
      data,
      timestamp: Date.now(),
    };
    localStorage.setItem(key, JSON.stringify(cached));
  } catch (error) {
    console.warn(`[mcpclient2] Failed to cache data for ${key}:`, error);
    // If storage is full, try to clear old entries
    try {
      clearExpiredCache();
      localStorage.setItem(key, JSON.stringify({ data, timestamp: Date.now() }));
    } catch (e) {
      console.error(`[mcpclient2] Failed to cache data after cleanup:`, e);
    }
  }
}

/**
 * Clear expired cache entries
 */
function clearExpiredCache(): void {
  if (typeof window === "undefined") return;
  
  try {
    const now = Date.now();
    const keysToRemove: string[] = [];
    
    // Check all localStorage keys that start with our cache prefix
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || (!key.startsWith(CACHE_KEYS.TOOLS_LIST) && !key.startsWith(CACHE_KEYS.TOOL_RESULT))) {
        continue;
      }
      
      try {
        const cached = localStorage.getItem(key);
        if (cached) {
          const parsed: CachedData<unknown> = JSON.parse(cached);
          if (now - parsed.timestamp > CACHE_TTL) {
            keysToRemove.push(key);
          }
        }
      } catch {
        // Invalid cache entry, remove it
        keysToRemove.push(key);
      }
    }
    
    keysToRemove.forEach(key => localStorage.removeItem(key));
  } catch (error) {
    console.warn("[mcpclient2] Failed to clear expired cache:", error);
  }
}

/**
 * Generate cache key for tool result
 */
function getToolResultCacheKey(toolName: string, args: Record<string, unknown>): string {
  // Create a hash of the args to ensure unique cache keys
  const argsHash = JSON.stringify(args);
  return `${CACHE_KEYS.TOOL_RESULT}${toolName}_${argsHash}`;
}

interface MCPRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface MCPResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface MCPTool {
  name: string;
  description?: string;
  inputSchema?: {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

/**
 * Parse Server-Sent Events (SSE) format text
 */
function parseSSEText(text: string): MCPResponse {
  text = text.trim();
  
  if (text.startsWith("data: ")) {
    const jsonData = text.substring(6);
    try {
      return JSON.parse(jsonData) as MCPResponse;
    } catch (error) {
      console.error("[mcpclient2] Failed to parse SSE data:", jsonData.substring(0, 200));
      throw new Error(`Failed to parse SSE response: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  
  const lines = text.split("\n");
  let jsonData = "";
  let inDataBlock = false;
  
  for (const line of lines) {
    if (line.startsWith("data: ")) {
      const data = line.substring(6);
      jsonData = inDataBlock ? jsonData + "\n" + data : data;
      inDataBlock = true;
    } else if (line.trim() === "" && inDataBlock) {
      break;
    } else if (inDataBlock && !line.startsWith("event:") && !line.startsWith("id:") && line.trim() !== "") {
      jsonData += "\n" + line;
    }
  }
  
  if (!jsonData) {
    throw new Error("No data found in SSE response");
  }
  
  try {
    return JSON.parse(jsonData) as MCPResponse;
  } catch (error) {
    console.error("[mcpclient2] Failed to parse SSE data as JSON:", jsonData.substring(0, 500));
    throw new Error(`Failed to parse SSE response: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Parse response text - handles both JSON and SSE formats
 */
function parseMCPResponseFromText(text: string, contentType: string): MCPResponse {
  if (!text || text.trim().length === 0) {
    throw new Error("Response body is empty");
  }
  
  if (text.startsWith("event:") || text.includes("data: ")) {
    return parseSSEText(text);
  }
  
  try {
    return JSON.parse(text) as MCPResponse;
  } catch (error) {
    if (contentType.includes("text/event-stream") || contentType.includes("text/plain")) {
      return parseSSEText(text);
    }
    throw new Error(`Failed to parse JSON response: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Read SSE stream and extract JSON-RPC response
 */
async function readSSEStream(reader: ReadableStreamDefaultReader<Uint8Array>, requestId: string | number): Promise<MCPResponse> {
  const decoder = new TextDecoder();
  let buffer = "";
  let dataBuffer = "";
  let inDataBlock = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || ""; // Keep incomplete line in buffer

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.substring(6);
          if (inDataBlock) {
            dataBuffer += "\n" + data;
          } else {
            dataBuffer = data;
            inDataBlock = true;
          }
        } else if (line.trim() === "" && inDataBlock) {
          // End of SSE message, try to parse
          try {
            const parsed = JSON.parse(dataBuffer) as MCPResponse;
            // Check if this is the response for our request
            if (parsed.id === requestId || parsed.id === String(requestId)) {
              return parsed;
            }
            // Reset for next message
            dataBuffer = "";
            inDataBlock = false;
          } catch (e) {
            // Not valid JSON yet, continue accumulating
          }
        } else if (inDataBlock && line.trim() !== "" && !line.startsWith("event:") && !line.startsWith("id:")) {
          // Continuation of JSON data
          dataBuffer += "\n" + line;
        }
      }
    }

    // Try to parse any remaining data
    if (dataBuffer) {
      try {
        const parsed = JSON.parse(dataBuffer) as MCPResponse;
        if (parsed.id === requestId || parsed.id === String(requestId)) {
          return parsed;
        }
      } catch (e) {
        // Ignore parse errors for incomplete data
      }
    }

    throw new Error("No valid response found in SSE stream");
  } finally {
    reader.releaseLock();
  }
}

/**
 * Make an MCP JSON-RPC request using SSE stream
 */
async function makeMCPRequest(
  method: string,
  params?: Record<string, unknown>
): Promise<MCPResponse> {
  // Use integer ID as JSON-RPC spec recommends
  // Use timestamp + random component to ensure uniqueness
  const requestId = Date.now();
  
  // Build request according to JSON-RPC 2.0 spec
  // Params is optional - only include if provided and not empty
  const request: MCPRequest = {
    jsonrpc: "2.0",
    id: requestId,
    method,
  };
  
  // Add params only if they exist and are not empty
  if (params !== undefined && params !== null && Object.keys(params).length > 0) {
    request.params = params;
  }

  // Validate JSON before sending
  let requestBody: string;
  try {
    requestBody = JSON.stringify(request);
    // Verify it's valid JSON by parsing it back
    const parsed = JSON.parse(requestBody);
    
    // Additional validation: ensure request conforms to JSON-RPC 2.0
    if (parsed.jsonrpc !== "2.0") {
      throw new Error("Invalid jsonrpc version - must be '2.0'");
    }
    if (typeof parsed.id !== "string" && typeof parsed.id !== "number") {
      throw new Error(`Invalid id type - must be string or number, got ${typeof parsed.id}`);
    }
    if (typeof parsed.method !== "string") {
      throw new Error(`Invalid method type - must be string, got ${typeof parsed.method}`);
    }
    
    console.log("[mcpclient2] Making MCP request:", {
      method,
      requestId,
      params: params || "none",
      body: requestBody,
      bodyLength: requestBody.length,
      validatedJsonrpc: parsed.jsonrpc,
      validatedId: parsed.id,
      validatedMethod: parsed.method,
    });
  } catch (jsonError) {
    console.error("[mcpclient2] Invalid JSON request:", request, jsonError);
    throw new Error(`Failed to create valid JSON-RPC request: ${jsonError instanceof Error ? jsonError.message : String(jsonError)}`);
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
    "Accept": "application/json, text/event-stream",
    "X-Arobid-Backend-Url": AROBID_BACKEND_URL,
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  try {
    // Ensure requestBody is a proper string and not corrupted
    if (typeof requestBody !== "string") {
      throw new Error(`Request body must be a string, got ${typeof requestBody}`);
    }
    
    // Log the exact bytes being sent (first 500 chars for debugging)
    console.log("[mcpclient2] Sending request body (first 500 chars):", requestBody.substring(0, 500));
    
    const response = await fetch(AROBID_MCP_URL, {
      method: "POST",
      headers,
      body: requestBody,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      // Read error response - try to get detailed error info
      let errorText = "";
      const contentType = response.headers.get("content-type") || "";
      
      try {
        // Clone response to read it without consuming the body
        const responseClone = response.clone();
        errorText = await responseClone.text();
        
        console.error("[mcpclient2] Error response raw text:", errorText);
        console.error("[mcpclient2] Error response headers:", Object.fromEntries(response.headers.entries()));
        
        // Try to parse as JSON-RPC error if it looks like JSON
        if (errorText.trim().startsWith("{") || contentType.includes("application/json") || contentType.includes("text/event-stream")) {
          try {
            // Try parsing as JSON first
            let errorData;
            if (errorText.trim().startsWith("data: ")) {
              // SSE format
              const jsonData = errorText.trim().startsWith("data: ") 
                ? errorText.substring(6).trim()
                : errorText.trim();
              errorData = JSON.parse(jsonData);
            } else {
              errorData = JSON.parse(errorText);
            }
            
            if (errorData.error) {
              errorText = JSON.stringify(errorData, null, 2);
              console.error("[mcpclient2] Parsed JSON-RPC error:", errorData);
            }
          } catch (e) {
            console.error("[mcpclient2] Failed to parse error as JSON:", e);
            // Not JSON, use raw text
          }
        }
      } catch (e) {
        errorText = `Failed to read error response: ${e instanceof Error ? e.message : String(e)}`;
        console.error("[mcpclient2] Error reading error response:", e);
      }
      
      console.error("[mcpclient2] MCP request failed - Full details:", {
        status: response.status,
        statusText: response.statusText,
        contentType,
        error: errorText,
        requestBody: requestBody,
        requestBodyBytes: new TextEncoder().encode(requestBody).length,
        requestId,
        requestIdType: typeof requestId,
        method,
        params: params || "none",
        headersSent: headers,
      });
      
      throw new Error(`MCP request failed: ${response.status} ${response.statusText} - ${errorText}`);
    }

    // MCP server uses SSE streams - always read as event stream
    // Accept header includes both formats, but we always process as SSE
    if (!response.body) {
      throw new Error("Response body is null");
    }

    // Always read as SSE stream for MCP responses
    const reader = response.body.getReader();
    const data = await readSSEStream(reader, requestId);

    if (data.error) {
      throw new Error(`MCP error: ${data.error.message} (code: ${data.error.code})`);
    }

    return data;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Request timed out");
    }
    throw error;
  }
}

/**
 * List available tools from the MCP server
 */
let cachedTools: MCPTool[] | null = null;
let toolsCacheTime: number = 0;
const TOOLS_CACHE_TTL = 60000; // 1 minute cache

export async function listMCPTools(): Promise<MCPTool[]> {
  // Check in-memory cache first
  const now = Date.now();
  if (cachedTools !== null && (now - toolsCacheTime) < TOOLS_CACHE_TTL) {
    return cachedTools;
  }

  // Check localStorage cache
  const cachedToolsList = getCachedData<MCPTool[]>(CACHE_KEYS.TOOLS_LIST);
  if (cachedToolsList) {
    cachedTools = cachedToolsList;
    toolsCacheTime = now;
    return cachedToolsList;
  }

  try {
    const response = await makeMCPRequest("tools/list");
    
    let toolsArray: MCPTool[] = [];
    
    if (Array.isArray(response.result)) {
      toolsArray = response.result as MCPTool[];
    } else if (response.result && typeof response.result === "object" && "tools" in response.result) {
      const toolsObj = response.result as { tools?: MCPTool[] };
      toolsArray = toolsObj.tools || [];
    }
    
    // Update in-memory cache
    cachedTools = toolsArray;
    toolsCacheTime = Date.now();
    
    // Update localStorage cache
    setCachedData(CACHE_KEYS.TOOLS_LIST, toolsArray);
    
    return toolsArray;
  } catch (error) {
    console.error("[mcpclient2] Error listing MCP tools:", error);
    // Return cached data even if request fails
    if (cachedTools !== null) {
      return cachedTools;
    }
    return [];
  }
}

/**
 * Call an MCP tool
 */
export async function callMCPTool(
  toolName: string,
  args: Record<string, unknown> = {}
): Promise<unknown> {
  // Check localStorage cache first
  const cacheKey = getToolResultCacheKey(toolName, args);
  const cachedResult = getCachedData<unknown>(cacheKey);
  if (cachedResult !== null) {
    console.log(`[mcpclient2] Using cached result for tool: ${toolName}`);
    return cachedResult;
  }

  try {
    // Format params according to MCP spec for tools/call
    // Only include arguments if it has at least one property
    const params: Record<string, unknown> = {
      name: toolName,
    };
    
    // Only add arguments if args is not empty
    if (args && Object.keys(args).length > 0) {
      params.arguments = args;
    }
    
    console.log(`[mcpclient2] Calling MCP tool: ${toolName} with args:`, args);
    console.log(`[mcpclient2] Formatted params for tools/call:`, params);
    
    const response = await makeMCPRequest("tools/call", params);

    console.log(`[mcpclient2] Tool ${toolName} result:`, response.result);
    
    // Cache the result in localStorage
    if (response.result !== undefined) {
      setCachedData(cacheKey, response.result);
    }
    
    return response.result;
  } catch (error) {
    console.error(`[mcpclient2] Error calling MCP tool ${toolName}:`, error);
    throw error;
  }
}

/**
 * Get tool definitions formatted for assistant-ui/AI SDK
 * This converts MCP tools to a format that can be used with assistant-ui
 */
export async function getMCPToolsForAssistant(): Promise<Record<string, any>> {
  const tools = await listMCPTools();
  
  const toolDefinitions: Record<string, any> = {};
  
  for (const tool of tools) {
    toolDefinitions[tool.name] = {
      description: tool.description || `Execute the ${tool.name} tool`,
      parameters: tool.inputSchema || {
        type: "object",
        properties: {},
      },
      execute: async (args: Record<string, unknown>) => {
        return await callMCPTool(tool.name, args);
      },
    };
  }
  
  return toolDefinitions;
}

/**
 * Check if MCP tools are available
 */
export async function hasMCPTools(): Promise<boolean> {
  try {
    const tools = await listMCPTools();
    return tools.length > 0;
  } catch (error) {
    console.error("[mcpclient2] Error checking MCP tools:", error);
    return false;
  }
}

/**
 * Get tool names as a simple array
 */
export async function getMCPToolNames(): Promise<string[]> {
  const tools = await listMCPTools();
  return tools.map((tool) => tool.name);
}

