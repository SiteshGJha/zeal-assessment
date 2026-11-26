import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { parseFaultInjectHeader } from '../common/request-context.js';

/**
 * Resolves {{NOW_MINUS_XXH}} and {{NOW_PLUS_XXD}} relative-date tokens in fixture text.
 */
export function resolveFixturePlaceholders(content: string, now = new Date()): string {
  return content
    .replace(/\{\{NOW_MINUS_(\d+)H\}\}/g, (_, hoursStr: string) => {
      const hours = Number.parseInt(hoursStr, 10);
      return new Date(now.getTime() - hours * 3600 * 1000).toISOString();
    })
    .replace(/\{\{NOW_PLUS_(\d+)D\}\}/g, (_, daysStr: string) => {
      const days = Number.parseInt(daysStr, 10);
      return new Date(now.getTime() + days * 86400 * 1000).toISOString().slice(0, 10);
    });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveFn) => setTimeout(resolveFn, ms));
}

/**
 * Internal 127.0.0.1 loopback HTTP stub serving Salesforce JSON and NetSuite CSV/XML fixtures
 * with deterministic fault-injection support.
 */
@Injectable()
export class MockUpstreamServer implements OnModuleInit, OnModuleDestroy {
  private server: Server | null = null;
  private boundPort = 0;

  private readonly fixturesDir = resolve(process.cwd(), 'fixtures');

  async onModuleInit(): Promise<void> {
    if (!this.server) {
      const requestedPort = Number.parseInt(process.env.MOCK_UPSTREAM_PORT ?? '3001', 10);
      await this.start(Number.isFinite(requestedPort) ? requestedPort : 3001);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  getPort(): number {
    return this.boundPort;
  }

  async start(port = 3001): Promise<number> {
    if (this.server) {
      return this.boundPort;
    }

    const server = createServer((req, res) => {
      void this.handleRequest(req, res);
    });

    await new Promise<void>((resolveStart, rejectStart) => {
      server.once('error', rejectStart);
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', rejectStart);
        resolveStart();
      });
    });

    const address = server.address();
    this.boundPort = typeof address === 'object' && address ? address.port : port;
    this.server = server;
    return this.boundPort;
  }

  async stop(): Promise<void> {
    const active = this.server;
    if (!active) {
      return;
    }
    this.server = null;
    this.boundPort = 0;
    await new Promise<void>((resolveStop, rejectStop) => {
      active.close((err) => {
        if (err) rejectStop(err);
        else resolveStop();
      });
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const urlPath = (req.url ?? '/').split('?')[0];
    const faults = parseFaultInjectHeader(req.headers['x-fault-inject']);

    if (urlPath === '/mock/salesforce/cases') {
      if (await this.applyFaultIfPresent(faults.get('salesforce'), res)) return;
      const raw = readFileSync(resolve(this.fixturesDir, 'salesforce-cases.json'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(resolveFixturePlaceholders(raw));
      return;
    }

    if (urlPath === '/mock/netsuite/entitlements.csv') {
      if (await this.applyFaultIfPresent(faults.get('netsuite'), res)) return;
      const raw = readFileSync(resolve(this.fixturesDir, 'netsuite-entitlements.csv'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/csv' });
      res.end(resolveFixturePlaceholders(raw));
      return;
    }

    if (urlPath === '/mock/netsuite/entitlements.xml') {
      const directive = faults.get('netsuite-xml') ?? faults.get('netsuite');
      if (await this.applyFaultIfPresent(directive, res)) return;
      const raw = readFileSync(resolve(this.fixturesDir, 'netsuite-entitlements.xml'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      res.end(resolveFixturePlaceholders(raw));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
  }

  private async applyFaultIfPresent(
    directive: string | undefined,
    res: ServerResponse,
  ): Promise<boolean> {
    if (!directive) {
      return false;
    }
    if (directive === '503') {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Simulated upstream 503' }));
      return true;
    }
    if (directive === '429') {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Simulated upstream 429' }));
      return true;
    }
    if (directive === 'timeout') {
      await sleep(2500);
      if (!res.writableEnded) {
        res.writeHead(504, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Simulated timeout' }));
      }
      return true;
    }
    if (directive.startsWith('delay:')) {
      const delayMs = Number.parseInt(directive.slice('delay:'.length), 10);
      if (Number.isFinite(delayMs) && delayMs > 0) {
        await sleep(Math.min(delayMs, 10_000));
      }
      return false;
    }
    return false;
  }
}
