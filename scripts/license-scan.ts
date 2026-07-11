import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const ALLOWED = new Set(["MIT", "Apache-2.0", "ISC", "BSD-2-Clause", "BSD-3-Clause", "0BSD", "CC0-1.0"]);

function isAllowed(license: string): boolean {
  const normalized = license.trim().replace(/^\(|\)$/g, "");
  return normalized
    .split(/\s+OR\s+/i)
    .map((part) => part.trim())
    .some((part) => ALLOWED.has(part));
}

async function listPackageDirs(root: string): Promise<string[]> {
  const dirs: string[] = [];
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return dirs;
  }
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    if (entry.startsWith("@")) {
      for (const scoped of await readdir(join(root, entry)).catch(() => [] as string[])) {
        dirs.push(join(entry, scoped));
      }
    } else {
      dirs.push(entry);
    }
  }
  return dirs;
}

interface Violation {
  name: string;
  license: string;
}

export async function scanLicenses(root: string): Promise<Violation[]> {
  const violations: Violation[] = [];
  for (const dir of await listPackageDirs(join(root, "node_modules"))) {
    const manifestPath = join(root, "node_modules", dir, "package.json");
    let manifest: { name?: string; license?: string; licenses?: { type: string }[] };
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch {
      continue;
    }
    const license = manifest.license ?? manifest.licenses?.[0]?.type;
    if (!license || !isAllowed(license)) {
      violations.push({ name: manifest.name ?? dir, license: license ?? "UNKNOWN" });
    }
  }
  return violations;
}

if (import.meta.main) {
  const violations = await scanLicenses(process.cwd());
  if (violations.length > 0) {
    console.error("Disallowed or missing licenses:");
    for (const violation of violations) console.error(`  ${violation.name}: ${violation.license}`);
    process.exit(1);
  }
  console.log("All dependency licenses are allowlisted.");
}
