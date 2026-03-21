import { NextRequest, NextResponse } from "next/server";

const RESPAN_BASE_URL =
  process.env.RESPAN_BASE_URL || "https://api.respan.ai";
const RESPAN_API_KEY = process.env.RESPAN_API_KEY!;
const ROUTER_PROMPT_ID = process.env.RESPAN_ROUTER_PROMPT_ID!;
const DOC_FINDER_PROMPT_ID = process.env.RESPAN_DOC_FINDER_PROMPT_ID!;
const INDEX_PROMPT_ID = process.env.RESPAN_INDEX_PROMPT_ID!;
const ROUTER_MODEL = process.env.ROUTER_MODEL || "gpt-4o-mini";
const DOC_FINDER_MODEL = process.env.DOC_FINDER_MODEL || "gpt-4o-mini";

const DOCS_BASE_URL = "https://www.respan.ai/docs";

async function callRespan(
  promptId: string,
  variables: Record<string, unknown>,
  options: {
    model?: string;
    messages?: Record<string, unknown>[];
  } = {}
) {
  return fetch(`${RESPAN_BASE_URL}/api/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${RESPAN_API_KEY}`,
    },
    body: JSON.stringify({
      model: options.model || ROUTER_MODEL,
      messages: options.messages || [],
      stream: false,
      prompt: {
        prompt_id: promptId,
        override: true,
        variables,
      },
    }),
  });
}

/**
 * Call Doc Finder (Prompt 2) to get relevant doc paths.
 */
async function findDocs(query: string): Promise<string[]> {
  const res = await callRespan(
    DOC_FINDER_PROMPT_ID,
    {
      docs_index: {
        _type: "prompt",
        prompt_id: INDEX_PROMPT_ID,
      },
      query,
    },
    { model: DOC_FINDER_MODEL }
  );

  if (!res.ok) {
    console.error("Doc finder error:", res.status, await res.text());
    return [];
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || "";

  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) return parsed;
    if (parsed.doc_paths) return parsed.doc_paths;
  } catch {
    // Not JSON
  }

  return content
    .split(/[\n,]/)
    .map((line: string) =>
      line.trim().replace(/^[-*•"\s]+/, "").replace(/["'\s]+$/, "")
    )
    .filter((line: string) => line.startsWith("/"))
    .slice(0, 5);
}

function sseEvent(
  type: "status" | "tool_call" | "answer",
  data: Record<string, string>
): string {
  return `data: ${JSON.stringify({ type, ...data })}\n\n`;
}

export async function POST(req: NextRequest) {
  try {
    const { messages } = await req.json();

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return NextResponse.json(
        { error: "messages array is required" },
        { status: 400 }
      );
    }

    const userQuestion =
      messages
        .filter((m: { role: string }) => m.role === "user")
        .pop()?.content || "";

    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        try {
          // Step 1: Call Router (Prompt 1) — tool is in Respan config
          controller.enqueue(
            encoder.encode(sseEvent("status", { message: "Thinking..." }))
          );

          const routerRes = await callRespan(
            ROUTER_PROMPT_ID,
            { user_question: userQuestion, docs_context: "" },
            { model: ROUTER_MODEL }
          );

          if (!routerRes.ok) {
            console.error("Router error:", routerRes.status, await routerRes.text());
            controller.enqueue(
              encoder.encode(sseEvent("answer", { content: "Sorry, something went wrong." }))
            );
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
            return;
          }

          const routerData = await routerRes.json();
          const message = routerData.choices?.[0]?.message;

          // Step 2: Did Router call search_docs?
          if (message?.tool_calls?.length > 0) {
            const args = JSON.parse(message.tool_calls[0].function.arguments || "{}");
            const query = args.query || userQuestion;

            console.log("Tool call: search_docs, query:", query);
            controller.enqueue(
              encoder.encode(sseEvent("tool_call", { name: "search_docs", query }))
            );

            // Step 3: Doc Finder (Prompt 2) → get paths
            controller.enqueue(
              encoder.encode(sseEvent("status", { message: "Searching docs..." }))
            );
            const docPaths = await findDocs(query);
            console.log("Doc paths:", docPaths);

            const docLinks = docPaths
              .map((p) => `${DOCS_BASE_URL}${p}`)
              .join("\n");

            // Step 4: Call Router again with tool result — proper OpenAI tool calling flow
            // Pass the assistant's tool_call message + tool result so the model
            // sees it already called the tool and now has the result to answer with.
            controller.enqueue(
              encoder.encode(sseEvent("status", { message: "Generating answer..." }))
            );

            const finalRes = await callRespan(
              ROUTER_PROMPT_ID,
              {
                user_question: userQuestion,
                docs_context: "",
              },
              {
                model: ROUTER_MODEL,
                messages: [
                  {
                    role: "assistant",
                    content: null,
                    tool_calls: message.tool_calls,
                  },
                  {
                    role: "tool",
                    tool_call_id: message.tool_calls[0].id,
                    content: `Relevant documentation:\n${docLinks}`,
                  },
                ],
              }
            );

            if (!finalRes.ok) {
              console.error("Router final error:", finalRes.status, await finalRes.text());
              controller.enqueue(
                encoder.encode(sseEvent("answer", { content: "Sorry, something went wrong." }))
              );
            } else {
              const finalData = await finalRes.json();
              const answer = finalData.choices?.[0]?.message?.content || "No answer.";
              controller.enqueue(
                encoder.encode(sseEvent("answer", { content: answer }))
              );
            }
          } else {
            // Router answered directly
            const answer = message?.content || "No answer.";
            controller.enqueue(
              encoder.encode(sseEvent("answer", { content: answer }))
            );
          }

          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        } catch (err) {
          console.error("Stream error:", err);
          controller.error(err);
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (error) {
    console.error("Chat API error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
