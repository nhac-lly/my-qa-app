"use client";

import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { useChatRuntime } from "@assistant-ui/react-ai-sdk";
import { ClientSideTransport } from "@/lib/client-transport";
import * as Dialog from "@radix-ui/react-dialog";
import { useState, useEffect } from "react";
import { Thread } from "@/components/assistant-ui/thread";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

function AssistantModal({
  open,
  onClose,
  title,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-3xl -translate-x-1/2 -translate-y-1/2 rounded-lg bg-white shadow-lg">
          <Dialog.Title className="sr-only">{title}</Dialog.Title>
          <div className="flex h-[600px] flex-col">
            <div className="flex items-center justify-between border-b px-4 py-3">
              <Dialog.Title className="text-lg font-semibold">{title}</Dialog.Title>
              <Dialog.Close asChild>
                <button
                  onClick={onClose}
                  className="rounded p-1 hover:bg-gray-100"
                  aria-label="Close"
                >
                  ✕
                </button>
              </Dialog.Close>
            </div>
            <div className="flex-1 overflow-hidden">
              <Thread />
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // Persist chat modal state across navigation using localStorage
  const [open, setOpen] = useState(() => {
    // Initialize from localStorage synchronously to avoid cascading renders
    if (typeof window !== "undefined") {
      return localStorage.getItem("chatModalOpen") === "true";
    }
    return false;
  });

  // Create runtime at layout level - this preserves chat context across modal open/close
  // The runtime persists as long as the layout component exists
  // Use client-side transport implementing required methods
  const runtime = useChatRuntime({
    transport: new ClientSideTransport(),
  });

  // Save chat state to localStorage when it changes
  useEffect(() => {
    localStorage.setItem("chatModalOpen", open ? "true" : "false");
  }, [open]);

  // Keep chat open when navigating (don't close on route change)
  // The chat will remain open across all pages

  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable}`}>
        {/* Wrap everything with AssistantRuntimeProvider so it never unmounts */}
        <AssistantRuntimeProvider runtime={runtime}>
          {children}
          {/* Floating button to open modal */}
          <button
            onClick={() => setOpen(true)}
            style={{
              position: "fixed",
              bottom: "20px",
              right: "20px",
              padding: "12px 16px",
              borderRadius: "50%",
              background: "#0070f3",
              color: "white",
              border: "none",
              cursor: "pointer",
              zIndex: 1000,
            }}
          >
            💬
          </button>

          {/* Assistant Modal - stays open across navigation */}
          {/* Runtime is created at layout level to persist chat context */}
          <AssistantModal
            open={open}
            onClose={() => setOpen(false)}
            title="Ask me anything"
          />
        </AssistantRuntimeProvider>
      </body>
    </html>
  );
}
