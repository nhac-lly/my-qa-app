"use client";

import { useEffect, useRef, useMemo } from "react";
import { useAssistantState, useAssistantApi } from "@assistant-ui/react";
import { useShallow } from "zustand/shallow";

/**
 * Component that watches for registration requests and automatically
 * triggers the registration tool to show the form
 */
export function RegistrationToolTrigger() {
  const api = useAssistantApi();
  const processedMessageIds = useRef<Set<string>>(new Set());

  // Use useShallow to prevent infinite loops
  const messages = useAssistantState(
    useShallow((state) => state.thread.messages)
  );

  // Memoize message IDs to track changes
  const messageIds = useMemo(() => {
    return messages
      .filter((msg) => msg.role === "assistant")
      .map((msg) => msg.id)
      .join(",");
  }, [messages]);

  // Memoize processed assistant messages to avoid recreating on every render
  const assistantMessages = useMemo(() => {
    return messages
      .filter((msg) => msg.role === "assistant")
      .map((msg) => {
        const textContent = Array.isArray(msg.content)
          ? msg.content
              .filter((part) => part.type === "text")
              .map((part) => part.text || "")
              .join(" ")
          : typeof msg.content === "string"
          ? msg.content
          : "";
        return { id: msg.id, text: textContent, content: msg.content };
      });
  }, [messages]);

  // Process messages when IDs change
  useEffect(() => {
    if (!api) return;

    // Process each assistant message
    for (const message of assistantMessages) {
      if (processedMessageIds.current.has(message.id)) continue;

      // Check if message mentions registration
      const mentionsRegistration =
        message.text.toLowerCase().includes("register") ||
        message.text.toLowerCase().includes("create account") ||
        message.text.toLowerCase().includes("registration form") ||
        message.text.toLowerCase().includes("[tool:register-new-user-account]");

      // Check if message already has the tool call
      const hasToolCall =
        Array.isArray(message.content) &&
        message.content.some(
          (part) =>
            (part.type === "tool-call" || part.type === "tool") &&
            "toolName" in part &&
            part.toolName === "register-new-user-account"
        );

      if (mentionsRegistration && !hasToolCall) {
        processedMessageIds.current.add(message.id);

        // Use thread runtime to append tool call to the message
        setTimeout(() => {
          try {
            console.log(
              "[RegistrationToolTrigger] Triggering registration tool for message:",
              message.id
            );
            
            // Access the model context directly to get tools
            try {
              const modelContext = api.modelContext();
              if (modelContext && typeof modelContext === "object") {
                // Get the registered tools from the model context
                const contextData = modelContext.getModelContext?.();
                if (contextData && typeof contextData === "object" && "tools" in contextData) {
                  const tools = contextData.tools as Record<
                    string,
                    { execute?: (args: unknown) => Promise<unknown> }
                  >;
                  const registrationTool = tools["register-new-user-account"];
                  if (registrationTool?.execute) {
                    // Execute the tool - this should trigger the form through the tool UI
                    console.log("[RegistrationToolTrigger] Executing registration tool");
                    registrationTool.execute({}).catch((error) => {
                      console.error(
                        "[RegistrationToolTrigger] Error executing tool:",
                        error
                      );
                    });
                  } else {
                    console.warn(
                      "[RegistrationToolTrigger] Registration tool not found in model context"
                    );
                  }
                } else {
                  console.warn(
                    "[RegistrationToolTrigger] Could not get tools from model context"
                  );
                }
              }
            } catch (contextError) {
              console.warn(
                "[RegistrationToolTrigger] Error accessing model context:",
                contextError
              );
            }
          } catch (error) {
            console.error(
              "[RegistrationToolTrigger] Error triggering tool:",
              error
            );
          }
        }, 500);
      }
    }
  }, [api, messageIds, assistantMessages]); // Depend on memoized assistantMessages

  return null;
}

