"use client";

import { useEffect, useRef } from "react";
import { useAssistantState } from "@assistant-ui/react";
import { useAssistantApi } from "@assistant-ui/react";

/**
 * Component that automatically triggers the registration tool
 * when it detects a registration request in the conversation
 */
export function AutoTriggerRegistration() {
  const api = useAssistantApi();
  const lastMessageId = useRef<string | null>(null);

  // Get the last assistant message
  const lastMessage = useAssistantState((state) => {
    const messages = state.thread.messages;
    if (messages.length === 0) return null;
    const lastMsg = messages[messages.length - 1];
    if (lastMsg?.role === "assistant" && lastMsg.content) {
      // Check if it's a text message about registration
      const textContent = Array.isArray(lastMsg.content)
        ? lastMsg.content
            .filter((part) => part.type === "text")
            .map((part) => part.text || "")
            .join(" ")
        : typeof lastMsg.content === "string"
        ? lastMsg.content
        : "";
      
      if (
        textContent.toLowerCase().includes("register") ||
        textContent.toLowerCase().includes("create account") ||
        textContent.toLowerCase().includes("registration form") ||
        textContent.toLowerCase().includes("[TOOL_CALL:register-new-user-account]")
      ) {
        return { id: lastMsg.id, text: textContent };
      }
    }
    return null;
  });

  useEffect(() => {
    if (!api || !lastMessage || lastMessage.id === lastMessageId.current) {
      return;
    }

    // Check if tool was already called for this message
    const hasToolCall = useAssistantState.getState().thread.messages.some(
      (msg) =>
        msg.id === lastMessage.id &&
        msg.content &&
        Array.isArray(msg.content) &&
        msg.content.some((part) => part.type === "tool-call" && part.toolName === "register-new-user-account")
    );

    if (!hasToolCall && lastMessage.text) {
      lastMessageId.current = lastMessage.id;
      
      // Small delay to ensure message is fully processed
      const timeoutId = setTimeout(() => {
        // Call the tool through the model context
        try {
          // Use the model context to access tools
          const modelContext = api.modelContext();
          if (modelContext && typeof modelContext === "object") {
            const contextData = modelContext.getModelContext?.();
            if (contextData && typeof contextData === "object" && "tools" in contextData) {
              const tools = contextData.tools as Record<string, { execute?: (args: unknown) => Promise<unknown> }>;
              const registrationTool = tools["register-new-user-account"];
              if (registrationTool?.execute) {
                console.log("[AutoTriggerRegistration] Triggering registration tool");
                registrationTool.execute({}).catch((error) => {
                  console.error("[AutoTriggerRegistration] Error triggering tool:", error);
                });
              }
            }
          }
        } catch (error) {
          console.error("[AutoTriggerRegistration] Error accessing model context:", error);
        }
      }, 500);

      return () => clearTimeout(timeoutId);
    }
  }, [api, lastMessage]);

  return null;
}

