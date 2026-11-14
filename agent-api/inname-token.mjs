import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";

export function pcVoorToken(header, inname) {
    const match = /^Bearer\s+(.+)$/i.exec(header || "");
    if (!match) return null;
    const hash = createHash("sha256").update(match[1].trim()).digest();
    for (const [pc, saved] of Object.entries(inname?.pcs ?? {})) {
        if (/^[a-z0-9-]{1,32}$/.test(pc) && typeof saved === "string" && /^[a-f0-9]{64}$/i.test(saved)
            && timingSafeEqual(hash, Buffer.from(saved, "hex"))) return pc;
    }
    return null;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
    try {
        const pc = process.argv[2];
        if (process.argv.length !== 3 || !/^[a-z0-9-]{1,32}$/.test(pc || "")) throw new Error();
        const configPath = process.env.USAGE_API_CONFIG || path.join(os.homedir(), ".config", "usage-api", "config.json");
        let config = {};
        try { config = JSON.parse(fs.readFileSync(configPath, "utf8")); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
        const file = path.resolve(path.dirname(configPath), config.inname_bestand || "inname.json");
        let inname = { pcs: {} };
        try { inname = JSON.parse(fs.readFileSync(file, "utf8")); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
        if (!inname.pcs || typeof inname.pcs !== "object" || Array.isArray(inname.pcs)) throw new Error();
        const token = randomBytes(32).toString("hex");
        inname.pcs[pc] = createHash("sha256").update(token).digest("hex");
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        fs.writeFileSync(file, JSON.stringify(inname) + "\n", { mode: 0o600 });
        fs.chmodSync(file, 0o600);
        process.stdout.write(token + "\n");
    } catch {
        // Never echo arguments, credentials or filesystem errors.
        process.stderr.write("inname-token: gebruik een pc-naam [a-z0-9-]{1,32} en een schrijfbare configuratie\n");
        process.exitCode = 1;
    }
}
