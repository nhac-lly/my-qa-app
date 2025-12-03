"use client";

import { useState } from "react";
import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import { RegistrationForm } from "@/components/registration-form";

export const RegistrationToolUI: ToolCallMessagePartComponent = ({
  toolName,
  argsText,
  result,
  status,
}) => {
  // Always show the form when this tool is called
  // The form will handle its own submission and show results
  
  // If we have a result and it's not the placeholder, show the result
  if (result !== undefined && status?.type !== "incomplete" && typeof result === "object" && result !== null) {
    // Check if it's the placeholder result - still show form
    if ("_showForm" in result) {
      return (
        <div className="mb-4">
          <RegistrationForm />
        </div>
      );
    }

    // Check if result has content array (from MCP tool response after form submission)
    if ("content" in result && Array.isArray(result.content)) {
      const content = result.content[0];
      const isError = result && typeof result === "object" && "isError" in result && result.isError === true;
      
      if (content?.text) {
        try {
          const parsedResult = JSON.parse(content.text);
          
          // Check for error first
          if (isError || (parsedResult && typeof parsedResult === "object" && "error" in parsedResult)) {
            const errorMsg = parsedResult?.error || content.text;
            return (
              <div className="mb-4 flex w-full flex-col gap-3 rounded-lg border border-red-500 py-3 px-4">
                <p className="font-semibold">Account Registration Result</p>
                <div className="rounded bg-red-50 dark:bg-red-900/20 p-4">
                  <p className="font-bold text-red-600 dark:text-red-400">
                    Registration Failed
                  </p>
                  <p className="mt-2 text-sm text-red-700 dark:text-red-300">
                    {errorMsg}
                  </p>
                </div>
              </div>
            );
          }
          
          // Check for success
          if (parsedResult.isSucceeded) {
            return (
              <div className="mb-4 flex w-full flex-col gap-3 rounded-lg border py-3 px-4">
                <p className="font-semibold">Account Registration Result</p>
                <div className="rounded bg-green-50 dark:bg-green-900/20 p-4">
                  <p className="font-bold text-green-600 dark:text-green-400">
                    Account created successfully!
                  </p>
                  {parsedResult.data?.profile && (
                    <div className="mt-2 text-sm">
                      <p>Email: {parsedResult.data.profile.email}</p>
                      <p>Name: {parsedResult.data.profile.fullName}</p>
                      <p className="mt-2 text-xs text-muted-foreground">
                        Please check your email for the OTP verification code.
                      </p>
                    </div>
                  )}
                </div>
              </div>
            );
          }
        } catch {
          // Not JSON - if it's an error, show it
          if (isError && content.text) {
            return (
              <div className="mb-4 flex w-full flex-col gap-3 rounded-lg border border-red-500 py-3 px-4">
                <p className="font-semibold">Account Registration Result</p>
                <div className="rounded bg-red-50 dark:bg-red-900/20 p-4">
                  <p className="font-bold text-red-600 dark:text-red-400">
                    Registration Failed
                  </p>
                  <p className="mt-2 text-sm text-red-700 dark:text-red-300">
                    {content.text}
                  </p>
                </div>
              </div>
            );
          }
        }
      }
    }
  }

  // Default: Always show the form
  return (
    <div className="mb-4">
      <RegistrationForm />
    </div>
  );
};

