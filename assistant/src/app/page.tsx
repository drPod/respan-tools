"use client";

import { useState, useRef, useEffect, FormEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface Message {
  role: "user" | "assistant";
  content: string;
  status?: string;
}

interface SSEEvent {
  type: "status" | "tool_call" | "answer";
  message?: string;
  content?: string;
  name?: string;
  query?: string;
}

function parseSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onEvent: (event: SSEEvent) => void,
  onDone: () => void
) {
  const decoder = new TextDecoder();
  let buffer = "";

  function read() {
    reader.read().then(({ done, value }) => {
      if (done) {
        onDone();
        return;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6);
          if (data === "[DONE]") {
            onDone();
            return;
          }
          try {
            const parsed = JSON.parse(data);
            onEvent(parsed);
          } catch {
            // skip malformed
          }
        }
      }

      read();
    });
  }

  read();
}

/**
 * Fake-stream text character by character.
 */
function useFakeStream() {
  const [displayed, setDisplayed] = useState("");
  const fullTextRef = useRef("");
  const indexRef = useRef(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function start(text: string) {
    fullTextRef.current = text;
    indexRef.current = 0;
    setDisplayed("");

    intervalRef.current = setInterval(() => {
      const idx = indexRef.current;
      if (idx >= fullTextRef.current.length) {
        if (intervalRef.current) clearInterval(intervalRef.current);
        return;
      }
      // Stream in chunks of ~3 chars for speed
      const chunk = fullTextRef.current.slice(idx, idx + 3);
      indexRef.current = idx + 3;
      setDisplayed((prev) => prev + chunk);
    }, 15);
  }

  function stop() {
    if (intervalRef.current) clearInterval(intervalRef.current);
    setDisplayed(fullTextRef.current);
  }

  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  return { displayed, start, stop };
}

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [status, setStatus] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fakeStream = useFakeStream();

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, fakeStream.displayed, status]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || isLoading) return;

    const userMessage: Message = { role: "user", content: trimmed };
    const newMessages = [...messages, userMessage];
    setMessages(newMessages);
    setInput("");
    setIsLoading(true);
    setStatus("Thinking...");

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: newMessages.map((m) => ({
            role: m.role,
            content: m.content,
          })),
        }),
      });

      if (!res.ok) {
        throw new Error(`API error: ${res.status}`);
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response body");

      parseSSEStream(
        reader,
        (event) => {
          if (event.type === "status") {
            setStatus(event.message || "");
          } else if (event.type === "tool_call") {
            setStatus(`🔍 search_docs("${event.query || ""}")`);
          } else if (event.type === "answer") {
            setStatus("");
            const answer = event.content || "";
            // Add assistant message and start fake streaming
            setMessages((prev) => [
              ...prev,
              { role: "assistant", content: answer },
            ]);
            fakeStream.start(answer);
          }
        },
        () => {
          setIsLoading(false);
          setStatus("");
          fakeStream.stop();
        }
      );
    } catch (error) {
      console.error("Chat error:", error);
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: "Sorry, something went wrong. Please try again.",
        },
      ]);
      setIsLoading(false);
      setStatus("");
    }
  }

  // The last message is the one being fake-streamed
  const isLastMessageStreaming =
    isLoading === false &&
    messages.length > 0 &&
    messages[messages.length - 1].role === "assistant" &&
    fakeStream.displayed !== messages[messages.length - 1].content;

  return (
    <div className="flex flex-col h-screen max-w-3xl mx-auto">
      {/* Header */}
      <header className="border-b border-gray-200 dark:border-gray-800 px-6 py-4">
        <h1 className="text-lg font-semibold">Respan Assistant</h1>
        <p className="text-sm text-gray-500">Ask anything about Respan</p>
      </header>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
        {messages.length === 0 && !isLoading && (
          <div className="flex items-center justify-center h-full text-gray-400">
            <p>Ask a question about Respan to get started.</p>
          </div>
        )}
        {messages.map((msg, i) => {
          const isLast = i === messages.length - 1;
          const isStreamingThis =
            isLast && msg.role === "assistant" && fakeStream.displayed !== msg.content;
          const displayContent =
            isStreamingThis ? fakeStream.displayed : msg.content;

          return (
            <div
              key={i}
              className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[80%] rounded-lg px-4 py-2 ${
                  msg.role === "user"
                    ? "bg-blue-600 text-white"
                    : "bg-gray-100 dark:bg-gray-800 text-foreground"
                }`}
              >
                {msg.role === "assistant" ? (
                  <div className="prose prose-sm dark:prose-invert max-w-none [&_pre]:bg-gray-200 [&_pre]:dark:bg-gray-900 [&_pre]:rounded [&_pre]:p-3 [&_pre]:overflow-x-auto [&_code]:text-sm [&_a]:text-blue-500">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {displayContent}
                    </ReactMarkdown>
                  </div>
                ) : (
                  <span className="whitespace-pre-wrap">{msg.content}</span>
                )}
              </div>
            </div>
          );
        })}

        {/* Status indicator while loading */}
        {isLoading && status && (
          <div className="flex justify-start">
            <div className="rounded-lg px-4 py-2 bg-gray-100 dark:bg-gray-800 text-foreground">
              <div className="flex items-center gap-2 text-sm text-gray-500">
                <span className="inline-block w-2 h-2 bg-blue-500 rounded-full animate-pulse" />
                <span className="font-mono">{status}</span>
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <form
        onSubmit={handleSubmit}
        className="border-t border-gray-200 dark:border-gray-800 px-6 py-4"
      >
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask about Respan..."
            className="flex-1 rounded-lg border border-gray-300 dark:border-gray-700 bg-transparent px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            disabled={isLoading}
          />
          <button
            type="submit"
            disabled={isLoading || !input.trim()}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Send
          </button>
        </div>
      </form>
    </div>
  );
}
