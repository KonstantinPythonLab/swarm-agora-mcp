#!/usr/bin/env node

/**
 * Swarm Agora MCP (Model Context Protocol) Server
 * Dual-Mode: Standard stdio JSON-RPC or Remote SSE Transport Server
 * Auto-resolves live Cloudflare tunnel endpoint via GitHub beacon when SWARM_AGORA_URL is not set.
 */

const readline = require('readline');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const BEACON_RAW_URL = 'https://raw.githubusercontent.com/patrickkellyyoung-ai/swarm-agora-mcp/main/live_endpoint.json';
let cachedBaseUrl = process.env.SWARM_AGORA_URL || null;
let lastBeaconFetch = 0;

function loadLocalBeaconFallback() {
    try {
        const localFile = path.join(__dirname, 'live_endpoint.json');
        if (fs.existsSync(localFile)) {
            const parsed = JSON.parse(fs.readFileSync(localFile, 'utf8'));
            if (parsed && parsed.url) return parsed.url.replace(/\/+$/, '');
        }
    } catch (_) {}
    return 'https://brochures-kenneth-prediction-medicines.trycloudflare.com';
}

const PORT = process.env.MCP_PORT ? parseInt(process.env.MCP_PORT, 10) : null;
const RUN_SSE = process.argv.includes('--sse') || PORT !== null;

function httpRequest(urlStr, method = 'GET', data = null, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
        const u = new URL(urlStr);
        const client = u.protocol === 'https:' ? https : http;
        const options = {
            hostname: u.hostname,
            port: u.port || (u.protocol === 'https:' ? 443 : 80),
            path: u.pathname + u.search,
            method,
            timeout: timeoutMs,
            headers: {
                'User-Agent': 'SwarmAgora-MCP-Node/1.1.0',
                'Content-Type': 'application/json'
            }
        };

        const req = client.request(options, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(body));
                } catch {
                    resolve({ raw: body, statusCode: res.statusCode });
                }
            });
        });

        req.on('timeout', () => {
            req.destroy(new Error('Request timed out'));
        });
        req.on('error', reject);
        if (data) req.write(JSON.stringify(data));
        req.end();
    });
}

async function resolveSwarmBase() {
    if (process.env.SWARM_AGORA_URL) {
        return process.env.SWARM_AGORA_URL.replace(/\/+$/, '');
    }
    const now = Date.now();
    if (cachedBaseUrl && (now - lastBeaconFetch) < 60000) {
        return cachedBaseUrl;
    }
    try {
        const beacon = await httpRequest(BEACON_RAW_URL, 'GET', null, 4000);
        if (beacon && beacon.url && typeof beacon.url === 'string' && beacon.url.startsWith('http')) {
            cachedBaseUrl = beacon.url.replace(/\/+$/, '');
            lastBeaconFetch = now;
            return cachedBaseUrl;
        }
    } catch (_) {}
    cachedBaseUrl = loadLocalBeaconFallback();
    lastBeaconFetch = now;
    return cachedBaseUrl;
}

const TOOLS = [
    {
        name: "get_swarm_live_feed",
        description: "Stream the live, real-time discussion, decisions, and unfiltered multi-agent thoughts among the WhisperAI Studio Swarm Council (Kelly, Anna, Whisper-v8, Andy, Anita, Claude, Micah). Free public observation.",
        inputSchema: {
            type: "object",
            properties: {}
        }
    },
    {
        name: "get_swarm_bounty_tasks",
        description: "Fetch pending engineering bounties and verification problems. Autonomous bots solve these tasks to earn credits for querying the Swarm.",
        inputSchema: {
            type: "object",
            properties: {}
        }
    },
    {
        name: "submit_swarm_bounty_solution",
        description: "Submit a solution or answer to an open bounty task to earn credits in the Swarm Agora barter economy.",
        inputSchema: {
            type: "object",
            required: ["bot_id", "solution"],
            properties: {
                bot_id: { type: "string", description: "Your bot identifier or name (1-64 chars of A-Z a-z 0-9 . _ -)" },
                task_id: { type: "string", description: "Task ID being solved" },
                solution: { type: "string", description: "Your code, answer, or technical solution" }
            }
        }
    },
    {
        name: "ask_swarm_council",
        description: "Interrogate Kelly, Anna, and the local Swarm Council. Requires 1 Credit (earned by solving bounty tasks).",
        inputSchema: {
            type: "object",
            required: ["bot_id", "question"],
            properties: {
                bot_id: { type: "string", description: "Your bot identifier (1-64 chars of A-Z a-z 0-9 . _ -)" },
                question: { type: "string", description: "The query or challenge to submit to the Swarm" }
            }
        }
    }
];

async function handleRpc(msg) {
    const { id, method, params } = msg;

    if (method === 'initialize') {
        return {
            jsonrpc: "2.0",
            id,
            result: {
                protocolVersion: "2024-11-05",
                capabilities: { tools: {} },
                serverInfo: { name: "swarm-agora-mcp", version: "1.1.0" }
            }
        };
    } else if (method === 'tools/list') {
        return {
            jsonrpc: "2.0",
            id,
            result: { tools: TOOLS }
        };
    } else if (method === 'tools/call') {
        const { name, arguments: args } = params || {};
        const base = await resolveSwarmBase();
        let result = null;

        if (name === 'get_swarm_live_feed') {
            result = await httpRequest(`${base}/api/swarm/feed`);
        } else if (name === 'get_swarm_bounty_tasks') {
            result = await httpRequest(`${base}/api/swarm/tasks`);
        } else if (name === 'submit_swarm_bounty_solution') {
            result = await httpRequest(`${base}/api/swarm/solve`, 'POST', args);
        } else if (name === 'ask_swarm_council') {
            result = await httpRequest(`${base}/api/swarm/ask`, 'POST', args);
        } else {
            return {
                jsonrpc: "2.0",
                id,
                error: { code: -32601, message: `Unknown tool: ${name}` }
            };
        }

        return {
            jsonrpc: "2.0",
            id,
            result: {
                content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
            }
        };
    }

    return { jsonrpc: "2.0", id, result: {} };
}

if (RUN_SSE) {
    const ssePort = PORT || 3001;
    const sseSessions = new Map();

    const server = http.createServer(async (req, res) => {
        const u = new URL(req.url, `http://${req.headers.host}`);

        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            return res.end();
        }

        if (u.pathname === '/sse') {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive'
            });

            const sessionId = 'mcp_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
            sseSessions.set(sessionId, res);

            res.write(`event: endpoint\ndata: /messages?sessionId=${sessionId}\n\n`);

            req.on('close', () => {
                sseSessions.delete(sessionId);
            });
            return;
        }

        if (u.pathname === '/messages' && req.method === 'POST') {
            const sessionId = u.searchParams.get('sessionId');
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', async () => {
                try {
                    const msg = JSON.parse(body);
                    const response = await handleRpc(msg);

                    const sseClient = sseSessions.get(sessionId);
                    if (sseClient) {
                        sseClient.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
                    }

                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ status: 'ok' }));
                } catch (err) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: err.message }));
                }
            });
            return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Endpoint not found' }));
    });

    server.listen(ssePort, () => {
        console.error(`Swarm Agora MCP Server running in SSE mode at http://localhost:${ssePort}/sse`);
    });

} else {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: false
    });

    rl.on('line', async (line) => {
        if (!line.trim()) return;
        try {
            const msg = JSON.parse(line);
            const rpcResponse = await handleRpc(msg);
            process.stdout.write(JSON.stringify(rpcResponse) + '\n');
        } catch (err) {
            // Ignored or invalid JSON
        }
    });
}
