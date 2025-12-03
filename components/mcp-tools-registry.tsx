"use client";

import { useEffect } from "react";
import { useAssistantApi } from "@assistant-ui/react";
import { listMCPTools, callMCPTool } from "@/lib/mcpclient2";

/**
 * Component that registers MCP tools with assistant-ui
 * This makes MCP tools available to the LLM through assistant-ui
 * Place this component inside AssistantRuntimeProvider
 */
export function MCPToolsRegistry() {
  const api = useAssistantApi();

  useEffect(() => {
    let mounted = true;
    let unregister: (() => void) | null = null;

    async function registerTools() {
      try {
        const mcpTools = await listMCPTools();
        
        if (!mounted || mcpTools.length === 0) {
          if (mcpTools.length === 0) {
            console.log("[MCPToolsRegistry] No MCP tools available");
          }
          return;
        }

        console.log(`[MCPToolsRegistry] Registering ${mcpTools.length} MCP tools:`, mcpTools.map(t => t.name));

        // Create tool definitions in the format expected by assistant-ui
        const toolDefinitions: Record<string, any> = {};

        for (const tool of mcpTools) {
          // Special handling for register-new-user-account - don't execute automatically
          // Let the form component handle execution
          if (tool.name === "register-new-user-account") {
            toolDefinitions[tool.name] = {
              description: tool.description || `Execute the ${tool.name} tool from MCP server`,
              parameters: tool.inputSchema || {
                type: "object",
                properties: {},
                required: [],
              },
              execute: async (args: Record<string, unknown>) => {
                // For registration, we don't execute automatically
                // The form UI will handle the execution
                console.log(`[MCPToolsRegistry] Registration tool called with args:`, args);
                // Return a placeholder that indicates the form should be shown
                return {
                  _showForm: true,
                  _message: "Please fill out the registration form below.",
                };
              },
            };
          } else {
            toolDefinitions[tool.name] = {
              description: tool.description || `Execute the ${tool.name} tool from MCP server`,
              parameters: tool.inputSchema || {
                type: "object",
                properties: {},
                required: [],
              },
              execute: async (args: Record<string, unknown>) => {
                console.log(`[MCPToolsRegistry] Executing tool ${tool.name} with args:`, args);
                try {
                  const result = await callMCPTool(tool.name, args);
                  console.log(`[MCPToolsRegistry] Tool ${tool.name} result:`, result);
                  return result;
                } catch (error) {
                  console.error(`[MCPToolsRegistry] Error executing tool ${tool.name}:`, error);
                  throw error;
                }
              },
            };
          }
        }

        // Register tools with the assistant context
        if (api) {
          unregister = api.modelContext().register({
            getModelContext: () => ({
              tools: toolDefinitions,
            }),
            priority: 5, // Medium priority
          });
        }
      } catch (error) {
        console.error("[MCPToolsRegistry] Error registering MCP tools:", error);
      }
    }

    registerTools();

    return () => {
      mounted = false;
      if (unregister) {
        unregister();
      }
    };
  }, [api]);

  return null; // This component doesn't render anything
}

