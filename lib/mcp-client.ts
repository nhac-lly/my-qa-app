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

const AROBID_MCP_URL = process.env.AROBID_MCP_URL || "https://hao-mcp.vercel.app/mcp";
const AROBID_BACKEND_URL = process.env.AROBID_BACKEND_URL || "https://gw-prod.arobid.com";

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
 */
function parseSSEText(text: string): MCPResponse {
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
    throw new Error("No data found in SSE response");
  }
  
  try {
    return JSON.parse(jsonData) as MCPResponse;
  } catch (error) {
    console.error("[mcp-client] Failed to parse SSE data as JSON:", jsonData);
    throw new Error(`Failed to parse SSE response: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Parse response - handles both JSON and SSE formats
 */
async function parseMCPResponse(response: Response): Promise<MCPResponse> {
  const contentType = response.headers.get("content-type") || "";
  
  // Read response as text first (can only read once)
  const text = await response.text();
  
  // Check if it's SSE format by content
  if (text.startsWith("event:") || text.includes("data: ")) {
    return parseSSEText(text);
  }
  
  // Try to parse as JSON
  try {
    return JSON.parse(text) as MCPResponse;
  } catch (error) {
    // If JSON parsing fails but content-type suggests SSE, try SSE format
    if (contentType.includes("text/event-stream") || contentType.includes("text/plain")) {
      return parseSSEText(text);
    }
    // Re-throw original error
    throw new Error(`Failed to parse response: ${error instanceof Error ? error.message : String(error)}`);
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

    const response = await fetch(AROBID_MCP_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      console.error(`[mcp-client] MCP request failed: ${response.status} ${response.statusText}`, errorText);
      throw new Error(`MCP request failed: ${response.status} ${response.statusText} - ${errorText}`);
    }

    const data = await parseMCPResponse(response);

    if (data.error) {
      throw new Error(`MCP error: ${data.error.message} (code: ${data.error.code})`);
    }

    return data.result;
  } catch (error) {
    console.error(`[mcp-client] Error calling MCP tool ${toolName}:`, error);
    throw error;
  }
}

/**
 * List available tools from the MCP server
 */
export async function listMCPTools(): Promise<string[]> {
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

    const response = await fetch(AROBID_MCP_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      console.error(`[mcp-client] MCP request failed: ${response.status} ${response.statusText}`, errorText);
      throw new Error(`MCP request failed: ${response.status} ${response.statusText} - ${errorText}`);
    }

    const data = await parseMCPResponse(response);

    if (data.error) {
      throw new Error(`MCP error: ${data.error.message} (code: ${data.error.code})`);
    }

    // Extract tool names from the result
    const tools = data.result as { tools?: Array<{ name: string }> };
    return tools?.tools?.map((tool) => tool.name) || [];
  } catch (error) {
    console.error("[mcp-client] Error listing MCP tools:", error);
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
 * Extract email from query if present
 */
function extractEmail(query: string): string | null {
  const emailRegex = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/;
  const match = query.match(emailRegex);
  return match ? match[0] : null;
}

/**
 * Get guidance response for Arobid-related queries
 * This provides helpful information and instructions without executing actions
 * Note: This is an informational Q&A chatbot, not an autonomous agent
 */
function getArobidGuidanceResponse(query: string): string | null {
  const normalizedQuery = query.toLowerCase();

  // Handle password reset queries
  if (
    normalizedQuery.includes("reset") ||
    normalizedQuery.includes("forgot") ||
    normalizedQuery.includes("change password")
  ) {
    const email = extractEmail(query);
    if (email) {
      return `To reset your password for ${email}, you'll need to use the Arobid platform. The process involves: 1) Requesting a password reset, 2) Receiving an OTP code via email, 3) Verifying the OTP, and 4) Setting a new password. Please visit the Arobid website or contact support for assistance with password reset.`;
    }
    return "To reset your password, you'll need to provide your email address on the Arobid platform. The system will send you an OTP code via email that you'll need to verify before setting a new password. Please visit the Arobid website for password reset assistance.";
  }

  // Handle login queries
  if (
    normalizedQuery.includes("login") ||
    normalizedQuery.includes("sign in") ||
    normalizedQuery.includes("log in")
  ) {
    const email = extractEmail(query);
    if (email) {
      return `To log in to Arobid with ${email}, you'll need to: 1) Visit the Arobid login page, 2) Enter your email and password, 3) After authentication, check your email for an OTP code, 4) Enter the OTP code to complete login. Please use the Arobid platform directly for login.`;
    }
    return "To log in to Arobid, you'll need to visit the Arobid platform and provide your email and password. After authentication, you'll receive an OTP code via email that you'll need to verify to complete the login process.";
  }

  // Handle account creation queries
  if (
    normalizedQuery.includes("create") ||
    normalizedQuery.includes("register") ||
    normalizedQuery.includes("sign up") ||
    normalizedQuery.includes("signup") ||
    normalizedQuery.includes("new account")
  ) {
    return "To create an Arobid account, you'll need to provide: your email address, a secure password, first name, last name, title (Mr or Mrs), phone number, and nationality code (2-letter country code like VN, US, etc.). After account creation, you'll receive an OTP code via email for verification. Please visit the Arobid registration page to create your account.";
  }

  // Handle verification/OTP queries
  if (
    normalizedQuery.includes("verify") ||
    normalizedQuery.includes("otp") ||
    normalizedQuery.includes("verification code")
  ) {
    return "To verify your Arobid account, you'll need to provide your email address and the 6-digit OTP code you received via email. The OTP code is valid for a limited time. Please use the Arobid platform's verification page to complete this process.";
  }

  // Generic Arobid information
  if (normalizedQuery.includes("arobid")) {
    return "Arobid provides user account management services including account creation, login, password reset, and email verification. I can provide information and guidance about these services. For actual account operations, please visit the Arobid platform directly. How can I help you with Arobid services?";
  }

  // If no specific match, return null to use default fallback
  return null;
}

/**
 * Query the Arobid MCP server for information related to a user query
 * This function intelligently routes queries to appropriate MCP tools
 * In a Next.js web app, we make HTTP requests to the MCP server
 */
export async function queryArobidMCP(query: string): Promise<string | null> {
  try {
    // Check if query is related to Arobid features
    if (!isArobidRelatedQuery(query)) {
      console.log("[mcp-client] Query not related to Arobid features");
      return null;
    }

    // List available tools from MCP server
    const tools = await listMCPTools();
    console.log("[mcp-client] Available Arobid MCP tools:", tools);

    if (tools.length === 0) {
      console.log("[mcp-client] No MCP tools available, using guidance responses");
      // Fall back to guidance responses if no tools available
      return getArobidGuidanceResponse(query);
    }

    // For now, provide guidance responses based on query intent
    // In the future, you could call actual MCP tools here using callMCPTool()
    return getArobidGuidanceResponse(query);
  } catch (error) {
    console.error("[mcp-client] Error querying Arobid MCP:", error);
    // Return null on error to allow fallback to default answer
    return null;
  }
}

