# DEP-06: job data operations

The application writes each job below `VK_HACKATHON_ARTIFACT_ROOT` (default:
`.data/vk-tech-hackathon/jobs`). Keep this directory on a persistent volume
outside the image. A job directory holds its input files, manifest, generated
variants, audits and exports. These files may contain private user material.

## Retention decision

No production retention period has been approved. **Do not schedule `--apply` on
real user data until the owner chooses a TTL, backup period and deletion policy.**
The `--older-than-days` argument is explicit on every run. The cleanup tool
defaults to dry-run. It considers only UUID-named `job-*` directories with a
valid, matching manifest whose status is `ready` or `failed` and whose
`updatedAt` is older than the cutoff. `analyzing`, recent, malformed, unknown
and symlinked entries are skipped. Failed jobs may contain useful diagnostics;
the chosen TTL must account for that.

## Inspect and clean

Run these commands from the package checkout on a machine where Node, the
project dependencies and `tsx` are installed and the artifact volume is
mounted at a known absolute path. The following path is an example; confirm
the actual mount before running anything:

```bash
ARTIFACT_ROOT=/srv/vk-hackathon/artifacts
df -h "$ARTIFACT_ROOT"
du -sh "$ARTIFACT_ROOT"
npx tsx scripts/prune-jobs.ts --root "$ARTIFACT_ROOT" --older-than-days 30
```

Review the JSON `candidates` and `skipped` lists. For an approved production
retention period, take and verify a backup first, stop **all** app instances
that can write this volume, then run the same command with `--apply --stopped`.
The flag is an operator assertion; the tool cannot detect a remote writer.
Keep the application stopped until cleanup ends. Recheck disk space and start
the app. Never point this command at the repository, `/`, a parent containing
other services, or a symlink. The tool refuses relative and symlinked roots.

```bash
npx tsx scripts/prune-jobs.ts --root "$ARTIFACT_ROOT" --older-than-days 30 --apply --stopped
df -h "$ARTIFACT_ROOT"
```

Until the owner approves a real TTL, use only dry-run on production and use
`--apply` only on disposable test directories. A dry-run and an apply run each
re-evaluate manifests; review the new candidate list. Deletion is permanent
and is not a substitute for a backup.

## Backup and restore

1. Record the image digest, application version, volume identity and backup
   destination. Restrict backup access because inputs and outputs are private.
2. Stop every app instance writing the volume. Confirm no job is running.
3. Copy the entire artifact root, including `manifest.json` and all nested
   files, to a separate persistent location. Preserve file permissions and
   verify archive integrity and file count. Do not keep the only backup on the
   same disk.
4. Start the app against the original volume and check `/api/ready`. Perform
   a read-only reopen of a known published job and fetch one published
   artifact. Record the job ID and expected SHA-256 before the backup.
5. To restore, stop every writer, restore the full directory into a new empty
   volume, set ownership for the non-root runtime user, and point only one app
   instance at it. Start the app, check `/api/ready`, reopen the same job and
   compare the artifact SHA-256. Roll back to the untouched old volume if this
   check fails.

The focused test `tests/prune-jobs.test.ts` copies a temporary volume, opens a
published manifest through a new `ArtifactStore` and reads an artifact after
restore. Production restart/restore, permission and mounted-volume behavior
must still be verified in DEP-07 with the final image.

## Restart and disk monitoring

Monitor free bytes and inode use on the actual mounted volume (`df -h` and
`df -i` on Linux); alert before it fills. Also record total job bytes (`du -sh`)
and the growth rate. A writable readiness response alone does not prove enough
free capacity for a new PPTX render. Keep a tested backup and reserve space
for upload, LibreOffice temp files and three exports. After any app restart,
check `/api/ready` and reopen one known published job before accepting traffic.

This procedure applies to the single-instance, local-filesystem demo. Multiple
replicas require shared storage and coordinated job state before they may write
the same artifact root.
