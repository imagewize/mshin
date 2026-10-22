import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "./call.js";

describe("mshin-call argument parsing", () => {
    const envUrl = process.env.MSHIN_NODE_URL;
    const envToken = process.env.MSHIN_NODE_TOKEN;

    it("uses defaults and positional tool + args", () => {
        delete process.env.MSHIN_NODE_URL;
        delete process.env.MSHIN_NODE_TOKEN;
        const result = parseArgs(["node", "call.js", "nmap", '{"target":"127.0.0.1"}']);
        assert.equal(result.nodeUrl, "http://192.168.1.100:3000");
        assert.equal(result.token, "");
        assert.equal(result.list, false);
        assert.equal(result.help, false);
        assert.deepEqual(result.positional, ["nmap", '{"target":"127.0.0.1"}']);
    });

    it("honours --node, --token, and --list", () => {
        delete process.env.MSHIN_NODE_URL;
        delete process.env.MSHIN_NODE_TOKEN;
        const result = parseArgs([
            "node", "call.js",
            "--node", "http://127.0.0.1:3001",
            "--token", "secret",
            "--list",
        ]);
        assert.equal(result.nodeUrl, "http://127.0.0.1:3001");
        assert.equal(result.token, "secret");
        assert.equal(result.list, true);
        assert.deepEqual(result.positional, []);
    });

    it("reads defaults from environment", () => {
        process.env.MSHIN_NODE_URL = "http://env.example:3000";
        process.env.MSHIN_NODE_TOKEN = "env-token";
        const result = parseArgs(["node", "call.js", "whois", '{"target":"example.com"}']);
        assert.equal(result.nodeUrl, "http://env.example:3000");
        assert.equal(result.token, "env-token");
        // Restore
        if (envUrl === undefined) delete process.env.MSHIN_NODE_URL;
        else process.env.MSHIN_NODE_URL = envUrl;
        if (envToken === undefined) delete process.env.MSHIN_NODE_TOKEN;
        else process.env.MSHIN_NODE_TOKEN = envToken;
    });
});
