"use client";

import { answerQuestion } from "./helper-client4";
import { listMCPTools, callMCPTool } from "./mcpclient2";
import { DefaultChatTransport, type UIMessage, type UIMessageChunk } from "ai";

type MessageContentPart = {
  type?: string;
  text?: string;
  content?: string;
  [key: string]: unknown;
};

type MessageLike = UIMessage & {
  content?: string | MessageContentPart[];
  text?: string;
  parts?: MessageContentPart[];
};

/**
 * Custom transport that uses helper-client4 (Gemini API) for AI inference
 * Pure AI inference - no QnA or MCP functionality
 */
export class ClientSideTransport3<UI_MESSAGE extends UIMessage = UIMessage> extends DefaultChatTransport<UI_MESSAGE> {
  constructor() {
    // Provide a dummy API value to satisfy the base class, though we never use it
    super({ api: "" });
  }

  // Override sendMessages to use helper-client4 (Gemini API) with MCP tool support
  async sendMessages({ messages }: Parameters<DefaultChatTransport<UI_MESSAGE>["sendMessages"]>[0]): Promise<ReadableStream<UIMessageChunk>> {
    // Get the last user message
    const lastMessage = messages[messages.length - 1] as MessageLike | undefined;
    let userQuery = "";
    
    // Get available MCP tools
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let availableTools: Array<{ name: string; description?: string; inputSchema?: any }> = [];
    try {
      availableTools = await listMCPTools();
    } catch (error) {
      console.error("[ClientSideTransport3] Error loading MCP tools:", error);
    }
    
    if (lastMessage) {
      if (lastMessage.content) {
        if (typeof lastMessage.content === "string") {
          userQuery = lastMessage.content;
        } else if (Array.isArray(lastMessage.content)) {
          userQuery = lastMessage.content
            .map((part: MessageContentPart) => {
              if (part.type === "text") {
                return part.text || part.content || "";
              }
              if (typeof part === "string") {
                return part;
              }
              if (part.text) {
                return String(part.text);
              }
              if (part.content) {
                return String(part.content);
              }
              return "";
            })
            .filter(Boolean)
            .join(" ");
        }
      }
      
      if (!userQuery && lastMessage.text) {
        userQuery = String(lastMessage.text);
      }
      
      if (!userQuery && Array.isArray(lastMessage.parts)) {
        userQuery = lastMessage.parts
          .map((part: MessageContentPart) => {
            return part.text || part.content || "";
          })
          .filter(Boolean)
          .join(" ");
      }
    }
    
    userQuery = userQuery.trim();
    
    if (!userQuery) {
      // Return empty stream
      return new ReadableStream<UIMessageChunk>({
        start(controller) {
          controller.close();
        },
      });
    }
    
    // Create a ReadableStream that yields the answer
    return new ReadableStream<UIMessageChunk>({
      async start(controller) {
        try {
          // Build context with available tools for the LLM
          let enhancedQuery = userQuery;
          
          // Check if user wants to register/create account
          const isRegistrationRequest = 
            userQuery.toLowerCase().includes("register") ||
            userQuery.toLowerCase().includes("create account") ||
            userQuery.toLowerCase().includes("sign up") ||
            userQuery.toLowerCase().includes("new account");

          // If registration is requested, provide a simple response that will trigger the form
          if (isRegistrationRequest && availableTools.some(t => t.name === "register-new-user-account")) {
            const messageId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
            const textPartId = `text_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
            const toolCallId = `tool_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;

            controller.enqueue({
              type: "start" as const,
              messageId,
            } as UIMessageChunk);

            // Show a brief message
            controller.enqueue({
              type: "text-start" as const,
              id: textPartId,
            });

            const message = "I'll help you create a new account. Please fill out the registration form below.";
            for (let i = 0; i < message.length; i += 10) {
              controller.enqueue({
                type: "text-delta" as const,
                delta: message.slice(i, i + 10),
                id: textPartId,
              } as UIMessageChunk);
              await new Promise((resolve) => setTimeout(resolve, 20));
            }

            controller.enqueue({
              type: "text-end" as const,
              id: textPartId,
            } as UIMessageChunk);

            // Emit a proper tool call chunk that assistant-ui will recognize
            controller.enqueue({
              type: "tool-input-start" as const,
              toolCallId,
              toolName: "register-new-user-account",
            } as unknown as UIMessageChunk);

            controller.enqueue({
              type: "tool-input-end" as const,
              toolCallId,
            } as unknown as UIMessageChunk);

            controller.enqueue({
              type: "finish" as const,
              finishReason: "tool-calls" as const,
            } as unknown as UIMessageChunk);

            controller.close();
            return;
          }

          // Only include tool information if the query seems to need tools
          // Simple queries like "ping" don't need tool context
          const queryNeedsTools = 
            isRegistrationRequest ||
            userQuery.toLowerCase().includes("search") ||
            userQuery.toLowerCase().includes("find") ||
            userQuery.toLowerCase().includes("list") ||
            userQuery.toLowerCase().includes("get") ||
            userQuery.toLowerCase().includes("arobid") ||
            userQuery.toLowerCase().includes("event") ||
            userQuery.toLowerCase().includes("exhibitor") ||
            userQuery.toLowerCase().includes("register") ||
            userQuery.toLowerCase().includes("create") ||
            userQuery.toLowerCase().includes("new");

          // If tools are available and query needs them, add tool information
          if (availableTools.length > 0 && queryNeedsTools) {
            const toolsDescription = availableTools
              .map(tool => {
                const params = tool.inputSchema?.properties 
                  ? Object.keys(tool.inputSchema.properties).join(", ")
                  : "none";
                return `- ${tool.name}: ${tool.description || "MCP tool"} (parameters: ${params})`;
              })
              .join("\n");
            
            enhancedQuery = `Available MCP tools:\n${toolsDescription}\n\nUser query: ${userQuery}\n\nIMPORTANT: If the user wants to register or create a new account, you should use the "register-new-user-account" tool. This tool requires a form to be filled out by the user. Tell the user you will show them a registration form.`;
          }
          
          // Get answer from helper-client4 (Gemini API)
          let answerText = await answerQuestion(enhancedQuery);
          
          // Only check for tool calls if the query actually needs tools
          // This prevents false positives on simple queries like "ping"
          if (queryNeedsTools && availableTools.length > 0 && typeof answerText === "string") {
            // Try to detect tool usage intent and execute tools if needed
            // This is a basic implementation - you can enhance it with better parsing
            answerText = await handleToolCalls(answerText, availableTools, userQuery);
          }
          
          if (!answerText || answerText.trim() === "") {
            controller.error(new Error("No response generated"));
            return;
          }
          
          // Generate a unique message ID
          const messageId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
          const textPartId = `text_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
          
          // Enqueue start message
          const startChunk = {
            type: "start" as const,
            messageId,
          } as UIMessageChunk;
          controller.enqueue(startChunk);
          
          // Enqueue text-start
          controller.enqueue({
            type: "text-start" as const,
            id: textPartId,
          });
          
          // Enqueue text deltas (character by character for streaming effect)
          if (answerText && answerText.trim()) {
            const chunkSize = 10;
            for (let i = 0; i < answerText.length; i += chunkSize) {
              const chunk = answerText.slice(i, i + chunkSize);
              controller.enqueue({
                type: "text-delta" as const,
                delta: chunk,
                id: textPartId,
              } as UIMessageChunk);
              // Small delay for streaming effect
              await new Promise((resolve) => setTimeout(resolve, 20));
            }
          }
          
          // Enqueue text-end
          controller.enqueue({
            type: "text-end" as const,
            id: textPartId,
          } as UIMessageChunk);
          
          // Enqueue finish message
          const finishChunk = {
            type: "finish" as const,
            finishReason: "stop" as const,
          } as UIMessageChunk;
          controller.enqueue(finishChunk);
          
          controller.close();
        } catch (error) {
          console.error("[ClientSideTransport3] Error:", error);
          controller.error(error);
        }
      },
    });
  }
}

/**
 * Handle tool calls in the LLM response
 * This tries to detect when the LLM wants to use a tool and executes it
 */
async function handleToolCalls(
  answerText: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  availableTools: Array<{ name: string; description?: string; inputSchema?: any }>,
  originalQuery: string
): Promise<string> {
  // Be more conservative: only execute tools when there's a clear, specific match
  const queryLower = originalQuery.toLowerCase().trim();
  
  // Try to find matching tools and execute them
  // Only match if there's a clear intent - be conservative to avoid false positives
  for (const tool of availableTools) {
    const toolNameLower = tool.name.toLowerCase();
    const toolNameParts = toolNameLower.split("-");
    
    // Check for explicit matches:
    // 1. Tool name is explicitly mentioned in query
    // 2. Key parts of tool name appear in query (but be more specific)
    const explicitMatch = queryLower.includes(toolNameLower) || 
                         toolNameParts.some(part => part.length > 3 && queryLower.includes(part));
    
    // For registration, only match specific keywords
    if (tool.name === "register-new-user-account") {
      const registrationKeywords = ["register", "sign up", "create account", "new account"];
      const isRegistration = registrationKeywords.some(keyword => queryLower.includes(keyword));
      if (!isRegistration) {
        continue; // Skip this tool for non-registration queries
      }
    }
    
    // Only proceed if there's a clear match and it's not a simple conversational query
    if (explicitMatch && !isSimpleConversationalQuery(queryLower)) {
      try {
        console.log(`[ClientSideTransport3] Detected tool usage for: ${tool.name}`);
        
        // Extract parameters from query (this is simplified - you'd want better extraction)
        const args: Record<string, unknown> = {};
        
        // For tools that might need specific parameters, try to extract them
        // This is a basic implementation
        const result = await callMCPTool(tool.name, args);
        
        // Format the tool result and append to answer
        const toolResultText = typeof result === "string" 
          ? result 
          : JSON.stringify(result, null, 2);
        
        return `${answerText}\n\n[Tool Result: ${tool.name}]\n${toolResultText}`;
      } catch (error) {
        console.error(`[ClientSideTransport3] Error executing tool ${tool.name}:`, error);
        // Continue without tool result if execution fails
      }
    }
  }
  
  return answerText;
}

/**
 * Check if a query is a simple conversational query that doesn't need tools
 */
function isSimpleConversationalQuery(query: string): boolean {
  const simplePatterns = [
    /^ping$/i,
    /^hello$/i,
    /^hi$/i,
    /^hey$/i,
    /^thanks?$/i,
    /^thank you$/i,
    /^bye$/i,
    /^goodbye$/i,
    /^how are you$/i,
    /^what's up$/i,
  ];
  
  return simplePatterns.some(pattern => pattern.test(query.trim()));
}

