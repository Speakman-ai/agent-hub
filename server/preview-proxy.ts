/**
 * preview-proxy.ts — Reverse proxy middleware for PR preview containers.
 *
 * Routes incoming HTTP requests and WebSocket upgrades to the correct
 * preview container based on subdomain matching:
 *
 *   preview-pr-243.example.com → container on port 4xxx
 *
 * Subdomain format: preview-pr-{number}
 *
 * Uses Node's built-in http module for proxying (no external dependency).
 */

import { createProxyServer } from './proxy-server.js';
import type { Request, Response, NextFunction } from 'express';
import type { IncomingMessage, ServerResponse } from 'http';
import type { Socket } from 'net';
import type { Stmts, PreviewContainerRow } from './types.js';

/** Regex to extract PR number from subdomain: preview-pr-123.example.com */
const PREVIEW_SUBDOMAIN_RE = /^preview-pr-(\d+)\./i;

export interface PreviewProxyDeps {
  stmts: Stmts;
  previewDomain: string; // e.g., "example.com" — the base domain for preview subdomains
}

/**
 * Extract PR number from the Host header using the preview subdomain pattern.
 * Returns null if the host doesn't match the preview subdomain format.
 */
export function extractPrNumber(host: string | undefined): number | null {
  if (!host) return null;
  const match = PREVIEW_SUBDOMAIN_RE.exec(host);
  if (!match) return null;
  const pr = parseInt(match[1], 10);
  return Number.isNaN(pr) ? null : pr;
}

/**
 * Look up a running preview container by PR number.
 * Returns the container row if found and running, null otherwise.
 */
export function findRunningPreview(stmts: Stmts, prNumber: number): PreviewContainerRow | null {
  // getRunningPreviewByPrNumber returns the first running container matching this PR
  const row = stmts.getRunningPreviewByPrNumber.get(prNumber) as PreviewContainerRow | undefined;
  return row ?? null;
}

/**
 * Build the target URL for a preview container (http://localhost:{port}).
 */
function buildTarget(preview: PreviewContainerRow): string {
  return `http://127.0.0.1:${preview.port}`;
}

/**
 * Create Express middleware that proxies requests matching preview subdomains
 * to the correct preview container. Non-matching requests pass through.
 */
export function createPreviewProxyMiddleware(deps: PreviewProxyDeps) {
  const { stmts, previewDomain } = deps;
  const proxy = createProxyServer();

  return function previewProxyMiddleware(req: Request, res: Response, next: NextFunction): void {
    const host = req.headers.host;

    // Only intercept if the host matches the preview domain
    if (!host || !host.endsWith(`.${previewDomain}`)) {
      return next();
    }

    const prNumber = extractPrNumber(host);
    if (prNumber === null) {
      return next();
    }

    const preview = findRunningPreview(stmts, prNumber);
    if (!preview || !preview.port) {
      res.status(502).json({
        error: `Preview for PR #${prNumber} is not running`,
        status: preview?.status ?? 'not_found',
      });
      return;
    }

    const target = buildTarget(preview);

    proxy.web(req, res, target, (err) => {
      console.error(`[Preview Proxy] Error proxying PR #${prNumber}:`, err.message);
      if (!res.headersSent) {
        res.status(502).json({
          error: `Preview container for PR #${prNumber} is unreachable`,
        });
      }
    });
  };
}

/**
 * Create a WebSocket upgrade handler for preview subdomains.
 * Attach to the HTTP server's 'upgrade' event.
 */
export function createPreviewWsUpgradeHandler(deps: PreviewProxyDeps) {
  const { stmts, previewDomain } = deps;
  const proxy = createProxyServer();

  return function handlePreviewUpgrade(
    req: IncomingMessage,
    socket: Socket,
    head: Buffer,
  ): boolean {
    const host = req.headers.host;

    // Only handle if the host matches the preview domain
    if (!host || !host.endsWith(`.${previewDomain}`)) {
      return false; // Not handled — let the main WS server handle it
    }

    const prNumber = extractPrNumber(host);
    if (prNumber === null) {
      return false;
    }

    const preview = findRunningPreview(stmts, prNumber);
    if (!preview || !preview.port) {
      socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      socket.destroy();
      return true; // Handled (with error)
    }

    const target = buildTarget(preview);

    proxy.ws(req, socket, head, target, (err) => {
      console.error(`[Preview Proxy WS] Error proxying PR #${prNumber}:`, err.message);
      socket.destroy();
    });

    return true; // Handled
  };
}

/**
 * Generate the preview URL for a given PR number.
 * Uses subdomain format when previewDomain is configured, falls back to port-based URL.
 */
export function buildPreviewUrl(
  prNumber: number,
  port: number,
  previewDomain: string | null,
): string {
  if (previewDomain) {
    // Use HTTPS for production subdomains (assuming TLS termination at Nginx)
    return `https://preview-pr-${prNumber}.${previewDomain}`;
  }
  // Fallback: direct port access
  return `http://localhost:${port}`;
}
