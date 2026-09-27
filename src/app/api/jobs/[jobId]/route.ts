import { NextResponse } from "next/server";
import {
  ArtifactGenerationJobNotReadyError,
  ArtifactIncompleteGenerationJobError,
  ArtifactJobNotFoundError,
  createArtifactStore,
} from "../../../../lib/artifact-store";

export const runtime = "nodejs";

type JobRouteContext = {
  params: Promise<{ jobId: string }>;
};

export async function GET(_request: Request, { params }: JobRouteContext) {
  const { jobId } = await params;
  try {
    const job = await createArtifactStore().readPublishedGenerationJob(jobId);
    return NextResponse.json(job, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    if (error instanceof ArtifactJobNotFoundError) return jobError("JOB_NOT_FOUND", 404);
    if (error instanceof ArtifactGenerationJobNotReadyError) return jobError("JOB_NOT_READY", 409);
    if (error instanceof ArtifactIncompleteGenerationJobError) return jobError("JOB_INCOMPLETE", 409);
    return jobError("JOB_NOT_FOUND", 404);
  }
}

function jobError(code: "JOB_NOT_FOUND" | "JOB_NOT_READY" | "JOB_INCOMPLETE", status: number) {
  const message = {
    JOB_NOT_FOUND: "Generation job was not found",
    JOB_NOT_READY: "Generation job is not ready",
    JOB_INCOMPLETE: "Generation job does not contain a complete published result",
  } as const;
  return NextResponse.json({ error: { code, message: message[code] } }, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}
