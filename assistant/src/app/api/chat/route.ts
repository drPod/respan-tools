import { NextRequest, NextResponse } from "next/server";
import { readFileSync } from "fs";
import { join } from "path";

const RESPAN_BASE_URL =
  process.env.RESPAN_BASE_URL || "https://api.respan.ai";
const RESPAN_API_KEY = process.env.RESPAN_API_KEY!;
const ROUTER_PROMPT_ID = process.env.RESPAN_ROUTER_PROMPT_ID!;
const INDEX_PROMPT_ID = process.env.RESPAN_INDEX_PROMPT_ID!;
const ANSWERER_PROMPT_ID = process.env.RESPAN_ANSWERER_PROMPT_ID!;
const ROUTER_MODEL = process.env.ROUTER_MODEL || "gpt-4o-mini";
const ANSWERER_MODEL = process.env.ANSWERER_MODEL || "gpt-4o-mini";

const DOCS_BASE_PATH = process.env.DOCS_PATH || "";
const DOCS_BASE_URL = "https://www.respan.ai/docs";

// JSON schema for router output — two states: "router" or "answerer"
const ROUTER_SCHEMA = {
  type: "json_schema",
  json_schema: {
    name: "router_decision",
    strict: true,
    schema: {
      type: "object",
      properties: {
        next_state: {
          type: "string",
          enum: ["router", "answerer"],
        },
        response: {
          type: "string",
          description:
            "Full markdown answer for the user. Used when next_state is router. Empty when answerer.",
        },
        doc_paths: {
          type: "array",
          items: { type: "string" },
          description:
            "Doc paths to fetch. Used when next_state is answerer.",
        },
        context: {
          type: "string",
          description:
            "Brief guidance for the answerer. Used when next_state is answerer.",
        },
      },
      required: ["next_state", "response", "doc_paths", "context"],
      additionalProperties: false,
    },
  },
};

interface RouterDecision {
  next_state: "router" | "answerer";
  response: string;
  doc_paths: string[];
  context: string;
}

async function callRespan(
  promptId: string,
  variables: Record<string, unknown>,
  options: {
    model?: string;
    stream?: boolean;
    responseFormat?: unknown;
  } = {}
) {
  const body: Record<string, unknown> = {
    model: options.model || ROUTER_MODEL,
    messages: [],
    stream: options.stream ?? false,
    prompt: {
      prompt_id: promptId,
      override: true,
      variables,
    },
  };

  if (options.responseFormat) {
    body.response_format = options.responseFormat;
  }

  return fetch(`${RESPAN_BASE_URL}/api/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${RESPAN_API_KEY}`,
    },
    body: JSON.stringify(body),
  });
}

async function fetchDocContent(paths: string[]): Promise<string> {
  if (!DOCS_BASE_PATH) {
    return paths
      .map((p) => `[Documentation page: ${DOCS_BASE_URL}${p}]`)
      .join("\n\n");
  }

  const contents: string[] = [];
  for (const docPath of paths.slice(0, 5)) {
    try {
      const filePath = join(DOCS_BASE_PATH, `${docPath}.mdx`);
      const content = readFileSync(filePath, "utf-8");
      contents.push(`--- ${DOCS_BASE_URL}${docPath} ---\n${content}\n---`);
    } catch {
      // Skip files that don't exist
    }
  }
  return contents.join("\n\n") || "No documentation found for the given paths.";
}

/**
 * Parse Respan SSE stream and re-emit clean SSE to the client.
 */
function createCleanSSEStream(upstreamBody: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  return new ReadableStream({
    async start(controller) {
      const reader = upstreamBody.getReader();
      let buffer = "";

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
            return;
          }

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const data = line.slice(6).trim();
            if (data === "[DONE]") {
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
              return;
            }
            if (!data) continue;

            try {
              const parsed = JSON.parse(data);
              const content = parsed.choices?.[0]?.delta?.content;
              if (content) {
                const chunk = JSON.stringify({
                  choices: [{ delta: { content } }],
                });
                controller.enqueue(encoder.encode(`data: ${chunk}\n\n`));
              }
            } catch {
              // skip malformed
            }
          }
        }
      } catch (err) {
        controller.error(err);
      }
    },
  });
}

/**
 * Return a direct text response as an SSE stream (skips Prompt 2).
 */
function createDirectSSEResponse(text: string): Response {
  const encoder = new TextEncoder();
  const chunk = JSON.stringify({
    choices: [{ delta: { content: text } }],
  });
  const body = encoder.encode(`data: ${chunk}\n\ndata: [DONE]\n\n`);

  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(body);
        controller.close();
      },
    }),
    {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    }
  );
}

const MAX_ROUTER_ITERATIONS = 3;

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

    // Agent loop: Router decides next_state, fetches docs if needed, loops back
    let accumulatedDocs = "";
    let decision: RouterDecision = {
      next_state: "router",
      response: "",
      doc_paths: [],
      context: "",
    };

    for (let i = 0; i < MAX_ROUTER_ITERATIONS; i++) {
      const routerRes = await callRespan(
        ROUTER_PROMPT_ID,
        {
          docs_index: {
            _type: "prompt",
            prompt_id: INDEX_PROMPT_ID,
          },
          user_question: userQuestion,
          accumulated_context: accumulatedDocs
            ? `Previously fetched documentation:\n${accumulatedDocs}`
            : "",
        },
        { model: ROUTER_MODEL, responseFormat: ROUTER_SCHEMA }
      );

      if (!routerRes.ok) {
        const errText = await routerRes.text();
        console.error(`Router error (iteration ${i + 1}):`, routerRes.status, errText);
        return NextResponse.json(
          { error: "Failed to route question" },
          { status: 500 }
        );
      }

      const routerData = await routerRes.json();
      const routerContent =
        routerData.choices?.[0]?.message?.content || "{}";

      try {
        decision = JSON.parse(routerContent);
      } catch {
        console.error("Failed to parse router JSON:", routerContent);
        decision = { next_state: "router", response: "Sorry, something went wrong.", doc_paths: [], context: "" };
      }

      console.log(
        `Router iteration ${i + 1}:`,
        decision.next_state,
        decision.doc_paths
      );

      if (decision.next_state === "answerer") {
        // Fetch docs and loop back to router
        const docsContent = await fetchDocContent(decision.doc_paths);
        accumulatedDocs += (accumulatedDocs ? "\n\n" : "") + docsContent;
        continue;
      }

      // "router" — it handled it directly, break out
      break;
    }

    // Router responded directly → return response as SSE
    if (decision.next_state === "router" && decision.response) {
      return createDirectSSEResponse(decision.response);
    }

    // Answerer path (hit max iterations or router decided answerer with docs)
    // → use Prompt 2 with accumulated docs
    const answererRes = await callRespan(
      ANSWERER_PROMPT_ID,
      {
        docs_content: accumulatedDocs,
        user_question: userQuestion,
        context: decision.context,
      },
      { model: ANSWERER_MODEL, stream: true }
    );

    if (!answererRes.ok) {
      const errText = await answererRes.text();
      console.error("Answerer error:", answererRes.status, errText);
      return NextResponse.json(
        { error: "Failed to get answer" },
        { status: 500 }
      );
    }

    const cleanStream = createCleanSSEStream(answererRes.body!);

    return new Response(cleanStream, {
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
