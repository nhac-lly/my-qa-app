/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * MCP Client for Arobid MCP Server
 * Handles communication with the Arobid MCP server using JSON-RPC 2.0 protocol
 * 
 * This implementation uses direct HTTP/SSE requests which is appropriate for web applications.
 * For reference, see: https://modelcontextprotocol.io/clients
 * 
 * Note: Most MCP clients in the official list are standalone desktop/IDE applications.
 * For web apps, direct HTTP/SSE implementation (like this) or the official @modelcontextprotocol/sdk
 * are the recommended approaches.
 */

// Client-side environment variables - use Next.js public env vars or defaults
const AROBID_MCP_URL = 
  (typeof window !== "undefined" && (window as any).__AROBID_MCP_URL__) ||
  (typeof process !== "undefined" && process.env.NEXT_PUBLIC_AROBID_MCP_URL) ||
  "https://hao-mcp.vercel.app/mcp";
const AROBID_BACKEND_URL = 
  (typeof window !== "undefined" && (window as any).__AROBID_BACKEND_URL__) ||
  (typeof process !== "undefined" && process.env.NEXT_PUBLIC_AROBID_BACKEND_URL) ||
  "https://gw-prod.arobid.com";

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

/**
 * Parse Server-Sent Events (SSE) format text
 * SSE format: event: <event_type>\ndata: <json_data>\n\n
 * Also handles single-line format: data: <json_data>
 */
