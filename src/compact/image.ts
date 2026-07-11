import { createCanvas } from "@napi-rs/canvas";

import { countTextTokens } from "../tokenizer.ts";
import type { VisionConfig } from "../types.ts";

export interface RenderedPage {
  dataUrl: string;
  width: number;
  height: number;
  sourceLines: number;
}

function wrapLine(line: string, columns: number): string[] {
  if (line.length <= columns) return [line];
  const rows: string[] = [];
  for (let offset = 0; offset < line.length; offset += columns) rows.push(line.slice(offset, offset + columns));
  return rows;
}

function visualRows(text: string, columns: number): string[] {
  return text.split(/\r?\n/).flatMap((line) => wrapLine(line.replace(/\t/g, "    "), columns));
}

export function modelAllowsVision(model: string, config: VisionConfig): boolean {
  const normalized = model.toLowerCase();
  return config.models.some((allowed) => normalized === allowed.toLowerCase() || normalized.startsWith(`${allowed.toLowerCase()}-`));
}

export function visionIsProfitable(text: string, pageCount: number, config: VisionConfig): boolean {
  const textTokens = countTextTokens(text);
  const visionTokens = pageCount * config.estimatedTokensPerPage;
  return textTokens / Math.max(visionTokens, 1) >= config.minimumSavingsRatio;
}

export function renderTextPages(text: string, maximumPages: number): RenderedPage[] {
  const width = 1600;
  const height = 1600;
  const padding = 48;
  const fontSize = 17;
  const lineHeight = 22;
  const columns = 142;
  const rowsPerPage = Math.floor((height - padding * 2 - 48) / lineHeight);
  const rows = visualRows(text, columns);
  const pages: RenderedPage[] = [];
  for (let pageIndex = 0; pageIndex < Math.min(maximumPages, Math.ceil(rows.length / rowsPerPage)); pageIndex += 1) {
    const pageRows = rows.slice(pageIndex * rowsPerPage, (pageIndex + 1) * rowsPerPage);
    const canvas = createCanvas(width, height);
    const context = canvas.getContext("2d");
    context.fillStyle = "#f8fafc";
    context.fillRect(0, 0, width, height);
    context.fillStyle = "#0f172a";
    context.font = `600 18px monospace`;
    context.fillText(`TokenSkein page ${pageIndex + 1}`, padding, padding);
    context.font = `${fontSize}px monospace`;
    for (let rowIndex = 0; rowIndex < pageRows.length; rowIndex += 1) {
      context.fillText(pageRows[rowIndex] ?? "", padding, padding + 48 + rowIndex * lineHeight);
    }
    pages.push({
      dataUrl: `data:image/png;base64,${canvas.toBuffer("image/png").toString("base64")}`,
      width,
      height,
      sourceLines: pageRows.length,
    });
  }
  return pages;
}
