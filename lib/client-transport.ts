"use client";

import { answerQuestion } from "./helper-client";
import { DefaultChatTransport, type UIMessage } from "ai";

/**
 * Custom transport that uses client-side answerQuestion function
 * instead of making HTTP requests to the API route
 */
export class ClientSideTransport<UI_MESSAGE extends UIMessage = UIMessage> extends DefaultChatTransport<UI_MESSAGE> {
  constructor() {
    // Pass empty options since we're not using HTTP
    super({
      url: "", // Not used since we override sendMessages
    });
  }

  // Override sendMessages to use client-side helper instead of HTTP
  async sendMessages({ messages, ...options }: Parameters<DefaultChatTransport<UI_MESSAGE>['sendMessages']>[0]): Promise<ReadableStream> {
    // Get the last user message
    const lastMessage = messages[messages.length - 1];
    let userQuery = "";
    
    if (lastMessage) {
      if (lastMessage.content) {
        if (typeof lastMessage.content === "string") {
          userQuery = lastMessage.content;
        } else if (Array.isArray(lastMessage.content)) {
          userQuery = lastMessage.content
            .map((part: { text?: string; type?: string; content?: string; [key: string]: unknown }) => {
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
          .map((part: { text?: string; content?: string; [key: string]: unknown }) => {
            return part.text || part.content || "";
          })
          .filter(Boolean)
          .join(" ");
      }
    }
    
    userQuery = userQuery.trim();
    
    if (!userQuery) {
      // Return empty stream
      return new ReadableStream({
        start(controller) {
          controller.close();
        },
      });
    }
    
    // Create a ReadableStream that yields the answer
    return new ReadableStream({
      async start(controller) {
        try {
          // Get answer from client-side helper
          const answer = await answerQuestion(userQuery);
          
          // Check if answer is a navigation response
          const isNavigation = typeof answer === "object" && answer !== null && "type" in answer && answer.type === "navigation";
          const navigationRoute = isNavigation ? (answer as { route: string }).route : null;
          let answerText = isNavigation ? (answer as { message: string }).message : String(answer);
          
          if (!answerText || answerText.trim() === "") {
            answerText = "Sorry, I don't have an answer for that yet.";
          }
          
          // Generate a unique message ID
          const messageId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
          const textPartId = `text_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
          
          // Enqueue start message
          const startChunk: any = {
            type: "start" as const,
            messageId,
          };
          if (navigationRoute) {
            startChunk.messageMetadata = { navigation: { route: navigationRoute } };
          }
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
              });
              // Small delay for streaming effect
              await new Promise((resolve) => setTimeout(resolve, 20));
            }
          }
          
          // Enqueue text-end
          controller.enqueue({
            type: "text-end" as const,
            id: textPartId,
          });
          
          // Enqueue finish message
          const finishChunk: any = {
            type: "finish" as const,
            finishReason: "stop" as const,
          };
          if (navigationRoute) {
            finishChunk.messageMetadata = { navigation: { route: navigationRoute } };
          }
          controller.enqueue(finishChunk);
          
          controller.close();
        } catch (error) {
          console.error("[ClientSideTransport] Error:", error);
          controller.error(error);
        }
      },
    });
  }
}