function parseSSEText(text: string): MCPResponse {
  // Trim the text first
  text = text.trim();
  
  // Handle single-line format: "data: {...}"
  if (text.startsWith("data: ")) {
    const jsonData = text.substring(6); // Remove "data: " prefix
    try {
      const parsed = JSON.parse(jsonData) as MCPResponse;
      console.log("[mcp-client] Successfully parsed single-line SSE response");
      return parsed;
    } catch (error) {
      console.error("[mcp-client] Failed to parse single-line SSE data as JSON:", jsonData.substring(0, 200));
      throw new Error(`Failed to parse SSE response: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  
  // Handle multi-line SSE format
  const lines = text.split("\n");
  
  let jsonData = "";
  let inDataBlock = false;
  
  for (const line of lines) {
    if (line.startsWith("data: ")) {
      const data = line.substring(6); // Remove "data: " prefix
      if (inDataBlock) {
        // Multiple data blocks - append with newline
        jsonData += "\n" + data;
      } else {
        jsonData = data;
        inDataBlock = true;
      }
    } else if (line.trim() === "" && inDataBlock) {
      // Empty line after data block - end of message
      break;
    } else if (inDataBlock && !line.startsWith("event:") && !line.startsWith("id:") && line.trim() !== "") {
      // Continuation of JSON data (multi-line JSON)
      jsonData += "\n" + line;
    }
  }
  
  if (!jsonData) {
    console.error("[mcp-client] No data found in SSE response. Text:", text.substring(0, 200));
    throw new Error("No data found in SSE response");
  }
  
  try {
    const parsed = JSON.parse(jsonData) as MCPResponse;
    console.log("[mcp-client] Successfully parsed multi-line SSE response");
    return parsed;
  } catch (error) {
    console.error("[mcp-client] Failed to parse SSE data as JSON:", jsonData.substring(0, 500));
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
  
  // Check if it's SSE format by content
  if (text.startsWith("event:") || text.includes("data: ")) {
    try {
      return parseSSEText(text);
    } catch (error) {
      throw new Error(`Failed to parse SSE response: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  
  // Try to parse as JSON
  try {
    return JSON.parse(text) as MCPResponse;
  } catch (error) {
    // If JSON parsing fails but content-type suggests SSE, try SSE format
    if (contentType.includes("text/event-stream") || contentType.includes("text/plain")) {
      try {
        return parseSSEText(text);
      } catch (sseError) {
        throw new Error(`Failed to parse response as both JSON and SSE: JSON error: ${error instanceof Error ? error.message : String(error)}, SSE error: ${sseError instanceof Error ? sseError.message : String(sseError)}`);
      }
    }
    // Re-throw original error with more context
    throw new Error(`Failed to parse JSON response: ${error instanceof Error ? error.message : String(error)}. Response preview: ${text.substring(0, 200)}`);
  }
}

/**
 * Call an MCP tool on the Arobid server
 */
export async function callMCPTool(
  toolName: string,
  params: Record<string, unknown> = {}
): Promise<unknown> {
  try {
    const request: MCPRequest = {
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: {
        name: toolName,
        arguments: params,
      },
    };

    const headers = {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "X-Arobid-Backend-Url": AROBID_BACKEND_URL,
    };

    console.log("[mcp-client] Making MCP request:", {
      url: AROBID_MCP_URL,
      headers,
      method: "tools/call",
      toolName,
    });

    let response: Response;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    try {
      // Create abort controller for timeout
      const controller = new AbortController();
      timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout
      
      response = await fetch(AROBID_MCP_URL, {
        method: "POST",
        headers,
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
    } catch (fetchError) {
      // Clean up timeout if still active
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      
      // Handle network errors
      if (fetchError instanceof TypeError && fetchError.message.includes("fetch")) {
        console.error(`[mcp-client] Network error when calling MCP tool ${toolName}:`, fetchError.message);
        throw new Error(`Network error: ${fetchError.message}`);
      }
      if (fetchError instanceof Error && fetchError.name === "AbortError") {
        console.error(`[mcp-client] MCP tool call ${toolName} timed out after 30 seconds`);
        throw new Error("Request timed out");
      }
      throw fetchError;
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      console.error(`[mcp-client] MCP request failed: ${response.status} ${response.statusText}`, errorText);
      throw new Error(`MCP request failed: ${response.status} ${response.statusText} - ${errorText}`);
    }

    // Read response text first
    const responseText = await response.text().catch(() => {
      throw new Error("Failed to read response body");
    });

    if (!responseText) {
      throw new Error("Response body is empty");
    }

    // Parse the response
    const contentType = response.headers.get("content-type") || "";
    let data: MCPResponse;
    try {
      data = parseMCPResponseFromText(responseText, contentType);
    } catch (parseError) {
      console.error(`[mcp-client] Failed to parse MCP response for tool ${toolName}:`, parseError);
      console.error("[mcp-client] Response content:", responseText.substring(0, 500));
      throw new Error(`Failed to parse response: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
    }

    if (data.error) {
      console.error(`[mcp-client] MCP server returned error for tool ${toolName}: ${data.error.message} (code: ${data.error.code})`);
      if (data.error.data) {
        console.error("[mcp-client] Error data:", data.error.data);
      }
      throw new Error(`MCP error: ${data.error.message} (code: ${data.error.code})`);
    }

    return data.result;
  } catch (error) {
    console.error(`[mcp-client] Error calling MCP tool ${toolName}:`, error);
    if (error instanceof Error) {
      console.error("[mcp-client] Error details:", {
        name: error.name,
        message: error.message,
        stack: error.stack,
      });
    }
    throw error;
  }
}

/**
 * Cache for MCP tools to avoid repeated calls
 */
let cachedTools: string[] | null = null;
let toolsCacheTime: number = 0;
const TOOLS_CACHE_TTL = 60000; // 1 minute cache

/**
 * List available tools from the MCP server
 */
export async function listMCPTools(): Promise<string[]> {
  // Return cached tools if available and not expired
  const now = Date.now();
  if (cachedTools !== null && (now - toolsCacheTime) < TOOLS_CACHE_TTL) {
    console.log("[mcp-client] Returning cached MCP tools:", cachedTools);
    return cachedTools;
  }
  try {
    const request: MCPRequest = {
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/list",
    };

    const headers = {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "X-Arobid-Backend-Url": AROBID_BACKEND_URL,
    };

    console.log("[mcp-client] Making MCP request:", {
      url: AROBID_MCP_URL,
      headers,
      method: "tools/list",
    });

    let response: Response;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    try {
      // Create abort controller for timeout
      const controller = new AbortController();
      timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout
      
      response = await fetch(AROBID_MCP_URL, {
        method: "POST",
        headers,
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
    } catch (fetchError) {
      // Clean up timeout if still active
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      
      // Handle network errors (CORS, connection refused, timeout, etc.)
      if (fetchError instanceof TypeError && fetchError.message.includes("fetch")) {
        console.error("[mcp-client] Network error when calling MCP server:", fetchError.message);
        console.error("[mcp-client] This could be due to:", {
          cors: "CORS policy blocking the request",
          connection: "MCP server is not reachable",
          timeout: "Request timed out",
          url: AROBID_MCP_URL,
        });
        return [];
      }
      if (fetchError instanceof Error && fetchError.name === "AbortError") {
        console.error("[mcp-client] MCP request timed out after 30 seconds");
        return [];
      }
      throw fetchError;
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      console.error(`[mcp-client] MCP request failed: ${response.status} ${response.statusText}`, errorText);
      console.error("[mcp-client] Response headers:", Object.fromEntries(response.headers.entries()));
      return [];
    }

    // Read response text first so we can log it if parsing fails
    const responseText = await response.text().catch(() => {
      console.error("[mcp-client] Failed to read response body");
      return "";
    });

    if (!responseText) {
      console.error("[mcp-client] Response body is empty");
      return [];
    }

    let data: MCPResponse;
    try {
      // Parse the response text
      const contentType = response.headers.get("content-type") || "";
      data = parseMCPResponseFromText(responseText, contentType);
    } catch (parseError) {
      console.error("[mcp-client] Failed to parse MCP response:", parseError);
      console.error("[mcp-client] Response content:", responseText.substring(0, 500));
      return [];
    }

    if (data.error) {
      console.error(`[mcp-client] MCP server returned error: ${data.error.message} (code: ${data.error.code})`);
      if (data.error.data) {
        console.error("[mcp-client] Error data:", data.error.data);
      }
      return [];
    }

    // Extract tool names from the result
    // Handle both direct tools array and nested structure
    let toolsArray: Array<{ name: string }> | undefined;
    
    if (Array.isArray(data.result)) {
      // Result is directly an array of tools
      toolsArray = data.result;
    } else if (data.result && typeof data.result === "object" && "tools" in data.result) {
      // Result has a tools property
      const toolsObj = data.result as { tools?: Array<{ name: string }> };
      toolsArray = toolsObj.tools;
    }
    
    if (!toolsArray || !Array.isArray(toolsArray) || toolsArray.length === 0) {
      console.warn("[mcp-client] MCP response does not contain tools array. Result structure:", {
        resultType: typeof data.result,
        isArray: Array.isArray(data.result),
        resultKeys: data.result && typeof data.result === "object" ? Object.keys(data.result) : [],
        resultPreview: JSON.stringify(data.result).substring(0, 200),
      });
      return [];
    }
    
    const toolNames = toolsArray
      .map((tool) => (typeof tool === "string" ? tool : tool.name))
      .filter((name): name is string => typeof name === "string" && name.length > 0);
    console.log("[mcp-client] Successfully retrieved MCP tools:", toolNames);
    
    // Cache the tools
    cachedTools = toolNames;
    toolsCacheTime = Date.now();
    
    return toolNames;
  } catch (error) {
    console.error("[mcp-client] Unexpected error listing MCP tools:", error);
    if (error instanceof Error) {
      console.error("[mcp-client] Error details:", {
        name: error.name,
        message: error.message,
        stack: error.stack,
      });
    }
    return [];
  }
}

/**
 * Detect if a query is related to Arobid features
 * Exported so it can be used in helper.ts to skip FAQ matching
 */
export function isArobidRelatedQuery(query: string): boolean {
  const normalized = query.toLowerCase();
  const arobidKeywords = [
    "arobid",
    "account",
    "login",
    "password",
    "register",
    "sign up",
    "signup",
    "verify",
    "otp",
    "reset password",
    "forgot password",
    "create account",
    "user account",
  ];
  return arobidKeywords.some((keyword) => normalized.includes(keyword));
}

/**
 * Query the Arobid MCP server as an autonomous agent
 * This function intelligently routes queries to appropriate MCP tools and executes actions
 * In a Next.js web app, we make HTTP requests to the MCP server
 */
/**
 * Check if MCP tools are available (uses cache)
 */
export async function hasMCPTools(): Promise<boolean> {
  try {
    const tools = await listMCPTools();
    return tools.length > 0;
  } catch (error) {
    console.error("[mcp-client] Error checking MCP tools:", error);
    return false;
  }
}

export async function queryArobidMCP(query: string): Promise<string | null> {
  try {
    console.log("[mcp-client] queryArobidMCP called with query:", query);
    
    // Check if query is related to Arobid features
    if (!isArobidRelatedQuery(query)) {
      console.log("[mcp-client] Query not related to Arobid features");
      return null;
    }

    console.log("[mcp-client] Query is Arobid-related, checking MCP tools...");
    
    // Check if MCP tools are available
    const toolsAvailable = await hasMCPTools();
    
    if (!toolsAvailable) {
      console.log("[mcp-client] No MCP tools available, returning null to fallback to FAQ");
      return null;
    }

    console.log("[mcp-client] MCP tools are available. MCP should handle this query.");
    // MCP tools are available - return null to indicate MCP should handle this
    // The helper functions will check if MCP tools are available and handle accordingly
    return null;
  } catch (error) {
    console.error("[mcp-client] Unexpected error in queryArobidMCP:", error);
    if (error instanceof Error) {
      console.error("[mcp-client] Error details:", {
        name: error.name,
        message: error.message,
        stack: error.stack?.substring(0, 500),
      });
    }
    // Return null on error to allow fallback to default answer
    return null;
  }
}

