import { answerQuestion } from "@/lib/helper";
import { createUIMessageStreamResponse } from "ai";

export const maxDuration = 30;

export async function POST(req: Request) {
  const { messages } = await req.json();

  // Get the last user message
  const lastMessage = messages[messages.length - 1];
  let userQuery = "";
  
  // Debug: Log the message structure
  console.log("Last message:", JSON.stringify(lastMessage, null, 2));
  console.log("All messages:", JSON.stringify(messages, null, 2));
  
  if (lastMessage) {
    // Try different ways to extract the content
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
    
    // Fallback: try text field directly
    if (!userQuery && lastMessage.text) {
      userQuery = String(lastMessage.text);
    }
    
    // Fallback: try parts field
    if (!userQuery && Array.isArray(lastMessage.parts)) {
      userQuery = lastMessage.parts
        .map((part: { text?: string; content?: string; [key: string]: unknown }) => {
          return part.text || part.content || "";
        })
        .filter(Boolean)
        .join(" ");
    }
  }

  // Normalize query - trim whitespace
  userQuery = userQuery.trim();
  
  // Debug: Log the extracted query
  console.log("Extracted query:", JSON.stringify(userQuery));
  console.log("Query length:", userQuery.length);
  console.log("Query charCodes:", userQuery.split("").map(c => c.charCodeAt(0)));

  // Get answer from helper
  const answer = await answerQuestion(userQuery);
  
  // Debug: Log the answer
  console.log("Answer:", JSON.stringify(answer));

  // Check if answer is a navigation response
  const isNavigation = typeof answer === "object" && answer !== null && "type" in answer && answer.type === "navigation";
  const navigationRoute = isNavigation ? (answer as { route: string }).route : null;
  let answerText = isNavigation ? (answer as { message: string }).message : String(answer);
  
  // Ensure answerText is not empty
  if (!answerText || answerText.trim() === "") {
    answerText = "Sorry, I don't have an answer for that yet.";
  }

  console.log("Processing answer:", {
    isNavigation,
    navigationRoute,
    answerText,
    answerType: typeof answer,
    answerValue: answer,
  });
  
  // Debug: Check for spacing issues in answer text
  if (answerText && answerText.includes("Hoàn") && !answerText.includes("Hoàn toàn")) {
    console.warn("[api/chat] Potential spacing issue detected in answer text");
    console.warn("[api/chat] Answer preview:", answerText.substring(0, 200));
  }

  // Generate a unique message ID
  const messageId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
  const textPartId = `text_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;

  console.log("Creating stream with messageId:", messageId, "answerText:", answerText);

  // Create a ReadableStream with proper UIMessageChunk format
  const stream = new ReadableStream({
    async start(controller) {
      try {
        console.log("Stream started, enqueueing start message");
        // Start the message
        const startChunk: any = {
          type: "start" as const,
          messageId,
        };
        if (navigationRoute) {
          startChunk.messageMetadata = { navigation: { route: navigationRoute } };
        }
        controller.enqueue(startChunk);

        console.log("Enqueueing text-start");
        // Start the text part
        controller.enqueue({
          type: "text-start" as const,
          id: textPartId,
        });

        // Send the text as deltas (character by character for proper streaming)
        if (answerText && answerText.trim()) {
          console.log("Sending text delta, length:", answerText.length);
          // Send in chunks to ensure proper streaming
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

        console.log("Enqueueing text-end");
        // End the text part
        controller.enqueue({
          type: "text-end" as const,
          id: textPartId,
        });

        console.log("Enqueueing finish");
        // Finish the message
        const finishChunk: any = {
          type: "finish" as const,
          finishReason: "stop" as const,
        };
        if (navigationRoute) {
          finishChunk.messageMetadata = { navigation: { route: navigationRoute } };
        }
        controller.enqueue(finishChunk);

        console.log("Closing stream");
        controller.close();
      } catch (error) {
        console.error("Stream error:", error);
        controller.error(error);
      }
    },
  });

  // Create and return the UI message stream response
  return createUIMessageStreamResponse({ stream });
}
