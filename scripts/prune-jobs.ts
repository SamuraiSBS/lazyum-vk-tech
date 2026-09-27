import { readdir, readFile, lstat, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { artifactManifestSchema } from "../src/lib/schemas";

const JOB_ID = /^job-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PruneResult = {
  candidates: string[];
  deleted: string[];
  skipped: { name: string; reason: string }[];
};

export async function pruneJobs(options: {
  root: string;
  olderThanDays: number;
  apply?: boolean;
  stopped?: boolean;
  now?: Date;
}): Promise<PruneResult> {
  if (!path.isAbsolute(options.root)) throw new Error("Artifact root must be an absolute path");
  if (!Number.isSafeInteger(options.olderThanDays) || options.olderThanDays < 1) {
    throw new Error("Retention must be a positive whole number of days");
  }
  if (options.apply && !options.stopped) throw new Error("Stop the application before applying cleanup");

  const root = path.resolve(options.root);
  if (root === path.parse(root).root) throw new Error("Filesystem root cannot be an artifact root");
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || await realpath(root) !== root) {
    throw new Error("Artifact root must be a real directory, not a symlink");
  }
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid current time");
  const cutoff = now.getTime() - options.olderThanDays * 86_400_000;
  const result: PruneResult = { candidates: [], deleted: [], skipped: [] };

  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!JOB_ID.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) {
      result.skipped.push({ name: entry.name, reason: "not a regular job directory" });
      continue;
    }
    const directory = path.join(root, entry.name);
    const manifestPath = path.join(directory, "manifest.json");
    let eligible = false;
    try {
      const directoryStat = await lstat(directory);
      const manifestStat = await lstat(manifestPath);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()
        || !manifestStat.isFile() || manifestStat.isSymbolicLink()
        || await realpath(directory) !== directory) {
        throw new Error("job directory or manifest is not a regular file");
      }
      const original = await readFile(manifestPath, "utf8");
      const manifest = artifactManifestSchema.parse(JSON.parse(original));
      const createdAt = Date.parse(manifest.createdAt);
      const updatedAt = Date.parse(manifest.updatedAt);
      if (manifest.jobId !== entry.name) throw new Error("manifest job ID does not match directory");
      if (manifest.status === "analyzing") throw new Error("active job");
      if (createdAt > updatedAt || createdAt > cutoff || updatedAt > cutoff) {
        throw new Error("job is inside retention window or has inconsistent timestamps");
      }
      result.candidates.push(entry.name);
      eligible = true;

      if (options.apply) {
        // The service must be stopped. This recheck also catches accidental edits
        // between enumeration and deletion; it is not a cross-process lock.
        const latestStat = await lstat(directory);
        if (latestStat.ino !== directoryStat.ino || latestStat.dev !== directoryStat.dev
          || await readFile(manifestPath, "utf8") !== original) {
          throw new Error("job changed during cleanup");
        }
        await rm(directory, { recursive: true });
        result.deleted.push(entry.name);
      }
    } catch (error) {
      result.candidates = result.candidates.filter((name) => name !== entry.name);
      result.skipped.push({ name: entry.name, reason: error instanceof Error ? error.message : String(error) });
      if (options.apply && eligible) throw error;
    }
  }
  return result;
}

function parseArgs(args: string[]) {
  let root: string | undefined;
  let olderThanDays: number | undefined;
  let apply = false;
  let stopped = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--root") root = args[++i];
    else if (arg === "--older-than-days") olderThanDays = Number(args[++i]);
    else if (arg === "--apply") apply = true;
    else if (arg === "--stopped") stopped = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!root || olderThanDays === undefined) {
    throw new Error("Usage: tsx scripts/prune-jobs.ts --root ABSOLUTE_PATH --older-than-days N [--apply --stopped]");
  }
  return { root, olderThanDays, apply, stopped };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  pruneJobs(parseArgs(process.argv.slice(2)))
    .then((result) => { process.stdout.write(JSON.stringify(result, null, 2) + "\n"); })
    .catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : error}\n`); process.exitCode = 1; });
}
