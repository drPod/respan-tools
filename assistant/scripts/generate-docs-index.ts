#!/usr/bin/env npx tsx
/**
 * Generates docs-index.txt from MDX front matter (title + description).
 *
 * Usage:
 *   npx tsx scripts/generate-docs-index.ts [docs-path]
 *
 * Defaults to DOCS_PATH env var or ../docs relative to repo root.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { join, relative, dirname } from "path";

const DOCS_PATH =
  process.argv[2] ||
  process.env.DOCS_PATH ||
  join(dirname(new URL(import.meta.url).pathname), "../../docs");

const OUTPUT_PATH = join(
  dirname(new URL(import.meta.url).pathname),
  "../src/data/docs-index.txt"
);

// Directories to skip
const SKIP_DIRS = new Set([".git", "node_modules", "images", "snippets", ".github", "fonts"]);

interface DocEntry {
  path: string; // URL path without .mdx
  title: string;
  description: string;
}

function extractFrontMatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};

  const fields: Record<string, string> = {};
  const lines = match[1].split("\n");

  for (const line of lines) {
    // Match key: "value" or key: 'value' or key: value
    const m = line.match(/^(\w[\w.:/-]*)\s*:\s*['"]?(.*?)['"]?\s*$/);
    if (m) {
      fields[m[1]] = m[2];
    }
  }

  return fields;
}

function walkDir(dir: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      files.push(...walkDir(fullPath));
    } else if (entry.endsWith(".mdx") || entry.endsWith(".md")) {
      files.push(fullPath);
    }
  }

  return files;
}

function buildIndex(): DocEntry[] {
  const files = walkDir(DOCS_PATH);
  const entries: DocEntry[] = [];

  for (const file of files) {
    const content = readFileSync(file, "utf-8");
    const fm = extractFrontMatter(content);

    const relPath = relative(DOCS_PATH, file).replace(/\.mdx?$/, "");
    const urlPath = "/" + relPath;

    const title = fm.title || fm.sidebarTitle || relPath.split("/").pop() || "";
    const description =
      fm.description ||
      fm["og:description"] ||
      fm["twitter:description"] ||
      "";

    entries.push({ path: urlPath, title, description });
  }

  // Sort by path for consistent output
  entries.sort((a, b) => a.path.localeCompare(b.path));

  return entries;
}

function groupBySection(entries: DocEntry[]): Map<string, DocEntry[]> {
  const groups = new Map<string, DocEntry[]>();

  for (const entry of entries) {
    // Group by first 2-3 path segments
    const parts = entry.path.split("/").filter(Boolean);
    let section: string;

    if (parts.length <= 2) {
      section = parts[0] || "root";
    } else {
      // Use first 2 segments, or 3 if the second is a common parent
      section = parts.slice(0, Math.min(parts.length - 1, 3)).join(" > ");
    }

    // Capitalize and clean up section name
    section = section
      .split(" > ")
      .map((s) =>
        s
          .replace(/-/g, " ")
          .replace(/\b\w/g, (c) => c.toUpperCase())
      )
      .join(" > ");

    if (!groups.has(section)) {
      groups.set(section, []);
    }
    groups.get(section)!.push(entry);
  }

  return groups;
}

function formatIndex(groups: Map<string, DocEntry[]>): string {
  const lines: string[] = [
    "# Respan Documentation Index",
    `# Auto-generated from docs front matter`,
    "",
  ];

  for (const [section, entries] of groups) {
    lines.push(`## ${section}`);
    for (const entry of entries) {
      const desc = entry.description
        ? `${entry.title} — ${entry.description}`
        : entry.title;
      lines.push(`- ${entry.path} — ${desc}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// Main
const entries = buildIndex();
const groups = groupBySection(entries);
const output = formatIndex(groups);

writeFileSync(OUTPUT_PATH, output, "utf-8");

console.log(`Generated docs index: ${entries.length} pages`);
console.log(`Output: ${OUTPUT_PATH}`);
